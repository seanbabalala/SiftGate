import type { ToolThoughtSignatureDetail } from './canonical.types';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export interface ToolThoughtSignature {
  thought_signature?: string;
  thought_signature_detail?: ToolThoughtSignatureDetail;
  thought_signature_detail_order?: number;
}

export type ToolSignatureDetailIndex = ReadonlyMap<string, { detail: ToolThoughtSignatureDetail; order: number }>;

/** Index once per message/response, rather than rescanning for each parallel call. */
export function indexToolSignatureDetails(value: unknown): ToolSignatureDetailIndex {
  const result = new Map<string, { detail: ToolThoughtSignatureDetail; order: number }>();
  toolSignatureDetails(value).forEach((detail, order) => {
    if (!result.has(detail.id)) result.set(detail.id, { detail, order });
  });
  return result;
}

/** Read only Gemini-compatible encrypted entries; their index is never identity. */
export function toolSignatureDetails(value: unknown): ToolThoughtSignatureDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const detail = asRecord(item);
    if (!detail || detail.type !== 'reasoning.encrypted' ||
      typeof detail.id !== 'string' || !detail.id || typeof detail.data !== 'string') return [];
    // Some compatible clients omit format. Explicit other-provider state must
    // not become a Gemini signature, even if its ID coincides with a tool ID.
    if (detail.format !== undefined && detail.format !== null &&
      detail.format !== 'unknown' && detail.format !== 'google-gemini-v1') return [];
    return [{
      type: 'reasoning.encrypted' as const, id: detail.id, data: detail.data,
      ...(detail.format !== undefined ? { format: detail.format as string | null } : {}),
      ...(detail.index === null || (typeof detail.index === 'number' && Number.isInteger(detail.index) && detail.index >= 0)
        ? { index: detail.index as number | null } : {}),
    }];
  });
}

/** Opaque provider state: never trim, decode, concatenate or synthesize it. */
export function toolThoughtSignature(toolCall: Record<string, unknown>, reasoningDetails?: unknown, indexedDetails?: ToolSignatureDetailIndex): ToolThoughtSignature {
  const google = asRecord(asRecord(toolCall.extra_content)?.google);
  const provider = asRecord(toolCall.provider_specific_fields);
  const native = typeof google?.thought_signature === 'string'
    ? google.thought_signature
    : provider?.thought_signature;
  const indexed = indexedDetails ?? (reasoningDetails === undefined ? undefined : indexToolSignatureDetails(reasoningDetails));
  const entry = typeof toolCall.id === 'string' ? indexed?.get(toolCall.id) : undefined;
  const detail = entry?.detail;
  const signature = typeof native === 'string' ? native : detail?.data;
  return typeof signature === 'string' ? {
    thought_signature: signature,
    ...(detail?.data === signature ? { thought_signature_detail: detail, thought_signature_detail_order: entry?.order } : {}),
  } : {};
}

/** This is an envelope for the original bytes, not a new/encrypted signature. */
export function chatToolReasoningDetail(tool: ToolThoughtSignature & { id: string }): ToolThoughtSignatureDetail | undefined {
  if (!tool.id || tool.thought_signature === undefined) return undefined;
  const detail = tool.thought_signature_detail;
  if (detail?.id === tool.id && detail.data === tool.thought_signature) return { ...detail };
  return { type: 'reasoning.encrypted', id: tool.id, data: tool.thought_signature, format: 'google-gemini-v1' };
}

export function chatToolReasoningDetails(tools: Array<ToolThoughtSignature & { id: string }>): {
  reasoning_details?: ToolThoughtSignatureDetail[];
} {
  // Keep the source encrypted-detail sequence, independently of tool ordering.
  // Google-only signatures have no source envelope and follow in tool order.
  const ordered = [...tools].sort((a, b) =>
    (a.thought_signature_detail_order ?? Number.MAX_SAFE_INTEGER) -
    (b.thought_signature_detail_order ?? Number.MAX_SAFE_INTEGER));
  const details = ordered.flatMap((tool) => {
    const detail = chatToolReasoningDetail(tool);
    return detail ? [detail] : [];
  });
  return details.length ? { reasoning_details: details } : {};
}

export type ChatToolSignatureFormat = 'google' | 'openrouter' | 'both';

/** Keep upstream-specific extensions away from strict Google Chat endpoints. */
export function applyChatToolSignatureFormat(body: Record<string, unknown>, format: ChatToolSignatureFormat): void {
  if (!Array.isArray(body.messages)) return;
  for (const value of body.messages) {
    const message = asRecord(value);
    if (!message || message.role !== 'assistant') continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(asRecord).filter((c): c is Record<string, unknown> => !!c) : [];
    const ids = new Set(calls.map((call) => call.id));
    const details = toolSignatureDetails(message.reasoning_details).filter((detail) => ids.has(detail.id));
    if (format === 'google' || !details.length) delete message.reasoning_details;
    else message.reasoning_details = details;
    if (format !== 'openrouter') continue;
    for (const call of calls) {
      const extra = asRecord(call.extra_content);
      const google = asRecord(extra?.google);
      if (!extra || !google) continue;
      delete google.thought_signature;
      if (!Object.keys(google).length) delete extra.google;
      if (!Object.keys(extra).length) delete call.extra_content;
    }
  }
}

/** Emit only the supported signature field, not arbitrary provider metadata. */
export function chatToolThoughtSignature(signature: string | undefined): {
  extra_content?: { google: { thought_signature: string } };
} {
  return signature === undefined ? {} : {
    extra_content: { google: { thought_signature: signature } },
  };
}
