import { attachTokenPricingEvidence } from '../pricing-usage-evidence';
import { CanonicalStreamEvent, TokenUsage } from '../../canonical/canonical.types';
import {
  extractUsageBySchema,
  extractUsageByKnownFields,
  UsageSchema,
} from '../usage-schema-resolver';

/**
 * Parses SSE stream from an Anthropic Messages API provider → CanonicalStreamEvent.
 *
 * SSE format:
 *   event: message_start
 *   data: {"type":"message_start","message":{"id":"msg_...","model":"claude-...",...}}
 *
 *   event: content_block_start
 *   data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
 *
 *   event: content_block_delta (tool_use)
 *   data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"..."}}
 *
 *   event: message_stop
 *   data: {"type":"message_stop"}
 *
 *   event: message_delta
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}
 */
export class MessagesStreamParser {
  private buffer = '';
  private rawPricingUsage: Record<string, unknown> = {};
  private pricingUsage?: TokenUsage;
  private resolvedServiceTier?: string;

  getPricingUsage(): TokenUsage | undefined { return this.pricingUsage; }
  private currentEvent = '';

  // Track content block types by index
  private blockTypes: Map<number, { type: string; id?: string; name?: string }> =
    new Map();

  // Track cache tokens from message_start (Anthropic sends them there)
  private cacheCreationInputTokens = 0;
  private cacheReadInputTokens = 0;
  private inputTokens = 0;

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

      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6).trim();

        try {
          const parsed = JSON.parse(data);
          yield* this.processEvent(this.currentEvent, parsed);
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
    switch (eventType) {
      case 'message_start': {
        const message = (data.message || {}) as Record<string, unknown>;
        const startUsage = (message.usage || {}) as Record<string, unknown>;
        this.rawPricingUsage = { ...startUsage };
        this.resolvedServiceTier = typeof message.service_tier === 'string' ? message.service_tier : undefined;
        const resolvedUsage = this.resolveUsage({ usage: startUsage });
        this.inputTokens = resolvedUsage.input_tokens || 0;
        this.cacheCreationInputTokens =
          resolvedUsage.cache_creation_input_tokens || 0;
        this.cacheReadInputTokens = resolvedUsage.cache_read_input_tokens || 0;
        yield {
          type: 'start',
          id: (message.id as string) || '',
          model: (message.model as string) || '',
        };
        break;
      }

      case 'content_block_start': {
        const index = data.index as number;
        const block = (data.content_block || {}) as Record<string, unknown>;

        this.blockTypes.set(index, {
          type: block.type as string,
          id: block.id as string | undefined,
          name: block.name as string | undefined,
        });

        // For tool_use blocks, emit an initial delta with the name
        if (block.type === 'tool_use') {
          yield {
            type: 'delta',
            content: {
              type: 'tool_use',
              id: (block.id as string) || '',
              name: (block.name as string) || undefined,
              input_delta: undefined,
            },
          };
        }
        break;
      }

      case 'content_block_delta': {
        const index = data.index as number;
        const delta = (data.delta || {}) as Record<string, unknown>;
        const blockInfo = this.blockTypes.get(index);

        if (delta.type === 'text_delta') {
          yield {
            type: 'delta',
            content: { type: 'text', text: (delta.text as string) || '' },
          };
        } else if (delta.type === 'input_json_delta') {
          yield {
            type: 'delta',
            content: {
              type: 'tool_use',
              id: blockInfo?.id || '',
              input_delta: (delta.partial_json as string) || '',
            },
          };
        }
        break;
      }

      case 'content_block_stop':
        // Block complete — no action needed
        break;

      case 'message_delta': {
        const delta = (data.delta || {}) as Record<string, unknown>;
        const usage = (data.usage || {}) as Record<string, unknown>;
        const resolvedUsage = this.resolveUsage({ usage });

        this.rawPricingUsage = { ...this.rawPricingUsage, ...usage };
        const combined: TokenUsage = {
            input_tokens:
              this.inputTokens || resolvedUsage.input_tokens || 0,
            output_tokens: resolvedUsage.output_tokens || 0,
            cache_creation_input_tokens:
              this.cacheCreationInputTokens ||
              resolvedUsage.cache_creation_input_tokens ||
              0,
            cache_read_input_tokens:
              this.cacheReadInputTokens ||
              resolvedUsage.cache_read_input_tokens ||
              0,
        };
        attachTokenPricingEvidence({ usage: this.rawPricingUsage, service_tier: this.resolvedServiceTier }, combined, this.usageSchema);
        this.pricingUsage = combined;
        yield { type: 'stop', stop_reason: (delta.stop_reason as string) || 'end_turn', usage: combined };
        break;
      }

      case 'message_stop':
        // Final confirmation — we already emitted stop on message_delta
        break;

      case 'ping':
        // Keep-alive — skip
        break;

      case 'error': {
        const error = (data.error || data) as Record<string, unknown>;
        yield {
          type: 'error',
          error: {
            message: (error.message as string) || 'Unknown stream error',
            code:
              (error.code as string) ||
              (error.type as string) ||
              undefined,
            type: (error.type as string) || undefined,
            status_code:
              typeof error.status_code === 'number'
                ? error.status_code
                : typeof error.statusCode === 'number'
                  ? error.statusCode
                  : undefined,
          },
        };
        break;
      }

      default:
        break;
    }
  }

  private resolveUsage(data: Record<string, unknown>) {
    const usage = (data.usage || {}) as Record<string, unknown>;
    const fallbackUsage = {
      input_tokens: (usage.input_tokens as number) || 0,
      output_tokens: (usage.output_tokens as number) || 0,
      cache_creation_input_tokens:
        (usage.cache_creation_input_tokens as number) || 0,
      cache_read_input_tokens: (usage.cache_read_input_tokens as number) || 0,
    };

    const schemaUsage = this.usageSchema
      ? extractUsageBySchema(data, this.usageSchema)
      : { input_tokens: 0, output_tokens: 0 };
    const knownUsage = extractUsageByKnownFields(data);
    return {
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
  }
}
