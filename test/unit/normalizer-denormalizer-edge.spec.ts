/**
 * Normalizer + Denormalizer edge case tests.
 *
 * Extends the existing coverage with edge cases:
 * - Messages denormalizer: consecutive user merging, tool_choice, tool_result with array content
 * - Responses denormalizer: assistant with mixed text+tool_use, image denormalization
 * - Chat completions denormalizer: base64 image, tool-only assistant (no text), system blocks-to-text
 * - Normalizer edge cases: null content, function role, tool_result with mixed blocks, tool_choice objects
 */

import { ChatCompletionsNormalizer } from '../../src/canonical/normalizers/chat-completions.normalizer';
import { ResponsesNormalizer } from '../../src/canonical/normalizers/responses.normalizer';
import { MessagesNormalizer } from '../../src/canonical/normalizers/messages.normalizer';
import { ChatCompletionsDenormalizer } from '../../src/canonical/denormalizers/chat-completions.denormalizer';
import { ResponsesDenormalizer } from '../../src/canonical/denormalizers/responses.denormalizer';
import { MessagesDenormalizer } from '../../src/canonical/denormalizers/messages.denormalizer';
import { CanonicalRequest, CanonicalResponse, Tier } from '../../src/canonical/canonical.types';

const headers = { 'content-type': 'application/json' };

function makeCanonicalRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: false,
    metadata: { source_format: 'chat_completions', original_model: 'gpt-4', raw_headers: {} },
    ...overrides,
  };
}

function makeCanonicalResponse(overrides: Partial<CanonicalResponse> = {}): CanonicalResponse {
  return {
    id: 'test_id', content: [{ type: 'text', text: 'Hello!' }],
    stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
    model: 'gpt-4',
    routing: { tier: 'simple' as Tier, node: 'test', latency_ms: 100, score: 0.1, is_fallback: false },
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// ChatCompletions Normalizer — edge cases
// ═══════════════════════════════════════════════════════════

describe('ChatCompletionsNormalizer — edge cases', () => {
  const normalizer = new ChatCompletionsNormalizer();

  it('should handle null content as empty string', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: null }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('');
  });

  it('should handle undefined content as empty string', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user' }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('');
  });

  it('should normalize function role as tool', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'function', name: 'get_weather', content: '22°C' }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].role).toBe('tool');
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('tool_result');
    // function role goes through tool handler which uses tool_call_id (not name)
    expect(blocks[0].content).toBe('22°C');
  });

  it('should handle tool_choice as object {type:"function", function:{name:"..."}}', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Weather?' }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.tool_choice).toEqual({ name: 'get_weather' });
  });

  it('should handle stop as string', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: 'END',
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.stop).toEqual(['END']);
  });

  it('should handle stop as array', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['END', 'STOP'],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.stop).toEqual(['END', 'STOP']);
  });

  it('should normalize assistant with tool_calls AND text content', () => {
    const body = {
      model: 'gpt-4',
      messages: [{
        role: 'assistant',
        content: 'Let me search for that.',
        tool_calls: [
          { id: 'call_1', function: { name: 'search', arguments: '{"q":"test"}' } },
        ],
      }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0]).toEqual({ type: 'text', text: 'Let me search for that.' });
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[1].name).toBe('search');
  });

  it('should normalize content array with unknown type as JSON text', () => {
    const body = {
      model: 'gpt-4',
      messages: [{
        role: 'user',
        content: [
          { type: 'custom_widget', data: { foo: 'bar' } },
        ],
      }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('custom_widget');
  });

  it('should normalize content array with image_url as URL', () => {
    const body = {
      model: 'gpt-4',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
        ],
      }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.type).toBe('url');
    expect(blocks[0].source.data).toBe('https://example.com/photo.jpg');
  });

  it('should handle numeric content as String conversion', () => {
    const body = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 42 }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('42');
  });
});

describe('ResponsesNormalizer — edge cases', () => {
  const normalizer = new ResponsesNormalizer();

  it('should skip item_reference type silently', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        { type: 'item_reference', id: 'ref_123' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');
  });

  it('should normalize input_image with data URI', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        { type: 'input_image', image_url: 'data:image/png;base64,abc123' },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.type).toBe('base64');
    expect(blocks[0].source.data).toBe('abc123');
  });

  it('should normalize input_image with URL string', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        { type: 'input_image', image_url: 'https://example.com/img.jpg' },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.type).toBe('url');
  });

  it('should normalize function_call in content array', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message', role: 'assistant',
          content: [
            { type: 'output_text', text: 'Let me check.' },
            { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"test"}' },
          ],
        },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('tool_use');
    expect(blocks[1].name).toBe('search');
  });

  it('should handle tool_choice string', () => {
    const body = {
      model: 'gpt-4.1',
      input: 'Hi',
      tool_choice: 'required',
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.tool_choice).toBe('required');
  });

  it('should normalize message with non-array content as string', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        { type: 'message', role: 'user', content: 'Plain string content' },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('Plain string content');
  });

  it('should normalize function_call_output in input array', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        { type: 'function_call_output', call_id: 'call_1', output: 'Result text' },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('call_1');
    expect(blocks[0].content).toBe('Result text');
  });

  it('should normalize function_call in content array', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message', role: 'assistant',
          content: [
            { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"test"}' },
          ],
        },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('tool_use');
    expect(blocks[0].name).toBe('search');
  });

  it('should normalize function_call_output in content array', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message', role: 'user',
          content: [
            { type: 'function_call_output', call_id: 'call_1', output: 'Tool result' },
          ],
        },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('tool_result');
  });

  it('should normalize image_url as string in content array', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message', role: 'user',
          content: [
            { type: 'input_image', image_url: 'data:image/jpeg;base64,def456' },
          ],
        },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('image');
    expect(blocks[0].source.type).toBe('base64');
    expect(blocks[0].source.data).toBe('def456');
  });

  it('should handle default content type with text property', () => {
    const body = {
      model: 'gpt-4.1',
      input: [
        {
          type: 'message', role: 'user',
          content: [
            { type: 'unknown_type', text: 'Fallback text' },
          ],
        },
      ],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('Fallback text');
  });

  it('should normalize string input as simple user message', () => {
    const body = {
      model: 'gpt-4.1',
      input: 'Simple string input',
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('Simple string input');
  });
});

describe('MessagesNormalizer — edge cases', () => {
  const normalizer = new MessagesNormalizer();

  it('should normalize tool_result with array of mixed text+image blocks', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'Screenshot captured' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        }],
      }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('tool_result');
    const inner = blocks[0].content as any[];
    expect(inner).toHaveLength(2);
    expect(inner[0].type).toBe('text');
    expect(inner[1].type).toBe('image');
  });

  it('should handle tool_choice { type: "none" }', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'none' },
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.tool_choice).toBe('none');
  });

  it('should handle tool_choice { type: "tool", name: "..." }', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
      tool_choice: { type: 'tool', name: 'get_weather' },
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.tool_choice).toEqual({ name: 'get_weather' });
  });

  it('should handle non-array content as string coercion', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 12345 }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    expect(result.messages[0].content).toBe('12345');
  });

  it('should handle unknown content block types as JSON text', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'unknown_type', data: 'test' }] }],
      stream: false,
    };
    const result = normalizer.normalize(body, headers);
    const blocks = result.messages[0].content as any[];
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toContain('unknown_type');
  });

  it('should tolerate malformed content blocks from compacted desktop history', () => {
    const body = {
      model: 'claude-3-opus',
      max_tokens: 1024,
      system: [{ type: 'text', text: 'keep' }, null, {}],
      messages: [
        null,
        {
          role: 'user',
          content: [
            null,
            'plain text',
            7,
            {},
            { type: 'text', text: null },
            { type: 'text', text: 123 },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_1',
              content: [null, 'tool text', {}],
            },
          ],
        },
      ],
      stream: false,
    };

    const result = normalizer.normalize(body, headers);

    expect(result.messages[0]).toEqual({ role: 'system', content: 'keep' });
    expect(result.messages[1]).toEqual({ role: 'user', content: '' });
    const blocks = result.messages[2].content as any[];
    expect(blocks).toEqual([
      { type: 'text', text: 'plain text' },
      { type: 'text', text: '7' },
      { type: 'text', text: '{}' },
      { type: 'text', text: '' },
      { type: 'text', text: '123' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'tool text' },
          { type: 'text', text: '{}' },
        ],
      },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════
// Messages Denormalizer — edge cases
// ═══════════════════════════════════════════════════════════

describe('MessagesDenormalizer — edge cases', () => {
  const denorm = new MessagesDenormalizer();

  it('should merge consecutive user string messages', () => {
    const canonical = makeCanonicalRequest({
      messages: [
        { role: 'user', content: 'First' },
        { role: 'user', content: 'Second' },
      ],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    // Should be merged into one user message
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    // Merged as array of text blocks
    expect(Array.isArray(msgs[0].content)).toBe(true);
    expect(msgs[0].content).toHaveLength(2);
  });

  it('should merge consecutive user array messages', () => {
    const canonical = makeCanonicalRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Part 1' }] },
        { role: 'user', content: [{ type: 'text', text: 'Part 2' }] },
      ],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toHaveLength(2);
  });

  it('should merge tool_result into preceding user message', () => {
    const canonical = makeCanonicalRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'User msg' }] },
        { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Result' }] },
      ],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    // tool_result should merge into the user message
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content.length).toBe(2);
  });

  it('should preserve tool_choice "none" rather than enabling tools', () => {
    const canonical = makeCanonicalRequest({ tool_choice: 'none' });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.tool_choice).toEqual({ type: 'none' });
  });

  it('should denormalize assistant with string content as text block array', () => {
    const canonical = makeCanonicalRequest({
      messages: [{ role: 'assistant', content: 'I am helpful.' }],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    expect(msgs[0].content).toEqual([{ type: 'text', text: 'I am helpful.' }]);
  });

  it('should denormalize response with tool_use stop reason', () => {
    const canonical = makeCanonicalResponse({
      content: [
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
      ],
      stop_reason: 'tool_use',
    });
    const result = denorm.denormalizeResponse(canonical);
    expect(result.stop_reason).toBe('tool_use');
    expect((result.content as any[])[0].type).toBe('tool_use');
  });

  it('should map unknown stop_reason to end_turn', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'unknown_reason' as any });
    const result = denorm.denormalizeResponse(canonical);
    expect(result.stop_reason).toBe('end_turn');
  });
});

// ═══════════════════════════════════════════════════════════
// Responses Denormalizer — edge cases
// ═══════════════════════════════════════════════════════════

describe('ResponsesDenormalizer — edge cases', () => {
  const denorm = new ResponsesDenormalizer();

  it('should denormalize assistant message with mixed text+tool_use as separate output items', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search...' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
        ],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    // Text part as message item
    const messageItem = input.find((i: any) => i.type === 'message' && i.role === 'assistant');
    expect(messageItem).toBeDefined();
    expect(messageItem.content[0].type).toBe('output_text');
    // Tool call as separate function_call item
    const fcItem = input.find((i: any) => i.type === 'function_call');
    expect(fcItem).toBeDefined();
    expect(fcItem.name).toBe('search');
  });

  it('should denormalize base64 image as data URI', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    const content = input[0].content as any[];
    expect(content[0].type).toBe('input_image');
    expect(content[0].image_url).toBe('data:image/png;base64,abc123');
  });

  it('should denormalize URL image', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'url', media_type: 'image/jpeg', data: 'https://example.com/img.jpg' },
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    const content = input[0].content as any[];
    expect(content[0].image_url).toBe('https://example.com/img.jpg');
  });

  it('should handle tool_choice as object', () => {
    const canonical = makeCanonicalRequest({ tool_choice: { name: 'search' } });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    expect(result.tool_choice).toEqual({ type: 'function', name: 'search' });
  });

  it('should denormalize response with only tool_use (no text)', () => {
    const canonical = makeCanonicalResponse({
      content: [
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
      ],
    });
    const result = denorm.denormalizeResponse(canonical);
    const output = result.output as any[];
    // No message item (no text), just function_call
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('function_call');
  });
});

// ═══════════════════════════════════════════════════════════
// ChatCompletions Denormalizer — edge cases
// ═══════════════════════════════════════════════════════════

describe('ChatCompletionsDenormalizer — edge cases', () => {
  const denorm = new ChatCompletionsDenormalizer();

  it('should denormalize base64 image as data URI', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const content = (result.messages as any[])[0].content;
    expect(content[0].type).toBe('image_url');
    expect(content[0].image_url.url).toBe('data:image/png;base64,abc123');
  });

  it('should denormalize assistant tool_use only (no text) with null content', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
        ],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const msg = (result.messages as any[])[0];
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
  });

  it('should denormalize system message with content blocks as text', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'system',
        content: [
          { type: 'text', text: 'You are' },
          { type: 'text', text: ' helpful.' },
        ],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const msg = (result.messages as any[])[0];
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('You are helpful.');
  });

  it('should denormalize tool result with no tool_result block gracefully', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'tool',
        content: 'Plain text result',
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const msg = (result.messages as any[])[0];
    expect(msg.role).toBe('tool');
  });

  it('should map stop_sequence to stop in response', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'stop_sequence' });
    const result = denorm.denormalizeResponse(canonical);
    expect((result.choices as any[])[0].finish_reason).toBe('stop');
  });

  it('should denormalize tool_choice object with name', () => {
    const canonical = makeCanonicalRequest({ tool_choice: { name: 'get_weather' } });
    const result = denorm.denormalize(canonical, 'gpt-4');
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
  });

  it('should JSON.stringify unknown content block types in denormalizeContentBlock', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'user',
        content: [{ type: 'audio', data: 'base64audio' } as any],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const content = (result.messages as any[])[0].content;
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('audio');
  });

  it('should map unknown stop_reason to stop', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'some_unknown_reason' as any });
    const result = denorm.denormalizeResponse(canonical);
    expect((result.choices as any[])[0].finish_reason).toBe('stop');
  });

  it('should map max_tokens to length in response', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'max_tokens' });
    const result = denorm.denormalizeResponse(canonical);
    expect((result.choices as any[])[0].finish_reason).toBe('length');
  });

  it('should map tool_use to tool_calls in response', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'tool_use' });
    const result = denorm.denormalizeResponse(canonical);
    expect((result.choices as any[])[0].finish_reason).toBe('tool_calls');
  });

  it('should pass through temperature/top_p/stop', () => {
    const canonical = makeCanonicalRequest({
      temperature: 0.7,
      top_p: 0.9,
      stop: ['END', 'STOP'],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.stop).toEqual(['END', 'STOP']);
  });

  it('should handle tool_result with array content → blocksToText', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [
            { type: 'text', text: 'Result line 1' },
            { type: 'text', text: 'Result line 2' },
          ],
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const msg = (result.messages as any[])[0];
    expect(msg.role).toBe('tool');
    expect(msg.content).toBe('Result line 1Result line 2');
  });

  it('should denormalize assistant with string content', () => {
    const canonical = makeCanonicalRequest({
      messages: [{ role: 'assistant', content: 'I am a string' }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4');
    const msg = (result.messages as any[])[0];
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('I am a string');
  });
});

// ═══════════════════════════════════════════════════════════
// MessagesDenormalizer — additional edge cases
// ═══════════════════════════════════════════════════════════

describe('MessagesDenormalizer — additional edge cases', () => {
  const denorm = new MessagesDenormalizer();

  it('should denormalize tool_choice "auto" → { type: "auto" }', () => {
    const canonical = makeCanonicalRequest({ tool_choice: 'auto' });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.tool_choice).toEqual({ type: 'auto' });
  });

  it('should denormalize tool_choice "required" → { type: "any" }', () => {
    const canonical = makeCanonicalRequest({ tool_choice: 'required' });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.tool_choice).toEqual({ type: 'any' });
  });

  it('should denormalize unknown tool_choice string → { type: "auto" }', () => {
    const canonical = makeCanonicalRequest({ tool_choice: 'something_weird' as any });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.tool_choice).toEqual({ type: 'auto' });
  });

  it('should JSON.stringify unknown block types in denormalizeContentBlocks', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'assistant',
        content: [{ type: 'custom_block', data: 'test' } as any],
      }],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    expect(msgs[0].content[0].type).toBe('text');
    expect(msgs[0].content[0].text).toContain('custom_block');
  });

  it('should join multiple system messages with newline', () => {
    const canonical = makeCanonicalRequest({
      messages: [
        { role: 'system', content: 'System 1' },
        { role: 'system', content: 'System 2' },
        { role: 'user', content: 'Hello' },
      ],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.system).toBe('System 1\nSystem 2');
  });

  it('should handle response with mixed text + tool_use content', () => {
    const canonical = makeCanonicalResponse({
      content: [
        { type: 'text', text: 'Let me search...' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'test' } },
      ],
    });
    const result = denorm.denormalizeResponse(canonical);
    const content = result.content as any[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('tool_use');
  });

  it('should map max_tokens stop reason', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'max_tokens' });
    const result = denorm.denormalizeResponse(canonical);
    expect(result.stop_reason).toBe('max_tokens');
  });

  it('should map stop_sequence stop reason', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'stop_sequence' });
    const result = denorm.denormalizeResponse(canonical);
    expect(result.stop_reason).toBe('stop_sequence');
  });

  it('should map unknown stop reason to end_turn', () => {
    const canonical = makeCanonicalResponse({ stop_reason: 'unknown_reason' as any });
    const result = denorm.denormalizeResponse(canonical);
    expect(result.stop_reason).toBe('end_turn');
  });

  it('should recursively denormalize tool_result with nested content blocks', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'assistant',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [
            { type: 'text', text: 'Nested result' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
          ],
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    const msgs = result.messages as any[];
    const toolResult = msgs[0].content[0];
    expect(toolResult.type).toBe('tool_result');
    expect(Array.isArray(toolResult.content)).toBe(true);
    expect(toolResult.content[0].type).toBe('text');
    expect(toolResult.content[1].type).toBe('image');
  });

  it('should pass through temperature and top_p', () => {
    const canonical = makeCanonicalRequest({
      temperature: 0.5,
      top_p: 0.8,
      stop: ['STOP'],
    });
    const result = denorm.denormalize(canonical, 'claude-3-opus');
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.8);
    expect(result.stop_sequences).toEqual(['STOP']);
  });
});

// ═══════════════════════════════════════════════════════════
// ResponsesDenormalizer — additional edge cases
// ═══════════════════════════════════════════════════════════

describe('ResponsesDenormalizer — additional edge cases', () => {
  const normalizer = new ResponsesNormalizer();
  const denorm = new ResponsesDenormalizer();

  it('should JSON.stringify unknown content block type in denormalizeContent', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'user',
        content: [{ type: 'audio', data: 'base64audio' } as any],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    expect(input[0].content[0].type).toBe('input_text');
    expect(input[0].content[0].text).toContain('audio');
  });

  it('should denormalize system message with content blocks via blocksToText', () => {
    const canonical = makeCanonicalRequest({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'You are' }, { type: 'text', text: ' helpful.' }] },
        { role: 'user', content: 'Hi' },
      ],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    expect(result.instructions).toBe('You are helpful.');
  });

  it('should pass tool_choice string through as-is', () => {
    const canonical = makeCanonicalRequest({ tool_choice: 'required' });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    expect(result.tool_choice).toBe('required');
  });

  it('should denormalize assistant string content as output_text', () => {
    const canonical = makeCanonicalRequest({
      messages: [{ role: 'assistant', content: 'Plain string' }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    expect(input[0].type).toBe('message');
    expect(input[0].role).toBe('assistant');
    expect(input[0].content[0].type).toBe('output_text');
    expect(input[0].content[0].text).toBe('Plain string');
  });

  it('should pass through temperature, top_p, and max_output_tokens', () => {
    const canonical = makeCanonicalRequest({
      temperature: 0.3,
      top_p: 0.95,
      max_tokens: 500,
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    expect(result.temperature).toBe(0.3);
    expect(result.top_p).toBe(0.95);
    expect(result.max_output_tokens).toBe(500);
  });

  it('should denormalize tool_choice object with name', () => {
    const canonical = makeCanonicalRequest({ tool_choice: { name: 'search' } });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    expect(result.tool_choice).toEqual({ type: 'function', name: 'search' });
  });

  it('should denormalize tool_result blocks → function_call_output items', () => {
    const canonical = makeCanonicalRequest({
      messages: [{
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [{ type: 'text', text: 'Result text' }],
        }],
      }],
    });
    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];
    expect(input[0].type).toBe('function_call_output');
    expect(input[0].call_id).toBe('call_1');
    expect(input[0].output).toBe('Result text');
  });

  it('should preserve Responses function_call before its function_call_output', () => {
    const canonical = normalizer.normalize(
      {
        model: 'gpt-4.1',
        input: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'shell',
            arguments: '{"command":"pwd"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '/workspace/example-project',
          },
        ],
        stream: true,
      },
      headers,
    );

    const result = denorm.denormalize(canonical, 'gpt-4.1');
    const input = result.input as any[];

    expect(input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'shell',
        arguments: '{"command":"pwd"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '/workspace/example-project',
      },
    ]);
  });

  it('should handle response with only function calls (no text)', () => {
    const canonical = makeCanonicalResponse({
      content: [
        { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'test' } },
        { type: 'tool_use', id: 'call_2', name: 'fetch', input: { url: 'http://example.com' } },
      ],
    });
    const result = denorm.denormalizeResponse(canonical);
    const output = result.output as any[];
    // No message item, just 2 function_calls
    expect(output).toHaveLength(2);
    expect(output[0].type).toBe('function_call');
    expect(output[1].type).toBe('function_call');
  });
});
