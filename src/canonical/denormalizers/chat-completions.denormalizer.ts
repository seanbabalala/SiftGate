import {
  RequestDenormalizer,
  CanonicalRequest,
  CanonicalResponse,
  CanonicalMessage,
  CanonicalContentBlock,
} from '../canonical.types';
import { nativeChatMetadata } from '../gemini-native-tools';
import { chatToolThoughtSignature } from '../tool-thought-signature';
import { toOpenAiChatResponseFormat } from '../structured-output';
import { toOpenAiChatReasoning } from '../reasoning-effort';

/**
 * Denormalizes Canonical → OpenAI Chat Completions format.
 *
 * Used in two directions:
 *   1. denormalize(): Canonical → request body to send to a chat/completions provider
 *   2. denormalizeResponse(): CanonicalResponse → response body to return to a chat/completions client
 */
export class ChatCompletionsDenormalizer implements RequestDenormalizer {
  // ===== Request: Canonical → chat/completions request body =====

  denormalize(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: targetModel,
      messages: canonical.messages.map((msg) =>
        this.denormalizeMessage(msg),
      ),
      stream: canonical.stream,
    };

    if (canonical.stream) {
      body.stream_options = { include_usage: true };
    }

    if (canonical.tools && canonical.tools.length > 0) {
      body.tools = canonical.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    if (canonical.tool_choice !== undefined) {
      body.tool_choice = this.denormalizeToolChoice(canonical.tool_choice);
    }

    if (canonical.max_tokens !== undefined)
      body.max_tokens = canonical.max_tokens;
    if (canonical.temperature !== undefined)
      body.temperature = canonical.temperature;
    if (canonical.top_p !== undefined) body.top_p = canonical.top_p;
    if (canonical.stop !== undefined) body.stop = canonical.stop;

    const responseFormat = toOpenAiChatResponseFormat(
      canonical.response_format,
    );
    if (responseFormat) body.response_format = responseFormat;

    Object.assign(body, toOpenAiChatReasoning(canonical.reasoning));

    return body;
  }

  private denormalizeMessage(msg: CanonicalMessage): Record<string, unknown> {
    // System message
    if (msg.role === 'system') {
      return {
        role: 'system',
        content: typeof msg.content === 'string'
          ? msg.content
          : this.blocksToText(msg.content),
      };
    }

    // Tool result message
    if (msg.role === 'tool') {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const toolResult = blocks.find((b) => b.type === 'tool_result');
      if (toolResult && toolResult.type === 'tool_result') {
        return {
          role: 'tool',
          tool_call_id: toolResult.tool_use_id,
          content:
            typeof toolResult.content === 'string'
              ? toolResult.content
              : this.blocksToText(toolResult.content),
        };
      }
      return {
        role: 'tool',
        tool_call_id: '',
        content: typeof msg.content === 'string' ? msg.content : '',
      };
    }

    // Assistant message — may contain tool_use blocks
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const textParts: string[] = [];
      const toolCalls: Record<string, unknown>[] = [];

      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
            ...chatToolThoughtSignature(block.thought_signature),
          });
        }
      }

      const result: Record<string, unknown> = {
        role: 'assistant',
        content: textParts.join('') || null,
      };

      if (toolCalls.length > 0) {
        result.tool_calls = toolCalls;
      }

      return result;
    }

    // User message — may have multimodal content
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        role: 'user',
        content: msg.content
          .filter((block) => block.type !== 'thinking' && block.type !== 'redacted_thinking')
          .map((block) => this.denormalizeContentBlock(block)),
      };
    }

    // Simple string content
    return {
      role: msg.role,
      content: typeof msg.content === 'string' ? msg.content : this.blocksToText(msg.content),
    };
  }

  private denormalizeContentBlock(
    block: CanonicalContentBlock,
  ): Record<string, unknown> {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };

      case 'image':
        if (block.source.type === 'base64') {
          return {
            type: 'image_url',
            image_url: {
              url: `data:${block.source.media_type};base64,${block.source.data}`,
            },
          };
        }
        return {
          type: 'image_url',
          image_url: { url: block.source.data },
        };

      default:
        return { type: 'text', text: JSON.stringify(block) };
    }
  }

  private denormalizeToolChoice(
    choice: NonNullable<CanonicalRequest['tool_choice']>,
  ): unknown {
    if (typeof choice === 'string') return choice;
    return {
      type: 'function',
      function: { name: choice.name },
    };
  }

  // ===== Response: CanonicalResponse → chat/completions response body =====

  denormalizeResponse(canonical: CanonicalResponse): Record<string, unknown> {
    const textParts: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];

    for (const block of canonical.content) {
      if (block.type === 'text') {
        textParts.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
          ...chatToolThoughtSignature(block.thought_signature),
        });
      }
    }

    const message: Record<string, unknown> = {
      role: 'assistant',
      content: textParts.join('') || null,
    };

    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls;
    }

    const usage: Record<string, unknown> = {
      prompt_tokens: canonical.usage.input_tokens,
      completion_tokens: canonical.usage.output_tokens,
      total_tokens:
        canonical.usage.input_tokens + canonical.usage.output_tokens,
    };
    if (canonical.usage.cache_read_input_tokens) {
      usage.prompt_tokens_details = {
        cached_tokens: canonical.usage.cache_read_input_tokens,
      };
    }

    return {
      id: `chatcmpl-${canonical.id}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: canonical.model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.mapStopReason(canonical.stop_reason),
        },
      ],
      usage,
      ...nativeChatMetadata({ ...canonical.native_chat_metadata }),
    };
  }

  private mapStopReason(reason: string): string {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'stop';
    }
  }

  private blocksToText(blocks: CanonicalContentBlock[]): string {
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
  }
}
