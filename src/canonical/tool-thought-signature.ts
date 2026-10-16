function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Opaque provider state: never trim, decode, concatenate or synthesize it. */
export function toolThoughtSignature(toolCall: Record<string, unknown>): { thought_signature?: string } {
  const google = asRecord(asRecord(toolCall.extra_content)?.google);
  const provider = asRecord(toolCall.provider_specific_fields);
  const signature = typeof google?.thought_signature === 'string'
    ? google.thought_signature
    : provider?.thought_signature;
  return typeof signature === 'string' ? { thought_signature: signature } : {};
}

/** Emit only the supported signature field, not arbitrary provider metadata. */
export function chatToolThoughtSignature(signature: string | undefined): {
  extra_content?: { google: { thought_signature: string } };
} {
  return signature === undefined ? {} : {
    extra_content: { google: { thought_signature: signature } },
  };
}
