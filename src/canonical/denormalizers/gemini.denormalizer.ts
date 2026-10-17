import {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalTool,
  RequestDenormalizer,
} from '../canonical.types';
import { geminiThinkingConfig, googleThinkingFromBody } from '../gemini-reasoning';

export class GeminiDenormalizer implements RequestDenormalizer {
  denormalize(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const systemMessages = canonical.messages.filter(
      (message) => message.role === 'system',
    );
    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: systemMessages.flatMap((message) =>
          this.messageToParts(message),
        ),
      };
    }

    body.contents = this.messagesToContents(
      canonical.messages.filter((message) => message.role !== 'system'),
    );

    const generationConfig = this.generationConfig(canonical, targetModel);
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const tools = this.tools(canonical);
    if (tools.length > 0) {
      body.tools = tools;
    }

    const toolConfig = this.toolConfig(canonical);
    if (toolConfig) {
      body.toolConfig = toolConfig;
    }

    this.applyNativePassthrough(canonical, body);
    return body;
  }

  private messagesToContents(
    messages: CanonicalMessage[],
  ): Record<string, unknown>[] {
    const contents: Record<string, unknown>[] = [];
    const functionNamesById = new Map<string, string>();
    for (const message of messages) {
      const role = message.role === 'assistant' ? 'model' : 'user';
      const parts = this.messageToParts(message, functionNamesById);
      if (parts.length === 0) continue;

      const previous = contents[contents.length - 1];
      if (previous?.role === role && Array.isArray(previous.parts)) {
        (previous.parts as unknown[]).push(...parts);
      } else {
        contents.push({ role, parts });
      }
    }
    return contents;
  }

  private messageToParts(
    message: CanonicalMessage,
    functionNamesById = new Map<string, string>(),
  ): Record<string, unknown>[] {
    if (typeof message.content === 'string') {
      return message.content ? [{ text: message.content }] : [];
    }
    return message.content.flatMap((block) =>
      this.blockToParts(block, functionNamesById),
    );
  }

  private blockToParts(
    block: CanonicalContentBlock,
    functionNamesById: Map<string, string>,
  ): Record<string, unknown>[] {
    switch (block.type) {
      case 'text':
        return block.text ? [{ text: block.text }] : [];
      case 'image':
        if (block.source.type === 'base64') {
          return [
            {
              inlineData: {
                mimeType: block.source.media_type,
                data: block.source.data,
              },
            },
          ];
        }
        return [
          {
            fileData: {
              mimeType: block.source.media_type,
              fileUri: block.source.data,
            },
          },
        ];
      case 'tool_use':
        if (block.id) {
          functionNamesById.set(block.id, block.name);
        }
        return [
          {
            functionCall: {
              name: block.name,
              args: block.input,
            },
          },
        ];
      case 'tool_result':
        return [
          {
            functionResponse: {
              name:
                functionNamesById.get(block.tool_use_id) || block.tool_use_id,
              response: this.functionResponsePayload(block.content),
            },
          },
        ];
      default:
        return [];
    }
  }

  private generationConfig(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> {
    const config: Record<string, unknown> = {};
    if (canonical.max_tokens !== undefined) {
      config.maxOutputTokens = canonical.max_tokens;
    }
    if (canonical.temperature !== undefined) {
      config.temperature = canonical.temperature;
    }
    if (canonical.top_p !== undefined) {
      config.topP = canonical.top_p;
    }
    if (canonical.stop?.length) {
      config.stopSequences = canonical.stop;
    }

    const format = canonical.response_format;
    if (format?.type === 'json_object' || format?.type === 'json_schema') {
      config.responseMimeType = 'application/json';
    }
    if (format?.json_schema?.schema) {
      config.responseSchema = format.json_schema.schema;
    }

    const thinkingConfig = this.thinkingConfig(canonical, targetModel);
    if (thinkingConfig && config.thinkingConfig === undefined) {
      config.thinkingConfig = thinkingConfig;
    }

    const rawGenerationConfig = this.rawObject(canonical, 'generationConfig');
    const rawSnakeGenerationConfig = this.rawObject(
      canonical,
      'generation_config',
    );
    const rawConfig = rawGenerationConfig || rawSnakeGenerationConfig;
    return rawConfig ? { ...rawConfig, ...config } : config;
  }

  private tools(canonical: CanonicalRequest): Record<string, unknown>[] {
    const tools: Record<string, unknown>[] = [];
    const functionDeclarations = (canonical.tools || [])
      .filter((tool) => tool.name)
      .map((tool) => this.functionDeclaration(tool));
    if (functionDeclarations.length > 0) {
      tools.push({ functionDeclarations });
    }

    if (this.requestsGoogleSearch(canonical)) {
      tools.push({ googleSearch: {} });
    }

    const rawTools = this.rawArray(canonical, 'tools');
    for (const rawTool of rawTools) {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
        continue;
      }
      const tool = rawTool as Record<string, unknown>;
      if (tool.googleSearch || tool.google_search) {
        tools.push(
          tool.googleSearch
            ? { googleSearch: tool.googleSearch }
            : { googleSearch: tool.google_search },
        );
      } else if (
        tool.functionDeclarations ||
        tool.googleSearchRetrieval ||
        tool.codeExecution ||
        tool.urlContext
      ) {
        tools.push(tool);
      } else if (String(tool.type || '').toLowerCase() === 'google_search') {
        tools.push({ googleSearch: {} });
      }
    }

    return this.uniqueTools(tools);
  }

  private functionDeclaration(tool: CanonicalTool): Record<string, unknown> {
    return {
      name: tool.name,
      description: tool.description || undefined,
      parameters: tool.parameters || { type: 'object', properties: {} },
    };
  }

  private toolConfig(canonical: CanonicalRequest): Record<string, unknown> | null {
    if (canonical.tool_choice === undefined) return null;
    if (canonical.tool_choice === 'auto') {
      return { functionCallingConfig: { mode: 'AUTO' } };
    }
    if (canonical.tool_choice === 'none') {
      return { functionCallingConfig: { mode: 'NONE' } };
    }
    if (canonical.tool_choice === 'required') {
      return { functionCallingConfig: { mode: 'ANY' } };
    }
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [canonical.tool_choice.name],
      },
    };
  }

  private requestsGoogleSearch(canonical: CanonicalRequest): boolean {
    const rawTools = this.rawArray(canonical, 'tools');
    return rawTools.some((rawTool) => {
      if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
        return false;
      }
      const type = String((rawTool as Record<string, unknown>).type || '').toLowerCase();
      return (
        type === 'web_search' ||
        type === 'web_search_preview' ||
        type.startsWith('web_search_') ||
        type === 'google_search'
      );
    });
  }

  private thinkingConfig(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown> | null {
    const body = this.asObject(canonical.metadata.raw_body) || {};
    const raw = googleThinkingFromBody(body)?.config ||
      (canonical.reasoning?.source === 'gemini.thinking_config' ? this.asObject(canonical.reasoning.thinking?.raw) : null) ||
      (canonical.thinking?.source === 'gemini.thinking_config' ? this.asObject(canonical.thinking.raw) : null);
    const intent = canonical.reasoning || (canonical.thinking ? {
      requested: true, source: canonical.thinking.source, raw: canonical.thinking.raw,
      budget_tokens: canonical.thinking.budget_tokens, thinking: canonical.thinking,
    } : undefined);
    return geminiThinkingConfig(intent, targetModel, raw || undefined) || null;
  }

  private functionResponsePayload(
    content: string | CanonicalContentBlock[],
  ): Record<string, unknown> {
    if (typeof content === 'string') return { output: content };
    return { output: this.blocksToText(content) };
  }

  private blocksToText(blocks: CanonicalContentBlock[]): string {
    return blocks
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'image') return `[${block.source.media_type}]`;
        if (block.type === 'tool_use') return JSON.stringify(block.input);
        if (block.type === 'tool_result') {
          return typeof block.content === 'string'
            ? block.content
            : this.blocksToText(block.content);
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  private applyNativePassthrough(
    canonical: CanonicalRequest,
    body: Record<string, unknown>,
  ): void {
    for (const key of ['safetySettings', 'cachedContent'] as const) {
      const value = this.rawValue(canonical, key);
      if (value !== undefined && body[key] === undefined) {
        body[key] = value;
      }
    }

    const rawToolConfig =
      this.rawObject(canonical, 'toolConfig') ||
      this.rawObject(canonical, 'tool_config');
    if (rawToolConfig && body.toolConfig === undefined) {
      body.toolConfig = rawToolConfig;
    }
  }

  private rawArray(canonical: CanonicalRequest, key: string): unknown[] {
    const raw = canonical.metadata.raw_body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const value = (raw as Record<string, unknown>)[key];
    return Array.isArray(value) ? value : [];
  }

  private rawObject(
    canonical: CanonicalRequest,
    key: string,
  ): Record<string, unknown> | null {
    const raw = canonical.metadata.raw_body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const value = (raw as Record<string, unknown>)[key];
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private rawValue(canonical: CanonicalRequest, key: string): unknown {
    const raw = canonical.metadata.raw_body;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    return (raw as Record<string, unknown>)[key];
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private uniqueTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
    let hasGoogleSearch = false;
    const result: Record<string, unknown>[] = [];
    for (const tool of tools) {
      if (tool.googleSearch || tool.google_search) {
        if (hasGoogleSearch) continue;
        hasGoogleSearch = true;
      }
      result.push(tool);
    }
    return result;
  }
}
