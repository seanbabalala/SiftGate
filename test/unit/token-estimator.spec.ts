import {
  CanonicalContentBlock,
  CanonicalRequest,
} from '../../src/canonical/canonical.types';
import { estimateCanonicalRequestTokens } from '../../src/routing/token-estimator';

function request(content: CanonicalContentBlock[], maxTokens = 0): CanonicalRequest {
  return {
    messages: [{ role: 'user', content }],
    stream: false,
    max_tokens: maxTokens,
    metadata: { source_format: 'responses', raw_headers: {} },
  };
}

function image(bytes: Buffer, type: 'base64' | 'url' = 'base64'): CanonicalContentBlock {
  const data = bytes.toString('base64');
  return {
    type: 'image',
    source: {
      type,
      media_type: 'image/png',
      data: type === 'url' ? `data:image/png;base64,${data}` : data,
    },
  };
}

function imageTokens(block: CanonicalContentBlock): number {
  return (
    estimateCanonicalRequestTokens(request([block])).input_tokens -
    estimateCanonicalRequestTokens(request([])).input_tokens
  );
}

function png(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, Buffer.alloc(padding, 0x7f)]);
}

function jpeg(width: number, height: number, metadataBytes: number): Buffer {
  const app1 = Buffer.alloc(4 + metadataBytes);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(metadataBytes + 2, 2);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof, Buffer.alloc(64)]);
}

describe('token estimator images', () => {
  it('estimates a large PNG screenshot from its pixel size, not its encoded length', () => {
    const block = image(png(1600, 1000, 600_000));
    expect(imageTokens(block)).toBe(Math.ceil((1600 * 1000) / 750));
    expect(imageTokens(block)).toBeLessThan(800_000 / 4 / 50);
  });

  it('reads a JPEG frame header that follows a large metadata segment', () => {
    expect(imageTokens(image(jpeg(1200, 900, 60_000)))).toBe(Math.ceil((1200 * 900) / 750));
  });

  it('reads GIF and WebP sizes', () => {
    const gif = Buffer.alloc(16);
    gif.write('GIF89a', 0, 'ascii');
    gif.writeUInt16LE(1280, 6);
    gif.writeUInt16LE(960, 8);
    expect(imageTokens(image(gif))).toBe(Math.ceil((1280 * 960) / 750));

    const webp = Buffer.alloc(32);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBPVP8X', 8, 'ascii');
    webp.writeUIntLE(1279, 24, 3);
    webp.writeUIntLE(719, 27, 3);
    expect(imageTokens(image(webp))).toBe(Math.ceil((1280 * 720) / 750));
  });

  it('bounds very large, very small and undecodable images', () => {
    expect(imageTokens(image(png(8000, 8000)))).toBe(6000);
    expect(imageTokens(image(png(32, 32)))).toBe(512);
    expect(imageTokens(image(Buffer.alloc(900_000, 0x42)))).toBe(6000);
  });

  it('treats a data URL in a url source like inline data and keeps remote URLs unchanged', () => {
    expect(imageTokens(image(png(1600, 1000, 300_000), 'url'))).toBe(
      Math.ceil((1600 * 1000) / 750),
    );
    const remote: CanonicalContentBlock = {
      type: 'image',
      source: { type: 'url', media_type: 'image/png', data: 'https://example.com/a.png' },
    };
    expect(imageTokens(remote)).toBe(512 + Math.ceil('https://example.com/a.png'.length / 4));
  });

  it('keeps a screenshot batch that the old estimate rejected well inside a 1.05M context', () => {
    const text: CanonicalContentBlock = { type: 'text', text: 'x'.repeat(120_000) };
    const screenshots = Array.from({ length: 8 }, () => image(png(1600, 1200, 400_000)));
    const estimate = estimateCanonicalRequestTokens(request([text, ...screenshots], 128_000));
    expect(estimate.context_tokens).toBeLessThan(200_000);
    expect(estimate.output_tokens).toBe(128_000);
  });

  it('still counts text as four characters per token', () => {
    const one = estimateCanonicalRequestTokens(request([{ type: 'text', text: 'a'.repeat(400) }]));
    const none = estimateCanonicalRequestTokens(request([]));
    expect(one.input_tokens - none.input_tokens).toBe(100);
  });
});
