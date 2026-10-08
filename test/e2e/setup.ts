import { AbstractLoader } from '@nestjs/serve-static/dist/loaders/abstract.loader';
import { ExpressLoader } from '@nestjs/serve-static/dist/loaders/express.loader';
import { SERVE_STATIC_MODULE_OPTIONS } from '@nestjs/serve-static/dist/serve-static.constants';
/**
 * E2E test infrastructure — shared setup for all E2E test files.
 *
 * Core strategy: boot the real AppModule, mock only `global.fetch`
 * (the single exit point in ProviderClientService.sendRequest()),
 * use SQLite :memory: for a clean DB each test file.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { json, raw, urlencoded } from 'express';
import helmet from 'helmet';
import * as path from 'path';
import * as request from 'supertest';
import { createHash } from 'crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CallLog,
  GatewayApiKey,
  ManagementAuditEvent,
  PromptTemplate,
  RouteDecisionLog,
  RouteFeedback,
  Workspace,
  WorkspaceInvitation,
  WorkspaceMembership,
} from '../../src/database/entities';
import { DEFAULT_WORKSPACE_ID } from '../../src/workspaces/workspace.constants';
import type { Repository } from 'typeorm';

// ── Constants ──────────────────────────────────────────────

export const API_KEY = 'e2e-test-key-1';
export const API_KEY_2 = 'e2e-test-key-2';
export const LEGACY_API_KEY = 'e2e-legacy-key';
export const FIXTURE_PATH = path.resolve(__dirname, 'fixtures', 'gateway.e2e.yaml');

// ── FetchMock ──────────────────────────────────────────────

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  rawBody?: Buffer;
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response>;

export class FetchMock {
  private originalFetch: typeof globalThis.fetch | null = null;
  private handler: FetchHandler | null = null;
  calls: FetchCall[] = [];

  install(): void {
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          headers[k] = v;
        }
      }
      let body: Record<string, unknown> = {};
      let rawBody: Buffer | undefined;
      if (init?.body && typeof init.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = { _raw: init.body };
        }
      } else if (init?.body instanceof Buffer) {
        rawBody = init.body;
        body = { _raw_bytes: init.body.length };
      }

      this.calls.push({ url, method, headers, body, rawBody });

      if (this.handler) {
        return this.handler(url, init!);
      }

      // Default handler — auto-detect protocol from URL
      return this.defaultHandler(url, body, method);
    };
  }

  reset(): void {
    this.calls = [];
    this.handler = null;
  }

  restore(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  setHandler(fn: FetchHandler): void {
    this.handler = fn;
  }

  /** Return a specific HTTP error status for all requests */
  setError(status: number, message = 'Mock error'): void {
    this.handler = async () =>
      new Response(JSON.stringify({ error: { message, type: 'error' } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
  }

  /** Return an SSE stream for chat_completions format */
  setStreamingChatResponse(chunks: string[]): void {
    this.handler = async () => {
      const encoder = new TextEncoder();
      const lines: string[] = [];

      for (const chunk of chunks) {
        const data = {
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          model: 'gpt-4o',
          choices: [{
            index: 0,
            delta: { content: chunk },
            finish_reason: null,
          }],
        };
        lines.push(`data: ${JSON.stringify(data)}\n\n`);
      }

      // Final chunk with finish_reason + usage
      lines.push(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        model: 'gpt-4o',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`);
      lines.push('data: [DONE]\n\n');

      const body = new ReadableStream({
        start(controller) {
          for (const line of lines) {
            controller.enqueue(encoder.encode(line));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  }

  /** Return an SSE stream for messages (Anthropic) format */
  setStreamingMessagesResponse(text: string): void {
    this.handler = async () => {
      const encoder = new TextEncoder();
      const lines: string[] = [];

      lines.push(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: 'msg-test', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [], usage: { input_tokens: 10, output_tokens: 0 } },
      })}\n\n`);

      lines.push(`event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}\n\n`);

      lines.push(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      })}\n\n`);

      lines.push(`event: content_block_stop\ndata: ${JSON.stringify({
        type: 'content_block_stop',
        index: 0,
      })}\n\n`);

      lines.push(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      })}\n\n`);

      lines.push(`event: message_stop\ndata: ${JSON.stringify({
        type: 'message_stop',
      })}\n\n`);

      const body = new ReadableStream({
        start(controller) {
          for (const line of lines) {
            controller.enqueue(encoder.encode(line));
          }
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    };
  }

  // ── Default Handler ──

  private defaultHandler(url: string, body: Record<string, unknown>, method: string): Response {
    if (url.includes('/v1/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        object: 'list',
        model: (body.model as string) || 'text-embedding-3-small',
        data: inputs.map((_item, index) => ({
          object: 'embedding',
          index,
          embedding: [0.01 + index, 0.02 + index, 0.03 + index],
        })),
        usage: { prompt_tokens: inputs.length * 4, total_tokens: inputs.length * 4 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/rerank')) {
      const documents = Array.isArray(body.documents) ? body.documents : [];
      const topN = typeof body.top_n === 'number' ? body.top_n : documents.length;
      return new Response(JSON.stringify({
        id: 'rerank-e2e-test',
        object: 'rerank',
        model: (body.model as string) || 'rerank-english-v3',
        results: documents
          .map((_item, index) => ({
            index,
            relevance_score: Number((1 - index * 0.1).toFixed(2)),
          }))
          .slice(0, topN),
        usage: { prompt_tokens: documents.length * 8, total_tokens: documents.length * 8 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/images/generations')) {
      return new Response(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        model: (body.model as string) || 'gpt-image-1',
        data: [{ url: 'https://mock-upstream.test/generated.png' }],
        usage: { prompt_tokens: 6, total_tokens: 6 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/images/edits')) {
      return new Response(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        model: (body.model as string) || 'gpt-image-1',
        data: [{ b64_json: 'ZmFrZS1pbWFnZQ==' }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/images/variations')) {
      return new Response(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        model: (body.model as string) || 'gpt-image-1',
        data: [{ b64_json: 'dmFyaWF0aW9u' }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/audio/transcriptions')) {
      return new Response(JSON.stringify({
        text: 'mock transcription',
        model: (body.model as string) || 'gpt-4o-mini-transcribe',
        usage: { input_tokens: 12, output_tokens: 3 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/audio/translations')) {
      return new Response(JSON.stringify({
        text: 'mock translation',
        model: (body.model as string) || 'gpt-4o-mini-transcribe',
        usage: { input_tokens: 10, output_tokens: 4 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/audio/speech')) {
      return new Response(Buffer.from('mock-mp3-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }

    if (url.includes('/v1/videos/generations')) {
      return new Response(JSON.stringify({
        id: 'vid-e2e-job-1',
        object: 'video.generation.job',
        model: (body.model as string) || 'veo-3-preview',
        status: 'queued',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/videos/') && url.includes('/content')) {
      return new Response(Buffer.from('mock-video-bytes'), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      });
    }

    if (url.includes('/v1/videos/') && url.includes('/cancel')) {
      return new Response(JSON.stringify({
        id: url.split('/').slice(-2, -1)[0],
        object: 'video.generation.job',
        status: 'cancelled',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/videos/')) {
      return new Response(JSON.stringify({
        id: url.split('/').pop(),
        object: 'video.generation.job',
        model: 'veo-3-preview',
        status: 'completed',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/batches') && url.includes('/cancel')) {
      return new Response(JSON.stringify({
        id: url.split('/').slice(-2, -1)[0],
        object: 'batch',
        endpoint: '/v1/chat/completions',
        input_file_id: 'file-batch-input',
        output_file_id: 'file-batch-output',
        status: 'cancelled',
        request_counts: { total: 2, completed: 1, failed: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/batches') && method === 'POST') {
      return new Response(JSON.stringify({
        id: 'batch-e2e-1',
        object: 'batch',
        endpoint: body.endpoint || '/v1/chat/completions',
        input_file_id: body.input_file_id || 'file-batch-input',
        output_file_id: 'file-batch-output',
        error_file_id: 'file-batch-errors',
        completion_window: body.completion_window || '24h',
        status: 'in_progress',
        request_counts: { total: 2, completed: 1, failed: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/batches/')) {
      return new Response(JSON.stringify({
        id: url.split('/').pop(),
        object: 'batch',
        endpoint: '/v1/chat/completions',
        input_file_id: 'file-batch-input',
        output_file_id: 'file-batch-output',
        error_file_id: 'file-batch-errors',
        status: 'completed',
        request_counts: { total: 2, completed: 2, failed: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.includes('/v1/files/') && url.includes('/content')) {
      return new Response('{"custom_id":"one","response":{"status_code":200}}\n', {
        status: 200,
        headers: { 'Content-Type': 'application/jsonl' },
      });
    }

    if (url.includes('/v1/messages')) {
      return new Response(JSON.stringify({
        id: 'msg-e2e-test',
        type: 'message',
        role: 'assistant',
        model: (body.model as string) || 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'Mock Claude response' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Default: chat_completions format (also covers /v1/responses-like URLs)
    return new Response(JSON.stringify({
      id: 'chatcmpl-e2e-test',
      object: 'chat.completion',
      model: (body.model as string) || 'gpt-4o',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Mock OpenAI response' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ── Harness ────────────────────────────────────────────────

export interface E2EHarness {
  app: INestApplication;
  agent: request.Agent;
  fetchMock: FetchMock;
  callLogRepo: Repository<CallLog>;
  routeDecisionRepo: Repository<RouteDecisionLog>;
  routeFeedbackRepo: Repository<RouteFeedback>;
  workspaceRepo: Repository<Workspace>;
  membershipRepo: Repository<WorkspaceMembership>;
  invitationRepo: Repository<WorkspaceInvitation>;
  managementAuditRepo: Repository<ManagementAuditEvent>;
  promptTemplateRepo: Repository<PromptTemplate>;
  close: () => Promise<void>;
}

export async function createE2EHarness(configPath = FIXTURE_PATH, options: { frontendRoot?: string } = {}): Promise<E2EHarness> {
  // Set config path BEFORE module resolution
  process.env.GATEWAY_CONFIG_PATH = configPath;

  // Lazy-import AppModule so the config path is read at require time
  const { AppModule } = await import('../../src/app.module');
  const { PluginLoaderService } = await import('../../src/plugins/plugin-loader.service');
  const { setupOpenApi } = await import('../../src/openapi/setup-openapi');

  const fetchMock = new FetchMock();
  fetchMock.install();

  const builder = Test.createTestingModule({
    imports: [AppModule],
  })
    // Override PluginLoaderService to skip auto-discovery of plugins/
    .overrideProvider(PluginLoaderService)
    .useValue({ onModuleInit: () => {} });
  // TestingModule has no adapter during provider construction, so ServeStatic otherwise chooses NoopLoader.
  // Browser tests opt in with an explicit isolated build directory; API-only tests keep their old behavior.
  if (options.frontendRoot) {
    builder.overrideProvider(AbstractLoader).useValue(new ExpressLoader());
    builder.overrideProvider(SERVE_STATIC_MODULE_OPTIONS).useValue([{ rootPath: options.frontendRoot, exclude: ['/api{/*path}', '/v1{/*path}', '/mcp{/*path}', '/live{/*path}', '/health{/*path}', '/ready{/*path}', '/cluster{/*path}'] }]);
  }
  const moduleFixture: TestingModule = await builder.compile();

  const app = moduleFixture.createNestApplication();

  // Replicate main.ts middleware exactly
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );
  setupOpenApi(app);
  app.use(helmet());
  app.enableCors({ origin: true, credentials: true });
  const mediaBodyTypes = [
    'multipart/form-data',
    'application/octet-stream',
    'audio/*',
    'image/*',
  ];
  for (const route of [
    '/v1/images/generations',
    '/v1/images/edits',
    '/v1/images/variations',
    '/v1/audio/transcriptions',
    '/v1/audio/translations',
    '/v1/audio/speech',
  ]) {
    app.use(route, raw({ type: mediaBodyTypes, limit: '1mb' }));
  }
  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  await app.init();

  const apiKeyRepo = app.get(getRepositoryToken(GatewayApiKey));
  const callLogRepo = app.get<Repository<CallLog>>(getRepositoryToken(CallLog));
  const routeDecisionRepo = app.get<Repository<RouteDecisionLog>>(
    getRepositoryToken(RouteDecisionLog),
  );
  const routeFeedbackRepo = app.get<Repository<RouteFeedback>>(
    getRepositoryToken(RouteFeedback),
  );
  const workspaceRepo = app.get<Repository<Workspace>>(
    getRepositoryToken(Workspace),
  );
  const membershipRepo = app.get<Repository<WorkspaceMembership>>(
    getRepositoryToken(WorkspaceMembership),
  );
  const invitationRepo = app.get<Repository<WorkspaceInvitation>>(
    getRepositoryToken(WorkspaceInvitation),
  );
  const managementAuditRepo = app.get<Repository<ManagementAuditEvent>>(
    getRepositoryToken(ManagementAuditEvent),
  );
  const promptTemplateRepo = app.get<Repository<PromptTemplate>>(
    getRepositoryToken(PromptTemplate),
  );
  await apiKeyRepo.save([
    apiKeyRepo.create({
      name: 'test-default',
      workspace_id: DEFAULT_WORKSPACE_ID,
      key_hash: createHash('sha256').update(API_KEY).digest('hex'),
      key_prefix: 'e2e-test-key-1',
      status: 'active',
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
    }),
    apiKeyRepo.create({
      name: 'test-secondary',
      workspace_id: DEFAULT_WORKSPACE_ID,
      key_hash: createHash('sha256').update(API_KEY_2).digest('hex'),
      key_prefix: 'e2e-test-key-2',
      status: 'active',
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
    }),
    apiKeyRepo.create({
      name: 'legacy-default',
      workspace_id: null,
      key_hash: createHash('sha256').update(LEGACY_API_KEY).digest('hex'),
      key_prefix: 'e2e-legacy-key',
      status: 'active',
      allow_auto: true,
      allow_direct: true,
      allowed_nodes: [],
      allowed_models: [],
    }),
  ]);

  await app.listen(0, '127.0.0.1');

  const server = app.getHttpServer();
  const agent = request.agent(server);

  return {
    app,
    agent,
    fetchMock,
    callLogRepo,
    routeDecisionRepo,
    routeFeedbackRepo,
    workspaceRepo,
    membershipRepo,
    invitationRepo,
    managementAuditRepo,
    promptTemplateRepo,
    close: async () => {
      fetchMock.restore();
      await app.close();
    },
  };
}
