import { attachTokenPricingEvidence } from '../pricing-usage-evidence';
import { CanonicalStreamEvent, TokenUsage, ToolThoughtSignatureDetail } from '../../canonical/canonical.types';
import { nativeChatMetadata } from '../../canonical/gemini-native-tools';
import { toolThoughtSignature, toolSignatureDetails, ToolThoughtSignature } from '../../canonical/tool-thought-signature';
import {
  extractUsageBySchema,
  extractUsageByKnownFields,
  UsageSchema,
} from '../usage-schema-resolver';

/**
 * Parses SSE stream from a chat/completions provider → CanonicalStreamEvent.
 *
 * Works for: OpenAI, Gemini, MiniMax (all use the same SSE format)
 *
 * SSE format:
 *   data: {"id":"...","choices":[{"delta":{"content":"..."}}],...}
 *   data: [DONE]
 */
interface ChatToolCallState {
  id: string;
  name?: string;
  nativeSignature?: string;
  emittedSignature?: string;
  emittedDetail?: ToolThoughtSignatureDetail;
}

export class ChatCompletionsStreamParser {
  private buffer = '';
  private pricingUsage?: TokenUsage;

  getPricingUsage(): TokenUsage | undefined { return this.pricingUsage; }
  private hasStarted = false;
  private hasSentStop = false;
  private pendingStopReason: string | null = null;
  private readonly toolCallsByIndex = new Map<number, ChatToolCallState>();
  private readonly reasoningDetailsById = new Map<string, ToolThoughtSignatureDetail>();
  private readonly reasoningOrderById = new Map<string, number>();

  constructor(private readonly usageSchema?: UsageSchema, private readonly deferStop = false) {}

  /**
   * Feed raw SSE text chunks and get parsed events.
   */
  *parse(chunk: string): Generator<CanonicalStreamEvent> {
    this.buffer += chunk;

    // Process complete lines
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines and comments

      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();

        if (data === '[DONE]') {
          if (!this.hasSentStop) {
            this.hasSentStop = true;
            yield {
              type: 'stop',
              stop_reason: this.pendingStopReason || 'end_turn',
              usage: this.resolveUsage({}),
            };
            this.pendingStopReason = null;
          }
          return;
        }

        try {
          const parsed = JSON.parse(data);
          yield* this.parseDataObject(parsed);
        } catch {
          // Skip unparseable lines
        }
      }
    }
  }

  private *parseDataObject(
    data: Record<string, unknown>,
  ): Generator<CanonicalStreamEvent> {
    if (data.error && typeof data.error === 'object' && !Array.isArray(data.error)) {
      const error = data.error as Record<string, unknown>;
      yield {
        type: 'error',
        error: {
          message: String(error.message || 'Upstream stream error'),
          code: error.code === null || error.code === undefined ? undefined : String(error.code),
          type: typeof error.type === 'string' ? error.type : undefined,
          status_code:
            typeof error.status_code === 'number'
              ? error.status_code
              : typeof error.statusCode === 'number'
                ? error.statusCode
                : undefined,
        },
      };
      return;
    }

    if (data.usage) this.resolveUsage(data);
    const metadata = nativeChatMetadata(data);
    if (metadata) {
      yield* this.ensureStarted(data);
      yield { type: 'chat_metadata', metadata };
    }
    const choices = data.choices as Record<string, unknown>[];
    if (!choices || choices.length === 0) {
      if (data.usage && !this.hasSentStop) {
        if (!this.hasStarted && (data.id || data.model)) {
          yield* this.ensureStarted(data);
        }
        if (this.shouldDeferStop()) {
          this.pendingStopReason ??= 'end_turn';
          return;
        }
        this.hasSentStop = true;
        yield {
          type: 'stop',
          stop_reason: this.pendingStopReason || 'end_turn',
          usage: this.resolveUsage(data),
        };
        this.pendingStopReason = null;
      }
      return;
    }

    const choice = choices[0];
    const delta = (choice.delta || {}) as Record<string, unknown>;
    const finishReason = choice.finish_reason as string | null;
    const reasoningDetails = toolSignatureDetails(delta.reasoning_details);
    for (const detail of reasoningDetails) {
      if (!this.reasoningOrderById.has(detail.id)) this.reasoningOrderById.set(detail.id, this.reasoningOrderById.size);
      this.reasoningDetailsById.set(detail.id, detail);
    }

    yield* this.ensureStarted(data);

    // Text delta
    if (delta.content !== undefined && delta.content !== null) {
      yield {
        type: 'delta',
        content: { type: 'text', text: delta.content as string },
      };
    }

    // Tool call delta
    if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls as Record<string, unknown>[]) {
        const fn = (tc.function || {}) as Record<string, unknown>;
        const index = this.resolveToolCallIndex(tc, fn);
        // An unaddressed parallel delta cannot safely be assigned to any call.
        if (index === undefined) continue;
        const state = this.toolCallsByIndex.get(index) || { id: '' };
        const id = typeof tc.id === 'string' && tc.id ? tc.id : state.id;
        const name =
          typeof fn.name === 'string' && fn.name
            ? fn.name
            : state.name;
        state.id = id;
        state.name = name;
        this.toolCallsByIndex.set(index, state);
        const signature = this.signatureDelta(state, tc);
        const inputDelta =
          fn.arguments === undefined || fn.arguments === null
            ? undefined
            : String(fn.arguments);
        yield {
          type: 'delta',
          content: {
            type: 'tool_use',
            id,
            index,
            name: typeof fn.name === 'string' && fn.name ? fn.name : undefined,
            input_delta: inputDelta,
            ...signature,
          },
        };
      }
    }

    const callsById = new Map<string, [number, ChatToolCallState] | null>();
    if (reasoningDetails.length) for (const entry of this.toolCallsByIndex) {
      const id = entry[1].id;
      if (id) callsById.set(id, callsById.has(id) ? null : entry);
    }
    for (const detail of reasoningDetails) {
      const match = callsById.get(detail.id);
      // A reasoning-detail index is unrelated to a tool-call index. Wait for
      // the matching ID instead of binding an early/orphan entry by position.
      if (!match) continue;
      const [index, state] = match;
      const signature = this.signatureDelta(state);
      if (Object.keys(signature).length) yield {
        type: 'delta', content: { type: 'tool_use', id: state.id, index, ...signature },
      };
    }

    // Finish reason — end of stream
    if (finishReason) {
      const stopReason = this.mapFinishReason(finishReason);
      if (data.usage && !this.shouldDeferStop()) {
        this.hasSentStop = true;
        this.pendingStopReason = null;
        yield {
          type: 'stop',
          stop_reason: stopReason,
          usage: this.resolveUsage(data),
        };
      } else {
        this.pendingStopReason = stopReason;
      }
    }
  }

  *flush(): Generator<CanonicalStreamEvent> {
    if (this.buffer.trim()) yield* this.parse('\n');
    if (!this.hasSentStop && this.pendingStopReason) {
      this.hasSentStop = true;
      yield {
        type: 'stop',
        stop_reason: this.pendingStopReason,
        usage: this.resolveUsage({}),
      };
      this.pendingStopReason = null;
    }
  }

  private shouldDeferStop(): boolean {
    // Tool signatures can follow finish_reason/usage. Drain until DONE or EOF.
    return this.deferStop || this.toolCallsByIndex.size > 0 || this.reasoningDetailsById.size > 0;
  }

  private signatureDelta(state: ChatToolCallState, toolCall?: Record<string, unknown>): ToolThoughtSignature {
    const native = toolCall ? toolThoughtSignature(toolCall).thought_signature : undefined;
    if (native !== undefined) state.nativeSignature = native;
    const detail = this.reasoningDetailsById.get(state.id);
    const signature = state.nativeSignature ?? detail?.data;
    const result: ToolThoughtSignature = {};
    if (signature !== undefined && signature !== state.emittedSignature) {
      result.thought_signature = signature;
      state.emittedSignature = signature;
    }
    if (detail && detail.data === signature &&
      (detail.data !== state.emittedDetail?.data || detail.format !== state.emittedDetail?.format ||
       detail.index !== state.emittedDetail?.index || detail.id !== state.emittedDetail?.id)) {
      result.thought_signature_detail = detail;
      result.thought_signature_detail_order = this.reasoningOrderById.get(detail.id);
      state.emittedDetail = detail;
    }
    return result;
  }

  private resolveToolCallIndex(
    tc: Record<string, unknown>,
    fn: Record<string, unknown>,
  ): number | undefined {
    if (typeof tc.index === 'number' && Number.isInteger(tc.index) && tc.index >= 0) {
      return tc.index;
    }
    if (typeof tc.id === 'string' && tc.id) {
      for (const [index, state] of this.toolCallsByIndex) {
        if (state.id === tc.id) return index;
      }
    } else if (!fn.name) {
      if (this.toolCallsByIndex.size === 1) return this.toolCallsByIndex.keys().next().value;
      if (this.toolCallsByIndex.size > 1) return undefined;
    }
    let index = 0;
    while (this.toolCallsByIndex.has(index)) index++;
    return index;
  }

  private *ensureStarted(
    data: Record<string, unknown>,
  ): Generator<CanonicalStreamEvent> {
    if (this.hasStarted) return;
    this.hasStarted = true;
    yield {
      type: 'start',
      id: (data.id as string) || '',
      model: (data.model as string) || '',
    };
  }

  private mapFinishReason(reason: string): string {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'tool_calls':
        return 'tool_use';
      case 'length':
        return 'max_tokens';
      default:
        return 'end_turn';
    }
  }

  private resolveUsage(data: Record<string, unknown>): TokenUsage {
    // A late grounding-only chunk / [DONE] must not erase earlier accounting.
    if (Object.keys(data).length === 0 && this.pricingUsage) return this.pricingUsage;
    const usage = (data.usage || {}) as Record<string, unknown>;
    const promptDetails = (usage.prompt_tokens_details || {}) as Record<
      string,
      unknown
    >;
    const fallbackUsage: TokenUsage = {
      input_tokens: (usage.prompt_tokens as number) || 0,
      output_tokens: (usage.completion_tokens as number) || 0,
      cache_read_input_tokens: (promptDetails.cached_tokens as number) || 0,
    };

    const schemaUsage = this.usageSchema
      ? extractUsageBySchema(data, this.usageSchema)
      : { input_tokens: 0, output_tokens: 0 };
    const knownUsage = extractUsageByKnownFields(data);
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
    attachTokenPricingEvidence(data, result, this.usageSchema);
    this.pricingUsage = result;
    return result;
  }
}
