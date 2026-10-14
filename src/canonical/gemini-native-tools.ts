import type { CanonicalRequest, NativeChatMetadata } from "./canonical.types";

// These provider-executed tools are not OpenAI function declarations. Preserve
// deprecated spellings too: the provider must reject them, not silently chat.
const GEMINI_TOOL_FIELDS = new Set([
  "googleSearch",
  "google_search",
  "googleSearchRetrieval",
  "GoogleSearchRetrieval",
  "google_search_retrieval",
  "enterpriseWebSearch",
  "enterprise_web_search",
  "urlContext",
  "url_context",
  "codeExecution",
  "code_execution",
  "googleMaps",
  "google_maps",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGeminiTool(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.type !== "function" &&
    typeof value.name !== "string" &&
    Object.keys(value).some((key) => GEMINI_TOOL_FIELDS.has(key))
  );
}

function rawTools(request: CanonicalRequest): unknown[] {
  const body = request.metadata.raw_body;
  return isRecord(body) && Array.isArray(body.tools) ? body.tools : [];
}

export function hasGeminiNativeTools(request: CanonicalRequest): boolean {
  return rawTools(request).some(isGeminiTool);
}

/** Merge native tools without resurrecting function tools removed by a hook. */
export function mergeGeminiNativeTools(
  request: CanonicalRequest,
  normalizedTools: unknown,
): Record<string, unknown>[] {
  const functions = Array.isArray(normalizedTools)
    ? normalizedTools.filter(isRecord)
    : [];
  const used = new Set<Record<string, unknown>>();
  const result: Record<string, unknown>[] = [];
  for (const tool of rawTools(request)) {
    if (isGeminiTool(tool)) {
      result.push(JSON.parse(JSON.stringify(tool)) as Record<string, unknown>);
    } else if (isRecord(tool)) {
      const name = isRecord(tool.function) ? tool.function.name : tool.name;
      const normalized = functions.find(
        (item) =>
          isRecord(item.function) &&
          item.function.name === name &&
          !used.has(item),
      );
      if (normalized) {
        result.push(normalized);
        used.add(normalized);
      }
    }
  }
  return [...result, ...functions.filter((tool) => !used.has(tool))];
}

/** Only client-facing grounding fields; never retain arbitrary upstream data. */
export function nativeChatMetadata(
  body: Record<string, unknown>,
): NativeChatMetadata | undefined {
  const metadata: NativeChatMetadata = {};
  for (const field of [
    "vertex_ai_grounding_metadata",
    "vertex_ai_url_context_metadata",
  ] as const) {
    if (body[field] !== undefined)
      metadata[field] = JSON.parse(JSON.stringify(body[field])) as unknown;
  }
  return Object.keys(metadata).length ? metadata : undefined;
}
