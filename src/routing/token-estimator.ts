import {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  ImageBlock,
} from '../canonical/canonical.types';

export interface TokenEstimate {
  input_tokens: number;
  output_tokens: number;
  context_tokens: number;
}

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_OVERHEAD_TOKENS = 16;
const DEFAULT_OUTPUT_RESERVE_TOKENS = 1024;
const IMAGE_REFERENCE_TOKENS = 512;
// Providers bill images by pixel size, not by encoded bytes: counting base64
// characters as text inflated a typical screenshot about a hundredfold and
// rejected requests that fit. Area/750 approximates published per-image costs;
// the cap bounds images that providers downscale before tokenizing.
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_MAX_TOKENS = 6000;
const imageTokenCache = new WeakMap<ImageBlock, number>();

export function estimateCanonicalRequestTokens(
  canonical: CanonicalRequest,
): TokenEstimate {
  const inputTokens =
    canonical.messages.reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      0,
    ) + estimateToolsTokens(canonical.tools);
  const outputTokens = Math.max(
    0,
    canonical.max_tokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS,
  );

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    context_tokens: inputTokens + outputTokens,
  };
}

function estimateMessageTokens(message: CanonicalMessage): number {
  const roleTokens = estimateTextTokens(message.role);
  const contentTokens =
    typeof message.content === 'string'
      ? estimateTextTokens(message.content)
      : message.content.reduce(
          (sum, block) => sum + estimateBlockTokens(block),
          0,
        );
  return MESSAGE_OVERHEAD_TOKENS + roleTokens + contentTokens;
}

function estimateBlockTokens(block: CanonicalContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'image':
      if (
        block.source.type === 'base64' ||
        block.source.data.startsWith('data:')
      ) {
        return estimateInlineImageTokens(block);
      }
      return IMAGE_REFERENCE_TOKENS + estimateTextTokens(block.source.data);
    case 'tool_use':
      return (
        TOOL_OVERHEAD_TOKENS +
        estimateTextTokens(block.name) +
        estimateTextTokens(JSON.stringify(block.input || {}))
      );
    case 'tool_result':
      return (
        TOOL_OVERHEAD_TOKENS +
        estimateTextTokens(block.tool_use_id) +
        (typeof block.content === 'string'
          ? estimateTextTokens(block.content)
          : block.content.reduce(
              (sum, nestedBlock) => sum + estimateBlockTokens(nestedBlock),
              0,
            ))
      );
    default:
      return 0;
  }
}

function estimateToolsTokens(tools: CanonicalTool[] | undefined): number {
  if (!tools || tools.length === 0) return 0;
  return tools.reduce(
    (sum, tool) =>
      sum +
      TOOL_OVERHEAD_TOKENS +
      estimateTextTokens(tool.name) +
      estimateTextTokens(tool.description) +
      estimateTextTokens(JSON.stringify(tool.parameters || {})),
    0,
  );
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateInlineImageTokens(block: ImageBlock): number {
  const cached = imageTokenCache.get(block);
  if (cached !== undefined) return cached;
  const size = base64ImageSize(block.source.data);
  const tokens = size
    ? Math.min(
        IMAGE_MAX_TOKENS,
        Math.max(
          IMAGE_REFERENCE_TOKENS,
          Math.ceil((size.width * size.height) / IMAGE_PIXELS_PER_TOKEN),
        ),
      )
    : IMAGE_MAX_TOKENS;
  imageTokenCache.set(block, tokens);
  return tokens;
}

interface ImageSize {
  width: number;
  height: number;
}

// Only the header is decoded: PNG/GIF/WebP sizes sit in the first bytes, and a
// JPEG frame header follows its metadata segments, normally within a few
// hundred kilobytes.
function base64ImageSize(data: string): ImageSize | null {
  const payload = data.startsWith('data:')
    ? data.slice(data.indexOf(',') + 1)
    : data;
  for (const chars of [4096, 524288]) {
    const slice = payload.slice(0, Math.min(payload.length, chars));
    const size = imageSizeFromBytes(
      Buffer.from(slice.slice(0, slice.length - (slice.length % 4)), 'base64'),
    );
    if (size || slice.length === payload.length) return size;
  }
  return null;
}

function imageSizeFromBytes(bytes: Buffer): ImageSize | null {
  if (
    bytes.length >= 24 &&
    bytes.readUInt32BE(0) === 0x89504e47 &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8 ') {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      const marker = bytes[offset + 1];
      if (bytes[offset] !== 0xff || marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  return null;
}
