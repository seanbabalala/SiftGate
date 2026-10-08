import { attachTokenPricingEvidence } from '../pricing-usage-evidence';
import { CanonicalStreamEvent, TokenUsage } from '../../canonical/canonical.types';
import {
  extractUsageBySchema,
  extractUsageByKnownFields,
  UsageSchema,
} from '../usage-schema-resolver';

/**
 * Parses SSE stream from an OpenAI Responses API provider → CanonicalStreamEvent.
 *
 * SSE format (multiple event types):
 *   event: response.created
 *   data: {"id":"resp_...","model":"gpt-5.4",...}
 *
 *   event: response.output_item.added
 *   data: {...}
 *
 *   event: response.output_text.delta
 *   data: {"delta":"Hello"}
 *
 *   event: response.function_call_arguments.delta
 *   data: {"delta":"...","call_id":"...","name":"..."}
 *
 *   event: response.completed
 *   data: {"id":"resp_...","usage":{...},...}
 */
export class ResponsesStreamParser {
  private buffer = '';
  private pricingUsage?: TokenUsage;

  getPricingUsage(): TokenUsage | undefined { return this.pricingUsage; }
  private currentEvent = '';
  private hasSentStop = false;
  private readonly startedFunctionCalls = new Set<string>();
  private readonly functionCallsWithArgumentDeltas = new Set<string>();
  private readonly functionCallItemIds = new Map<string, string>();

  constructor(private readonly usageSchema?: UsageSchema) {}

  *parse(chunk: string): Generator<CanonicalStreamEvent> {
    this.buffer += chunk;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith(':')) continue;

      // Event type line
      if (trimmed.startsWith('event: ')) {
        this.currentEvent = trimmed.slice(7).trim();
        continue;
      }

      // Data line
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6).trim();

        if (data === '[DONE]') {
          if (!this.hasSentStop) {
            this.hasSentStop = true;
            yield {
              type: 'stop',
              stop_reason: 'end_turn',
              usage: this.resolveUsage({}),
            };
          }
          this.currentEvent = '';
          return;
        }

        try {
          const parsed = JSON.parse(data);
          const eventType =
            this.currentEvent ||
            (typeof parsed?.type === 'string' ? parsed.type : '');
          yield* this.processEvent(eventType, parsed);
        } catch {
          // Skip unparseable
        }

        this.currentEvent = '';
      }
    }
  }

  private *processEvent(
    eventType: string,
    data: Record<string, unknown>,
  ): Generator<CanonicalStreamEvent> {
    const response = this.unwrapResponse(data);

    switch (eventType) {
      case 'response.created': {
        yield {
          type: 'start',
          id: (response.id as string) || (data.id as string) || '',
          model: (response.model as string) || (data.model as string) || '',
        };
        break;
      }

      case 'response.output_text.delta': {
        const delta = (data.delta as string) || '';
        if (delta) {
          yield {
            type: 'delta',
            content: { type: 'text', text: delta },
          };
        }
        break;
      }

      case 'response.output_item.added': {
        const item = (data.item || {}) as Record<string, unknown>;
        if (item.type === 'function_call') {
          yield* this.emitFunctionCallStart(item);
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const itemId = data.item_id as string | undefined;
        const callId =
          (data.call_id as string) ||
          (itemId ? this.functionCallItemIds.get(itemId) : undefined) ||
          itemId ||
          '';
        if (callId) {
          this.functionCallsWithArgumentDeltas.add(callId);
        }
        yield {
          type: 'delta',
          content: {
            type: 'tool_use',
            id: callId,
            name: data.name as string | undefined,
            input_delta: (data.delta as string) || undefined,
          },
        };
        break;
      }

      case 'response.function_call_arguments.done': {
        // Final function call arguments — we've already streamed the deltas
        break;
      }

      case 'response.output_item.done': {
        const item = (data.item || {}) as Record<string, unknown>;
        if (item.type === 'function_call') {
          const callId = this.functionCallId(item);
          if (!this.startedFunctionCalls.has(callId)) {
            yield* this.emitFunctionCallStart(item);
          }
          const args = item.arguments as string | undefined;
          if (args && !this.functionCallsWithArgumentDeltas.has(callId)) {
            yield {
              type: 'delta',
              content: {
                type: 'tool_use',
                id: callId,
                input_delta: args,
              },
            };
          }
        }
        if (this.isToolCallItem(item)) {
          yield {
            type: 'tool_call_complete',
            id: this.functionCallId(item),
            tool_type: item.type as string,
          };
        }
        break;
      }

      case 'response.completed': {
        this.hasSentStop = true;
        yield {
          type: 'stop',
          stop_reason: this.mapStatus(
            (response.status as string) || (data.status as string),
          ),
          usage: this.resolveUsage(data),
        };
        break;
      }

      case 'response.incomplete': {
        this.hasSentStop = true;
        yield {
          type: 'stop',
          stop_reason: 'max_tokens',
          usage: this.resolveUsage(data),
        };
        break;
      }

      case 'response.output_text.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.in_progress':
        // Informational events — skip
        break;

      case 'response.failed': {
        // A failed generation can still report billable usage. Retain it for
        // the attempt observer without emitting a client-visible success stop.
        this.resolveUsage(data);
        this.hasSentStop = true;
        const error = this.unwrapError(data);
        yield {
          type: 'error',
          error: {
            message: error.message || 'Responses stream failed',
            code: error.code || undefined,
            type: error.type || undefined,
            status_code: error.status_code || undefined,
          },
        };
        break;
      }

      case 'error': {
        const error = this.unwrapError(data);
        yield {
          type: 'error',
          error: {
            message: error.message || 'Unknown stream error',
            code: error.code || undefined,
            type: error.type || undefined,
            status_code: error.status_code || undefined,
          },
        };
        break;
      }

      default:
        // Unknown event types — skip silently
        break;
    }
  }

  private *emitFunctionCallStart(
    item: Record<string, unknown>,
  ): Generator<CanonicalStreamEvent> {
    const callId = this.functionCallId(item);
    if (!callId || this.startedFunctionCalls.has(callId)) return;
    const itemId = item.id as string | undefined;
    if (itemId) {
      this.functionCallItemIds.set(itemId, callId);
    }
    this.startedFunctionCalls.add(callId);
    yield {
      type: 'delta',
      content: {
        type: 'tool_use',
        id: callId,
        name: item.name as string | undefined,
      },
    };
  }

  private functionCallId(item: Record<string, unknown>): string {
    return (item.call_id as string) || (item.id as string) || '';
  }

  private isToolCallItem(item: Record<string, unknown>): boolean {
    return typeof item.type === 'string' && item.type.endsWith('_call');
  }

  private mapStatus(status: string): string {
    if (status === 'completed') return 'end_turn';
    if (status === 'incomplete') return 'max_tokens';
    return 'end_turn';
  }

  private resolveUsage(data: Record<string, unknown>) {
    const response = this.unwrapResponse(data);
    const usage = (response.usage || data.usage || {}) as Record<
      string,
      unknown
    >;
    const inputTokensDetails = (usage.input_tokens_details || {}) as Record<
      string,
      unknown
    >;
    const inputDetails = (usage.input_token_details || {}) as Record<
      string,
      unknown
    >;
    const promptDetails = (usage.prompt_tokens_details || {}) as Record<
      string,
      unknown
    >;
    const fallbackUsage: TokenUsage = {
      input_tokens: (usage.input_tokens as number) || 0,
      output_tokens: (usage.output_tokens as number) || 0,
      cache_read_input_tokens:
        ((inputTokensDetails.cached_tokens as number) ||
          (promptDetails.cached_tokens as number) ||
          (inputDetails.cached_tokens as number) ||
          0),
    };

    const schemaSource = Object.keys(response).length > 0 ? response : data;
    const schemaUsage = this.usageSchema
      ? extractUsageBySchema(schemaSource, this.usageSchema)
      : { input_tokens: 0, output_tokens: 0 };
    const knownUsage = extractUsageByKnownFields(schemaSource);
    const result: TokenUsage = {
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
      cache_creation_input_tokens:
        schemaUsage.cache_creation_input_tokens ||
        knownUsage.cache_creation_input_tokens ||
        fallbackUsage.cache_creation_input_tokens ||
        0,
      cache_read_input_tokens:
        schemaUsage.cache_read_input_tokens ||
        knownUsage.cache_read_input_tokens ||
        fallbackUsage.cache_read_input_tokens ||
        0,
    };
    attachTokenPricingEvidence(schemaSource, result, this.usageSchema);
    this.pricingUsage = result;
    return result;
  }

  private unwrapResponse(data: Record<string, unknown>): Record<string, unknown> {
    return (data.response || {}) as Record<string, unknown>;
  }

  private unwrapError(data: Record<string, unknown>): {
    message?: string;
    code?: string;
    type?: string;
    status_code?: number;
  } {
    const response = this.unwrapResponse(data);
    const error = ((response.error || data.error || {}) as Record<
      string,
      unknown
    >);
    const statusCode =
      typeof error.status_code === 'number'
        ? error.status_code
        : typeof error.statusCode === 'number'
          ? error.statusCode
          : undefined;
    return {
      message:
        (error.message as string) ||
        (response.message as string) ||
        (data.message as string) ||
        undefined,
      code:
        (error.code as string) ||
        (response.code as string) ||
        (data.code as string) ||
        undefined,
      type:
        (error.type as string) ||
        (response.type as string) ||
        (data.type as string) ||
        undefined,
      status_code: statusCode,
    };
  }
}
