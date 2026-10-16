import {
  CanonicalStreamEvent,
  TokenUsage,
} from '../../canonical/canonical.types';
import { nativeChatMetadata } from '../../canonical/gemini-native-tools';
import { chatToolThoughtSignature } from '../../canonical/tool-thought-signature';

/**
 * Serializes CanonicalStreamEvent → SSE text for each client protocol.
 */

// ═══════════════════════════════════════════════════════
// Chat Completions SSE Serializer
// ═══════════════════════════════════════════════════════

export class ChatCompletionsStreamSerializer {
  private id = '';
  private model = '';
  private nextToolCallIndex = 0;
  private activeToolCallKey = '';
  private readonly toolCalls = new Map<
    string,
    { index: number; id: string; name?: string; started: boolean }
  >();

  serialize(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'raw_sse':
        return event.text;

      case 'chat_metadata':
        return this.sse({
          id: this.id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [],
          ...nativeChatMetadata({ ...event.metadata }),
        });

      case 'tool_call_complete':
        return '';

      case 'start': {
        this.id = event.id;
        this.model = event.model;
        this.nextToolCallIndex = 0;
        this.activeToolCallKey = '';
        this.toolCalls.clear();
        return this.sse({
          id: this.id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [
            { index: 0, delta: { role: 'assistant' }, finish_reason: null },
          ],
        });
      }

      case 'delta': {
        if (event.content.type === 'text') {
          return this.sse({
            id: this.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
              {
                index: 0,
                delta: { content: event.content.text },
                finish_reason: null,
              },
            ],
          });
        }

        if (event.content.type === 'tool_use') {
          const state = this.resolveToolCallState(event.content);
          const toolCall: Record<string, unknown> = {
            index: state.index,
            ...chatToolThoughtSignature(event.content.thought_signature),
          };
          const fn: Record<string, unknown> = {};

          if (!state.started && state.id) toolCall.id = state.id;
          if (event.content.name) {
            toolCall.type = 'function';
            fn.name = event.content.name;
            fn.arguments = event.content.input_delta || '';
          } else if (event.content.input_delta !== undefined) {
            fn.arguments = event.content.input_delta;
          }
          if (Object.keys(fn).length > 0) toolCall.function = fn;
          // Signature-only chunks may precede the ID. Emit it once it arrives.
          if (toolCall.id) state.started = true;

          return this.sse({
            id: this.id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.model,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [toolCall] },
                finish_reason: null,
              },
            ],
          });
        }

        return '';
      }

      case 'stop': {
        const finishReason = this.mapStopReason(event.stop_reason);
        const hasUsage = event.usage.input_tokens > 0 || event.usage.output_tokens > 0;
        const usageObj: Record<string, unknown> = hasUsage
          ? {
              prompt_tokens: event.usage.input_tokens,
              completion_tokens: event.usage.output_tokens,
              total_tokens: event.usage.input_tokens + event.usage.output_tokens,
            }
          : {};
        if (hasUsage && event.usage.cache_read_input_tokens) {
          usageObj.prompt_tokens_details = { cached_tokens: event.usage.cache_read_input_tokens };
        }
        let result = this.sse({
          id: this.id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.model,
          choices: [
            { index: 0, delta: {}, finish_reason: finishReason },
          ],
          ...(hasUsage ? { usage: usageObj } : {}),
        });
        result += 'data: [DONE]\n\n';
        return result;
      }

      case 'error': {
        return this.sse({
          error: {
            message: event.error.message,
            type: event.error.type || 'server_error',
            code: event.error.code || null,
            status_code: event.error.status_code || null,
          },
        });
      }
    }
  }

  private sse(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  private resolveToolCallState(
    content: Extract<CanonicalStreamEvent, { type: 'delta' }>['content'] & {
      type: 'tool_use';
    },
  ): { index: number; id: string; name?: string; started: boolean } {
    const indexKey = content.index === undefined ? undefined : `index:${content.index}`;
    const idKey = content.id ? `id:${content.id}` : undefined;
    const key =
      indexKey || idKey ||
      this.activeToolCallKey ||
      (content.name ? `name:${content.name}` : `anonymous:${this.nextToolCallIndex}`);
    let state = this.toolCalls.get(key) || (idKey ? this.toolCalls.get(idKey) : undefined);
    if (!state) {
      state = {
        index: content.index ?? this.nextToolCallIndex,
        id: content.id || '',
        name: content.name,
        started: false,
      };
      this.toolCalls.set(key, state);
      this.nextToolCallIndex = Math.max(this.nextToolCallIndex, state.index + 1);
    }
    if (indexKey) this.toolCalls.set(indexKey, state);
    if (idKey) this.toolCalls.set(idKey, state);
    if (content.id) state.id = content.id;
    if (content.name) state.name = content.name;
    this.activeToolCallKey = key;
    return state;
  }

  private mapStopReason(reason: string): string {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      default:
        return 'stop';
    }
  }
}

// ═══════════════════════════════════════════════════════
// Responses SSE Serializer
// ═══════════════════════════════════════════════════════

interface ResponsesFunctionCallState {
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
}

export class ResponsesStreamSerializer {
  private id = '';
  private model = '';
  private outputIndex = 0;
  private sequenceNumber = 0;
  private messageItemId = '';
  private accumulatedText = '';
  private activeFunctionCallId = '';
  private functionCalls: ResponsesFunctionCallState[] = [];

  serialize(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'chat_metadata':
        return '';
      case 'raw_sse':
        return event.text;

      case 'tool_call_complete':
        return '';

      case 'start': {
        this.id = event.id || `resp_${Date.now()}`;
        this.model = event.model;
        this.outputIndex = 0;
        this.sequenceNumber = 0;
        this.messageItemId = `msg_${this.id}`;
        this.accumulatedText = '';
        this.activeFunctionCallId = '';
        this.functionCalls = [];
        let result = '';
        result += this.sseEvent('response.created', {
          type: 'response.created',
          sequence_number: this.nextSequenceNumber(),
          response: {
            id: this.id,
            object: 'response',
            model: this.model,
            status: 'in_progress',
            output: [],
          },
        });
        result += this.sseEvent('response.in_progress', {
          type: 'response.in_progress',
          sequence_number: this.nextSequenceNumber(),
          response: {
            id: this.id,
            object: 'response',
            model: this.model,
            status: 'in_progress',
          },
        });
        // Add output item
        result += this.sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: this.outputIndex,
          sequence_number: this.nextSequenceNumber(),
          item: {
            type: 'message',
            id: this.messageItemId,
            role: 'assistant',
            content: [],
            status: 'in_progress',
          },
        });
        result += this.sseEvent('response.content_part.added', {
          type: 'response.content_part.added',
          output_index: this.outputIndex,
          item_id: this.messageItemId,
          content_index: 0,
          sequence_number: this.nextSequenceNumber(),
          part: { type: 'output_text', text: '', annotations: [] },
        });
        return result;
      }

      case 'delta': {
        if (event.content.type === 'text') {
          this.accumulatedText += event.content.text;
          return this.sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: 0,
            item_id: this.messageItemId,
            content_index: 0,
            delta: event.content.text,
            logprobs: [],
            sequence_number: this.nextSequenceNumber(),
          });
        }

        if (event.content.type === 'tool_use') {
          if (event.content.name) {
            const call = this.upsertFunctionCall(
              event.content.id,
              event.content.name,
            );
            return this.sseEvent('response.output_item.added', {
              type: 'response.output_item.added',
              output_index: call.outputIndex,
              sequence_number: this.nextSequenceNumber(),
              item: {
                type: 'function_call',
                id: this.functionItemId(call),
                call_id: call.callId,
                name: call.name,
                arguments: call.arguments,
                status: 'in_progress',
              },
            });
          }
          if (event.content.input_delta) {
            const call = this.resolveFunctionCallForDelta(event.content.id);
            call.arguments += event.content.input_delta;
            return this.sseEvent(
              'response.function_call_arguments.delta',
              {
                type: 'response.function_call_arguments.delta',
                output_index: call.outputIndex,
                item_id: this.functionItemId(call),
                call_id: call.callId,
                delta: event.content.input_delta,
                sequence_number: this.nextSequenceNumber(),
              },
            );
          }
        }
        return '';
      }

      case 'stop': {
        let result = '';
        result += this.sseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          output_index: 0,
          item_id: this.messageItemId,
          content_index: 0,
          text: this.accumulatedText,
          logprobs: [],
          sequence_number: this.nextSequenceNumber(),
        });
        result += this.sseEvent('response.content_part.done', {
          type: 'response.content_part.done',
          output_index: 0,
          item_id: this.messageItemId,
          content_index: 0,
          part: {
            type: 'output_text',
            text: this.accumulatedText,
            annotations: [],
            logprobs: [],
          },
          sequence_number: this.nextSequenceNumber(),
        });
        result += this.sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          output_index: 0,
          sequence_number: this.nextSequenceNumber(),
          item: {
            type: 'message',
            id: this.messageItemId,
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: this.accumulatedText,
                annotations: [],
                logprobs: [],
              },
            ],
          },
        });
        for (const call of this.functionCalls) {
          result += this.sseEvent('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            output_index: call.outputIndex,
            item_id: this.functionItemId(call),
            call_id: call.callId,
            arguments: call.arguments,
            sequence_number: this.nextSequenceNumber(),
          });
          result += this.sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: call.outputIndex,
            sequence_number: this.nextSequenceNumber(),
            item: {
              type: 'function_call',
              id: this.functionItemId(call),
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
              status: 'completed',
            },
          });
        }
        const usage = this.responsesUsage(event.usage);
        result += this.sseEvent('response.completed', {
          type: 'response.completed',
          sequence_number: this.nextSequenceNumber(),
          response: {
            id: this.id,
            object: 'response',
            model: this.model,
            status: 'completed',
            output: [
              {
                type: 'message',
                id: this.messageItemId,
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: this.accumulatedText,
                    annotations: [],
                    logprobs: [],
                  },
                ],
              },
              ...this.functionCalls.map((call) => ({
                type: 'function_call',
                id: this.functionItemId(call),
                call_id: call.callId,
                name: call.name,
                arguments: call.arguments,
                status: 'completed',
              })),
            ],
            usage,
          },
        });
        return result;
      }

      case 'error': {
        return this.sseEvent('error', {
          type: 'error',
          error: {
            message: event.error.message,
            code: event.error.code || null,
            type: event.error.type || 'api_error',
            status_code: event.error.status_code || null,
          },
          message: event.error.message,
          code: event.error.code || null,
          status_code: event.error.status_code || null,
          sequence_number: this.nextSequenceNumber(),
        });
      }
    }
  }

  private responsesUsage(usage: TokenUsage) {
    return {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens:
        usage.input_tokens + usage.output_tokens,
      ...(usage.cache_read_input_tokens
        ? {
            input_tokens_details: {
              cached_tokens: usage.cache_read_input_tokens,
            },
            prompt_tokens_details: {
              cached_tokens: usage.cache_read_input_tokens,
            },
            input_token_details: {
              cached_tokens: usage.cache_read_input_tokens,
            },
          }
        : {}),
    };
  }

  private upsertFunctionCall(
    callId: string | undefined,
    name: string,
  ): ResponsesFunctionCallState {
    const resolvedCallId =
      callId || this.activeFunctionCallId || `call_${this.outputIndex + 1}`;
    let call = this.functionCalls.find(
      (candidate) => candidate.callId === resolvedCallId,
    );
    if (!call) {
      this.outputIndex++;
      call = {
        outputIndex: this.outputIndex,
        callId: resolvedCallId,
        name,
        arguments: '',
      };
      this.functionCalls.push(call);
    } else if (name) {
      call.name = name;
    }
    this.activeFunctionCallId = call.callId;
    return call;
  }

  private resolveFunctionCallForDelta(
    callId: string | undefined,
  ): ResponsesFunctionCallState {
    const resolvedCallId = callId || this.activeFunctionCallId;
    const existing = resolvedCallId
      ? this.functionCalls.find((call) => call.callId === resolvedCallId)
      : undefined;
    if (existing) {
      this.activeFunctionCallId = existing.callId;
      return existing;
    }
    return this.upsertFunctionCall(
      resolvedCallId || `call_${this.outputIndex + 1}`,
      '',
    );
  }

  private functionItemId(call: ResponsesFunctionCallState): string {
    return `fc_${call.callId}`;
  }

  private nextSequenceNumber(): number {
    return this.sequenceNumber++;
  }

  private sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

// ═══════════════════════════════════════════════════════
// Messages SSE Serializer (Anthropic format)
// ═══════════════════════════════════════════════════════

export class MessagesStreamSerializer {
  private id = '';
  private model = '';
  private blockIndex = 0;

  serialize(event: CanonicalStreamEvent): string {
    switch (event.type) {
      case 'chat_metadata':
        return '';
      case 'raw_sse':
        return event.text;

      case 'tool_call_complete':
        return '';

      case 'start': {
        this.id = event.id || `msg_${Date.now()}`;
        this.model = event.model;
        let result = '';
        result += this.sseEvent('message_start', {
          type: 'message_start',
          message: {
            id: this.id,
            type: 'message',
            role: 'assistant',
            model: this.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        // Start first text content block
        result += this.sseEvent('content_block_start', {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: { type: 'text', text: '' },
        });
        return result;
      }

      case 'delta': {
        if (event.content.type === 'text') {
          return this.sseEvent('content_block_delta', {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'text_delta', text: event.content.text },
          });
        }

        if (event.content.type === 'tool_use') {
          if (event.content.name) {
            // Close previous block, start new tool_use block
            let result = this.sseEvent('content_block_stop', {
              type: 'content_block_stop',
              index: this.blockIndex,
            });
            this.blockIndex++;
            result += this.sseEvent('content_block_start', {
              type: 'content_block_start',
              index: this.blockIndex,
              content_block: {
                type: 'tool_use',
                id: event.content.id,
                name: event.content.name,
                input: {},
              },
            });
            return result;
          }
          if (event.content.input_delta) {
            return this.sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: {
                type: 'input_json_delta',
                partial_json: event.content.input_delta,
              },
            });
          }
        }
        return '';
      }

      case 'stop': {
        let result = '';
        // Close current block
        result += this.sseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: this.blockIndex,
        });
        // Message delta with stop reason and usage (including cache tokens)
        const deltaUsage: Record<string, unknown> = { output_tokens: event.usage.output_tokens };
        if (event.usage.cache_creation_input_tokens) {
          deltaUsage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
        }
        if (event.usage.cache_read_input_tokens) {
          deltaUsage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
        }
        result += this.sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: event.stop_reason || 'end_turn' },
          usage: deltaUsage,
        });
        // Message stop
        result += this.sseEvent('message_stop', {
          type: 'message_stop',
        });
        return result;
      }

      case 'error': {
        return this.sseEvent('error', {
          type: 'error',
          error: {
            type: event.error.type || 'api_error',
            message: event.error.message,
            code: event.error.code || null,
            status_code: event.error.status_code || null,
          },
        });
      }
    }
  }

  private sseEvent(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}
