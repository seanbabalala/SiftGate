import { attachTokenPricingEvidence } from '../pricing-usage-evidence';
import { geminiCompatibilityUsage, isNativeGeminiUsageSchema } from '../gemini-pricing-usage';
import { CanonicalStreamEvent, TokenUsage } from '../../canonical/canonical.types';
import {
  extractUsageByKnownFields,
  extractUsageBySchema,
  UsageSchema,
} from '../usage-schema-resolver';

export class GeminiStreamParser {
  private buffer = '';
  private pricingUsage?: TokenUsage;

  getPricingUsage(): TokenUsage | undefined { return this.pricingUsage; }
  private currentEvent = '';
  private hasStarted = false;
  private hasStopped = false;

  constructor(private readonly usageSchema?: UsageSchema) {}

  *parse(chunk: string): Generator<CanonicalStreamEvent> {
    this.buffer += chunk;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;

      if (trimmed.startsWith('event: ')) {
        this.currentEvent = trimmed.slice(7).trim();
        continue;
      }

      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.slice(6).trim();
      if (data === '[DONE]') {
        yield* this.stop({});
        return;
      }

      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        yield* this.processEvent(parsed);
      } catch {
        // Ignore malformed SSE payloads.
      }
      this.currentEvent = '';
    }
  }

  *flush(): Generator<CanonicalStreamEvent> {
    if (this.buffer.trim().startsWith('data: ')) {
      const data = this.buffer.trim().slice(6).trim();
      try {
        yield* this.processEvent(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // Ignore malformed trailing payloads.
      }
    }
    yield* this.stop({});
    this.buffer = '';
  }

  private *processEvent(
    data: Record<string, unknown>,
  ): Generator<CanonicalStreamEvent> {
    if (data.usageMetadata) this.resolveUsage(data);
    if (!this.hasStarted) {
      this.hasStarted = true;
      yield {
        type: 'start',
        id: (data.responseId as string) || `gemini_${Date.now()}`,
        model: (data.modelVersion as string) || '',
      };
    }

    const candidates = Array.isArray(data.candidates)
      ? (data.candidates as Record<string, unknown>[])
      : [];
    const candidate = candidates[0] || {};
    const content = (candidate.content || {}) as Record<string, unknown>;
    const parts = Array.isArray(content.parts)
      ? (content.parts as Record<string, unknown>[])
      : [];

    for (const part of parts) {
      if (typeof part.text === 'string' && part.text.length > 0) {
        yield { type: 'delta', content: { type: 'text', text: part.text } };
      }
      if (part.functionCall && typeof part.functionCall === 'object') {
        const functionCall = part.functionCall as Record<string, unknown>;
        yield {
          type: 'delta',
          content: {
            type: 'tool_use',
            id: (functionCall.id as string) || (functionCall.name as string) || '',
            name: functionCall.name as string | undefined,
            input_delta: JSON.stringify(functionCall.args || {}),
          },
        };
      }
    }

    if (candidate.finishReason || data.usageMetadata) {
      yield* this.stop(data, candidate.finishReason as string | undefined);
    }
  }

  private *stop(
    data: Record<string, unknown>,
    finishReason?: string,
  ): Generator<CanonicalStreamEvent> {
    if (this.hasStopped) return;
    this.hasStopped = true;
    yield {
      type: 'stop',
      stop_reason: this.mapFinishReason(finishReason),
      usage: data.usageMetadata ? this.resolveUsage(data) : this.pricingUsage ?? this.resolveUsage({}),
    };
  }

  private resolveUsage(data: Record<string, unknown>): TokenUsage {
    const usageMetadata = (data.usageMetadata || {}) as Record<string, unknown>;
    const fallbackUsage: TokenUsage = {
      input_tokens: (usageMetadata.promptTokenCount as number) || 0,
      output_tokens: (usageMetadata.candidatesTokenCount as number) || 0,
      cache_read_input_tokens:
        (usageMetadata.cachedContentTokenCount as number) || 0,
    };
    const schemaUsage = this.usageSchema
      ? extractUsageBySchema(data, this.usageSchema)
      : { input_tokens: 0, output_tokens: 0 };
    const knownUsage = extractUsageByKnownFields(data);
    const result: TokenUsage = isNativeGeminiUsageSchema(this.usageSchema) ? geminiCompatibilityUsage(usageMetadata) : {
      input_tokens:
        schemaUsage.input_tokens ||
        knownUsage.input_tokens ||
        fallbackUsage.input_tokens ||
        0,
      output_tokens:
        schemaUsage.output_tokens ||
        knownUsage.output_tokens ||
        fallbackUsage.output_tokens ||
        0,
      cache_read_input_tokens:
        schemaUsage.cache_read_input_tokens ||
        knownUsage.cache_read_input_tokens ||
        fallbackUsage.cache_read_input_tokens ||
        0,
    };
    attachTokenPricingEvidence(data, result, this.usageSchema);
    this.pricingUsage = result;
    return result;
  }

  private mapFinishReason(reason?: string): string {
    switch (reason) {
      case 'MAX_TOKENS':
        return 'max_tokens';
      case 'MALFORMED_FUNCTION_CALL':
        return 'tool_use';
      case 'STOP':
      default:
        return 'end_turn';
    }
  }
}
