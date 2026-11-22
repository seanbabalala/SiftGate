import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  validateConfigFile,
  validateConfigObject,
} from '../../src/config/config-validator';
import { runCli } from '../../src/cli/siftgate';
import { loadMergedCatalog } from '../../src/catalog/catalog.service';

const fixture = (name: string) =>
  path.resolve(__dirname, '../fixtures/config-validator', name);
const catalogFixture = (name: string) =>
  path.resolve(__dirname, '../fixtures/catalog', name);

const codes = (issues: { code: string }[]) => issues.map((item) => item.code);

function secretReferenceConfig(
  apiKey: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    server: { port: 2099, host: '0.0.0.0' },
    database: { type: 'sqlite', path: ':memory:' },
    auth: { api_keys: [] },
    nodes: [
      {
        id: 'openai',
        name: 'OpenAI',
        protocol: 'chat_completions',
        base_url: 'https://api.openai.com',
        endpoint: '/v1/chat/completions',
        api_key: apiKey,
        models: ['gpt-4o-mini'],
        timeout_ms: 60000,
        headers: {
          'X-Provider-Org': '${env:OPENAI_ORG_ID:-org_test}',
        },
      },
    ],
    routing: {
      tiers: {
        standard: {
          primary: { node: 'openai', model: 'gpt-4o-mini' },
          fallbacks: [],
        },
      },
      scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
    },
    budget: {
      daily_token_limit: 1000000,
      daily_cost_limit: 25,
      alert_threshold: 0.8,
    },
    models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
    ...overrides,
  };
}

describe('config validator', () => {
  it('accepts explicit boolean media idempotency and rejects ambiguous opt-in values', () => {
    for (const value of [true, false, 'true', 1]) {
      const config = secretReferenceConfig('synthetic-key');
      Object.assign(config.nodes[0], { media_idempotency: value });
      Object.assign(config.nodes[0], { media_direct_only: value });
      const result = validateConfigObject(config, { env: {} });
      expect(codes(result.errors).includes('invalid_media_idempotency')).toBe(typeof value !== 'boolean');
      expect(codes(result.errors).includes('invalid_media_direct_only')).toBe(typeof value !== 'boolean');
    }
  });
  it('accepts a valid standalone data-plane config', () => {
    const result = validateConfigFile({
      configPath: fixture('valid.gateway.yaml'),
      env: {},
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(codes(result.info)).toEqual(
      expect.arrayContaining(['control_plane_disabled', 'config_summary']),
    );
  });

  it('rejects invalid dashboard legacy token auth config', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        dashboard: {
          allow_legacy_token_auth: 'no',
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('invalid_dashboard_legacy_token_auth');
  });

  it('reports YAML parser failures as errors', () => {
    const result = validateConfigFile({
      configPath: fixture('invalid-yaml.gateway.yaml'),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('yaml_parse_error');
  });

  it('warns when PostgreSQL schema synchronization is left enabled', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: {
          type: 'postgres',
          url: 'postgresql://siftgate:secret@localhost:5432/siftgate',
        },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('postgres_synchronize_enabled');
  });

  it('validates PostgreSQL pool and SSL production settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        database: {
          type: 'postgres',
          url: 'postgresql://siftgate:secret@localhost:5432/siftgate',
          synchronize: false,
          pool: {
            min: 1,
            max: 20,
            idle_timeout_ms: 30000,
            connection_timeout_ms: 5000,
            statement_timeout_ms: 60000,
            query_timeout_ms: 60000,
            max_uses: 7500,
            application_name: 'siftgate-prod',
          },
          ssl: {
            reject_unauthorized: true,
            servername: 'postgres.example.com',
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_postgres_pool');
    expect(codes(result.errors)).not.toContain('invalid_postgres_ssl');
  });

  it('rejects invalid PostgreSQL pool and URL settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        database: {
          type: 'postgres',
          url: 'mysql://siftgate:secret@localhost:3306/siftgate',
          synchronize: false,
          pool: {
            min: 10,
            max: 2,
            connection_timeout_ms: 50,
          },
          ssl: {
            reject_unauthorized: 'no',
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_postgres_url',
        'invalid_postgres_pool',
        'invalid_postgres_ssl',
      ]),
    );
  });

  it('validates config audit rollback settings', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        config_audit: {
          enabled: 'yes',
          max_versions: 0,
          max_events: -1,
          capture_startup_snapshot: 'no',
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining(['invalid_config_audit_config']),
    );
  });

  it('validates local evaluation framework privacy settings', () => {
    const invalid = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        evaluation: {
          enabled: 'yes',
          store_samples: 'sometimes',
          max_sample_chars: 0,
          retention_days: -1,
        },
      }),
      { env: {} },
    );

    expect(invalid.ok).toBe(false);
    expect(codes(invalid.errors)).toContain('invalid_evaluation_config');

    const warning = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        evaluation: {
          enabled: true,
          store_samples: true,
          max_sample_chars: 200,
          judge_model: 'missing-judge-model',
        },
      }),
      { env: {} },
    );

    expect(warning.ok).toBe(true);
    expect(codes(warning.warnings)).toEqual(
      expect.arrayContaining([
        'evaluation_sample_storage_enabled',
        'unknown_evaluation_judge_model',
      ]),
    );
  });

  it('accepts MCP Tool Gateway registry config', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        namespaces: [{ id: 'team-a', name: 'Team A' }],
        mcp: {
          enabled: true,
          servers: [
            {
              id: 'local-tools',
              name: 'Local Tools',
              url: 'http://localhost:8787/mcp',
              allowed_namespaces: ['team-a'],
              headers: {
                authorization: '${env:MCP_SERVER_TOKEN:-test}',
              },
              tools: [
                {
                  name: 'search_docs',
                  description: 'Search local docs',
                  input_schema: { type: 'object' },
                },
              ],
            },
          ],
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_mcp_config');
  });

  it('accepts stdio MCP Tool Gateway registry config for MiniMax tools', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        mcp: {
          enabled: true,
          servers: [
            {
              id: 'minimax-token-plan',
              name: 'MiniMax Token Plan MCP',
              transport: 'stdio',
              command: 'uvx',
              args: ['minimax-coding-plan-mcp'],
              env: {
                MINIMAX_API_KEY: '${env:MINIMAX_TOKEN_PLAN_KEY:-test}',
                MINIMAX_API_HOST: 'https://api.minimaxi.com',
              },
              env_allowlist: ['PATH', 'HOME'],
              inherit_env: false,
              tools: [
                {
                  name: 'web_search',
                  description: 'Search the web through MiniMax Token Plan.',
                  input_schema: { type: 'object' },
                },
                {
                  name: 'understand_image',
                  description: 'Analyze image content through MiniMax Token Plan.',
                  input_schema: { type: 'object' },
                },
              ],
            },
          ],
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_mcp_server');
    expect(codes(result.warnings)).not.toContain('mcp_stdio_inherit_env');
  });

  it('warns when stdio MCP servers inherit the full process environment', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        mcp: {
          enabled: true,
          servers: [
            {
              id: 'legacy-stdio',
              transport: 'stdio',
              command: 'node',
              inherit_env: true,
            },
          ],
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('mcp_stdio_inherit_env');
  });

  it('accepts Streamable HTTP and legacy SSE MCP Tool Gateway registry config', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        mcp: {
          enabled: true,
          servers: [
            {
              id: 'streamable-tools',
              transport: 'streamable_http',
              url: 'http://localhost:8787/mcp',
              tools: [{ name: 'web_search' }],
            },
            {
              id: 'legacy-sse-tools',
              transport: 'sse',
              url: 'http://localhost:8788/sse',
              message_url: '/messages',
              tools: [{ name: 'understand_image' }],
            },
          ],
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_mcp_server');
    expect(codes(result.errors)).not.toContain('invalid_mcp_server_url');
  });

  it('validates MCP Tool Gateway server references', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        namespaces: [{ id: 'team-a', name: 'Team A' }],
        mcp: {
          enabled: true,
          path: 'mcp',
          servers: [
            {
              id: 'local-tools',
              url: 'file:///tmp/mcp.sock',
              transport: 'bad_transport',
              allowed_namespaces: ['missing-team'],
              tools: [{ description: 'missing name' }],
            },
            {
              id: 'local-tools',
              url: 'http://localhost:8788/mcp',
            },
          ],
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_mcp_config',
        'invalid_mcp_server_url',
        'invalid_mcp_server',
        'unknown_mcp_namespace',
        'missing_required_field',
        'duplicate_mcp_server_id',
      ]),
    );
  });

  it('validates upstream connection pool settings', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
            connection: {
              enabled: true,
              keep_alive: true,
              pool_size: 10,
              keep_alive_ms: 60000,
              headers_timeout_ms: 5000,
              body_timeout_ms: 0,
              stream_max_duration_ms: 900000,
              http2: true,
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_node_connection_value');
    expect(codes(result.warnings)).toContain('experimental_http2_connection_pool');
  });

  it('validates node request compatibility overrides', () => {
    const valid = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'anthropic-compatible',
            name: 'Anthropic compatible',
            protocol: 'messages',
            base_url: 'https://anthropic-compatible.example.com',
            endpoint: '/v1/messages',
            api_key: '${ANTHROPIC_API_KEY:-test}',
            models: ['claude-opus-4-7'],
            timeout_ms: 60000,
            request_compatibility: {
              messages_tool_result_content: 'string',
              chat_tool_messages: 'stringify_as_user',
              drop_parameters: ['top_p'],
              default_parameters: {
                extra_body: {
                  google: {
                    thinking_config: {
                      thinking_budget: 0,
                      include_thoughts: false,
                    },
                  },
                },
              },
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'anthropic-compatible', model: 'claude-opus-4-7' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'claude-opus-4-7': { input: 5, output: 25 } },
      },
      { env: {} },
    );

    expect(valid.ok).toBe(true);
    expect(codes(valid.errors)).not.toContain('invalid_node_request_compatibility_mode');
    expect(codes(valid.errors)).not.toContain('invalid_node_request_compatibility_chat_tool_messages');
    expect(codes(valid.errors)).not.toContain('invalid_node_request_compatibility_drop_parameters');
    expect(codes(valid.errors)).not.toContain('invalid_node_request_compatibility_default_parameters');

    const invalid = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'anthropic-compatible',
            name: 'Anthropic compatible',
            protocol: 'messages',
            base_url: 'https://anthropic-compatible.example.com',
            endpoint: '/v1/messages',
            api_key: '${ANTHROPIC_API_KEY:-test}',
            models: ['claude-opus-4-7'],
            timeout_ms: 60000,
            request_compatibility: {
              messages_tool_result_content: 'json',
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'anthropic-compatible', model: 'claude-opus-4-7' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'claude-opus-4-7': { input: 5, output: 25 } },
      },
      { env: {} },
    );

    expect(invalid.ok).toBe(false);
    expect(codes(invalid.errors)).toContain('invalid_node_request_compatibility_mode');

    const invalidChatToolMessages = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-compatible',
            name: 'OpenAI compatible',
            protocol: 'chat_completions',
            base_url: 'https://openai-compatible.example.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
            request_compatibility: {
              chat_tool_messages: 'flatten',
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-compatible', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(invalidChatToolMessages.ok).toBe(false);
    expect(codes(invalidChatToolMessages.errors)).toContain(
      'invalid_node_request_compatibility_chat_tool_messages',
    );

    const invalidDropParameters = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-compatible',
            name: 'OpenAI compatible',
            protocol: 'responses',
            base_url: 'https://openai-compatible.example.com',
            endpoint: '/v1/responses',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-5.5'],
            timeout_ms: 60000,
            request_compatibility: {
              drop_parameters: ['top_p', ''],
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-compatible', model: 'gpt-5.5' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-5.5': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(invalidDropParameters.ok).toBe(false);
    expect(codes(invalidDropParameters.errors)).toContain(
      'invalid_node_request_compatibility_drop_parameters',
    );

    const invalidDefaultParameters = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-compatible',
            name: 'OpenAI compatible',
            protocol: 'responses',
            base_url: 'https://openai-compatible.example.com',
            endpoint: '/v1/responses',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-5.5'],
            timeout_ms: 60000,
            request_compatibility: {
              default_parameters: ['top_p'],
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-compatible', model: 'gpt-5.5' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-5.5': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(invalidDefaultParameters.ok).toBe(false);
    expect(codes(invalidDefaultParameters.errors)).toContain(
      'invalid_node_request_compatibility_default_parameters',
    );
  });

  it('validates optional batch endpoint paths', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            batch_endpoint: 'v1/batches',
            batch_status_endpoint: '/v1/batches/:id',
            batch_cancel_endpoint: '/v1/batches/:id/cancel',
            batch_result_endpoint: '/v1/files/:id/content',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('invalid_node_endpoint');
    expect(result.errors.some((item) => item.path === 'nodes[0].batch_endpoint')).toBe(true);
  });

  it('validates stream cache and embedding batching controls', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            embeddings_endpoint: '/v1/embeddings',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            embedding_models: ['text-embedding-3-small'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        cache: {
          enabled: true,
          ttl_seconds: 300,
          max_entries: 1000,
          exclude_tool_use: true,
          stream_cache: { enabled: true },
        },
        embedding_batching: {
          enabled: true,
          window_ms: 10,
          max_batch_size: 64,
          max_input_items: 4,
          max_queue: 1000,
          timeout_ms: 10000,
        },
        models_pricing: {
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
          'text-embedding-3-small': { input: 0.02, output: 0 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('validates image/audio models, endpoints, namespace references, and pricing warnings', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        namespaces: [
          {
            id: 'media-team',
            allowed_models: ['gpt-image-1', 'gpt-4o-mini-transcribe', 'veo-3-preview'],
          },
        ],
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            images_generations_endpoint: '/v1/images/generations',
            images_edits_endpoint: '/v1/images/edits',
            images_variations_endpoint: '/v1/images/variations',
            audio_transcriptions_endpoint: '/v1/audio/transcriptions',
            audio_translations_endpoint: '/v1/audio/translations',
            audio_speech_endpoint: '/v1/audio/speech',
            video_endpoint: '/v1/videos/generations',
            video_status_endpoint: '/v1/videos/:id',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            image_models: ['gpt-image-1'],
            audio_models: ['gpt-4o-mini-transcribe'],
            video_models: ['veo-3-preview'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
          'gpt-image-1': { input: 5, output: 0 },
          'veo-3-preview': { input: 20, output: 0 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(codes(result.warnings)).toContain('missing_model_pricing');
  });

  it('accepts typed env secret references and warns when the env value is missing', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${env:OPENAI_API_KEY}'),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('malformed_secret_reference');
    expect(codes(result.warnings)).toContain('env_reference_unset');
  });

  it('rejects external secret references when the backend is not enabled', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${vault:secret/openai#api_key}'),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('secret_backend_disabled');
  });

  it('accepts explicitly enabled external secret backends', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${vault:secret/openai#api_key}', {
        secret_manager: {
          backends: {
            vault: {
              enabled: true,
              address: '${env:VAULT_ADDR:-https://vault.example.com}',
              token: '${env:VAULT_TOKEN:-test}',
            },
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('secret_backend_disabled');
  });

  it('reports malformed secret reference syntax', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${vault:#api_key}'),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('malformed_secret_reference');
  });

  it('adds provider catalog warnings for unknown known-provider models', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o', 'not-a-known-openai-model'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o': { input: 2.5, output: 10 },
          'not-a-known-openai-model': { input: 1, output: 2 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('catalog_unknown_model');
  });

  it('adds provider catalog warnings for modality/endpoint mismatches and placeholder pricing', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            protocol: 'messages',
            base_url: 'https://api.anthropic.com',
            endpoint: '/v1/messages',
            api_key: '${ANTHROPIC_API_KEY:-test}',
            models: ['claude-sonnet-4-20250514'],
            image_models: ['claude-sonnet-4-20250514'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'anthropic', model: 'claude-sonnet-4-20250514' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'catalog_endpoint_modality_mismatch',
        'catalog_pricing_manual_review',
      ]),
    );
  });

  it('rejects invalid media endpoint paths and model arrays', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            images_generations_endpoint: 'v1/images/generations',
            images_variations_endpoint: 'v1/images/variations',
            audio_translations_endpoint: 'audio/translations',
            audio_speech_endpoint: '',
            video_generations_endpoint: 'v1/videos/generations',
            video_endpoint: 'v1/videos/generations',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            image_models: ['gpt-image-1', 'gpt-image-1'],
            audio_models: 'tts-1',
            video_models: ['veo-3.1-generate-preview', 'veo-3.1-generate-preview'],
            model_capabilities: {
              'gpt-image-1': {
                max_file_size: 0,
                pricing: { input: -1, output: 0 },
              },
            },
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_node_endpoint',
        'duplicate_model_id_in_node',
        'invalid_audio_models',
        'invalid_max_file_size',
        'invalid_pricing_entry',
      ]),
    );
  });

  it('accepts specialized-only catalog nodes when models is an empty array', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'voyage',
            name: 'Voyage AI',
            protocol: 'chat_completions',
            base_url: 'https://api.voyageai.com',
            endpoint: '/v1/chat/completions',
            embeddings_endpoint: '/v1/embeddings',
            rerank_endpoint: '/v1/rerank',
            api_key: '${VOYAGE_API_KEY:-test}',
            models: [],
            embedding_models: ['voyage-3-large'],
            rerank_models: ['rerank-2'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'voyage', model: 'voyage-3-large' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'voyage-3-large': { input: 0.12, output: 0 },
          'rerank-2': { input: 0.05, output: 0 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('missing_required_field');
  });

  it('accepts prompt-cache capability flags and cache token prices', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            prompt_cache: true,
            read_cache: true,
            model_capabilities: {
              'gpt-4o': {
                prompt_cache: true,
                read_cache: true,
                write_cache: false,
                pricing: {
                  input: 2.5,
                  output: 10,
                  cache_read_input: 1.25,
                  cache_creation_input: 2.5,
                },
              },
            },
            timeout_ms: 60000,
          },
        ],
        routing: {
          optimization: 'cost',
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: 0.3, standard_max: 0.6, complex_max: 0.85 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.errors).toEqual([]);
  });

  it('validates experimental realtime preview controls', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            realtime_endpoint: '/v1/realtime',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            realtime_models: ['gpt-4o-realtime-preview'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        realtime: {
          enabled: true,
          path: '/v1/realtime',
          max_connections: 10,
          max_connections_per_node: 5,
          idle_timeout_ms: 300000,
          upstream_connect_timeout_ms: 10000,
          max_session_ms: 1800000,
          default_node: 'openai',
          default_model: 'gpt-4o-realtime-preview',
        },
        models_pricing: {
          'gpt-4o': { input: 2.5, output: 10 },
          'gpt-4o-realtime-preview': { input: 5, output: 20 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(codes(result.info)).toContain('realtime_experimental');
  });

  it('rejects realtime enabled without realtime models', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        realtime: { enabled: true },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('realtime_no_models');
  });

  it('accepts a model in general and specialized buckets on the same provider without a cross-provider warning', () => {
    const config = secretReferenceConfig('${OPENAI_API_KEY:-test}');
    const result = validateConfigObject(
      {
        ...config,
        nodes: [{
          ...config.nodes[0],
          embedding_models: ['embedding-test'],
          image_models: ['image-test'],
          models: [...config.nodes[0].models, 'embedding-test', 'image-test'],
        }],
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).not.toContain('duplicate_model_id');
  });

  it('still rejects repeated entries within a model bucket without mislabeling them as cross-provider conflicts', () => {
    const config = secretReferenceConfig('${OPENAI_API_KEY:-test}');
    const result = validateConfigObject(
      {
        ...config,
        nodes: [{
          ...config.nodes[0],
          models: ['gpt-4o-mini', 'gpt-4o-mini'],
        }],
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('duplicate_model_id_in_node');
    expect(codes(result.warnings)).not.toContain('duplicate_model_id');
  });

  it('reports structural, routing, env, and control-plane issues', () => {
    const result = validateConfigFile({
      configPath: fixture('invalid.gateway.yaml'),
      env: {},
    });

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'duplicate_node_id',
        'malformed_env_reference',
        'invalid_split_weight_total',
        'route_references_unknown_node',
        'route_references_unknown_model',
        'domain_preference_unknown_node',
      ]),
    );
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'catalog_pricing_review_required',
        'literal_provider_api_key',
        'literal_control_plane_token',
        'insecure_control_plane_url',
        'control_plane_prompt_upload_enabled',
        'control_plane_response_upload_enabled',
      ]),
    );
    // The fixture repeats a node ID (already an error), not two distinct owners.
    expect(codes(result.warnings)).not.toContain('duplicate_model_id');
  });

  it('warns when node models are missing from the merged provider catalog', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['custom-chat-latest'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'custom-chat-latest' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'custom-chat-latest': { input: 0.25, output: 0.75 } },
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('catalog_unknown_model');
  });

  it('uses catalog overrides to recognize custom provider models', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: path.dirname(catalogFixture('catalog.override.yaml')),
      overridePath: catalogFixture('catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI Proxy',
            protocol: 'chat_completions',
            base_url: 'https://proxy.example/openai',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['custom-chat-latest'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'custom-chat-latest' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'custom-chat-latest': { input: 0.25, output: 0.75 } },
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).not.toContain('catalog_unknown_model');
  });

  it('recognizes v1.0 provider catalog models during config validation', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'alibaba-qwen',
            name: 'Alibaba Qwen',
            protocol: 'chat_completions',
            base_url: 'https://dashscope.aliyuncs.com/compatible-mode',
            endpoint: '/v1/chat/completions',
            api_key: '${DASHSCOPE_API_KEY:-test}',
            models: ['qwen-plus'],
            embedding_models: ['text-embedding-v4'],
            video_models: ['wan2.5-t2v-preview'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'alibaba-qwen', model: 'qwen-plus' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).not.toContain('catalog_unknown_model');
    expect(codes(result.warnings)).toContain('catalog_pricing_review_required');
  });

  it('recognizes v1.4 provider catalog models and warns on auth type mismatch', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'huggingface',
            name: 'Hugging Face',
            protocol: 'chat_completions',
            base_url: 'https://router.huggingface.co',
            endpoint: '/v1/chat/completions',
            auth_type: 'x-api-key',
            api_key: '${HF_TOKEN:-test}',
            models: ['meta-llama/Llama-3.3-70B-Instruct'],
            embedding_models: ['sentence-transformers/all-MiniLM-L6-v2'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'huggingface', model: 'meta-llama/Llama-3.3-70B-Instruct' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).not.toContain('catalog_unknown_model');
    expect(codes(result.warnings)).toContain('catalog_auth_type_mismatch');
    expect(codes(result.warnings)).toContain('catalog_pricing_review_required');
    expect(codes(result.warnings)).not.toContain('catalog_pricing_placeholder');
  });

  it('marks custom nodes as unknown provider catalog entries without blocking startup', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'internal-lab',
            name: 'Internal Lab',
            protocol: 'chat_completions',
            base_url: 'https://models.internal.example',
            endpoint: '/v1/chat/completions',
            api_key: '${INTERNAL_MODEL_KEY:-test}',
            models: ['internal-chat'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'internal-lab', model: 'internal-chat' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'internal-chat': { input: 1, output: 2 } },
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.info)).toContain('catalog_unknown_provider');
  });

  it('warns about catalog pricing hygiene without duplicating missing pricing when catalog fallback exists', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          optimization: 'cost',
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('catalog_pricing_review_required');
    expect(codes(result.warnings)).not.toContain('missing_model_pricing');
    expect(codes(result.warnings)).not.toContain('cost_routing_pricing_missing');
  });

  it('warns when catalog pricing governance source metadata is incomplete', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const catalog = {
      ...catalogLoad.catalog,
      providers: catalogLoad.catalog.providers.map((provider) =>
        provider.id === 'openai'
          ? {
              ...provider,
              models: provider.models.map((model) =>
                model.id === 'gpt-4o'
                  ? {
                      ...model,
                      pricing: {
                        input: 2.5,
                        output: 10,
                        source: '',
                        last_updated: '2025-01-01',
                        manual_review_required: true,
                        stale_after_days: 30,
                        pricing_confidence: 'low' as const,
                      },
                    }
                  : model,
              ),
            }
          : provider,
      ),
    };

    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          optimization: 'balanced',
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {}, catalog, catalogIssues: [] },
    );

    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'catalog_pricing_review_required',
        'catalog_pricing_source_missing',
        'catalog_pricing_source_url_missing',
        'catalog_pricing_stale',
      ]),
    );
  });

  it('warns when configured endpoints differ from the catalog provider preset', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/custom/chat',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain('catalog_endpoint_mismatch');
  });

  it('validates explicit compatibility profile overrides', () => {
    const catalogLoad = loadMergedCatalog({
      cwd: os.tmpdir(),
      overridePath: path.join(os.tmpdir(), 'missing-catalog.override.yaml'),
      env: {},
    });
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'responses',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/responses',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
            compatibility_profile: ['aws_bedrock_converse'],
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 2.5, output: 10 } },
      },
      { env: {}, catalog: catalogLoad.catalog, catalogIssues: catalogLoad.issues },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'compatibility_profile_provider_mismatch',
        'compatibility_profile_source_format_mismatch',
      ]),
    );
  });

  it('rejects unknown compatibility profile ids', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
            compatibility_profile: ['not_a_profile'],
          },
        ],
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('unknown_compatibility_profile');
  });

  it('surfaces catalog override secret diagnostics through config validation', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'siftgate-config-catalog-'));
    const configPath = path.join(cwd, 'gateway.config.yaml');
    fs.writeFileSync(
      configPath,
      [
        'server: { port: 2099, host: 0.0.0.0 }',
        'database: { type: sqlite, path: ":memory:" }',
        'auth: { api_keys: [] }',
        `catalog: { override_file: ${catalogFixture('secret.catalog.override.yaml')} }`,
        'nodes:',
        '  - id: openai',
        '    name: OpenAI',
        '    protocol: chat_completions',
        '    base_url: https://api.openai.com',
        '    endpoint: /v1/chat/completions',
        '    api_key: ${OPENAI_API_KEY:-test}',
        '    models: [gpt-4o]',
        'routing:',
        '  tiers:',
        '    standard:',
        '      primary: { node: openai, model: gpt-4o }',
        '      fallbacks: []',
        '  scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 }',
        'budget: { daily_token_limit: 1000000, daily_cost_limit: 25, alert_threshold: 0.8 }',
        'models_pricing: { gpt-4o: { input: 2.5, output: 10 } }',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = validateConfigFile({ configPath, cwd, env: {} });

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('catalog_override_secret_field');
    expect(codes(result.warnings)).toContain('catalog_override_secret_value');
  });

  it('requires explicit supported provider adapters for scheduled catalog sync', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        catalog: {
          sync: {
            enabled: true,
            interval_minutes: 60,
            adapters: {
              anthropic: { enabled: true },
            },
          },
        },
      }),
      { env: {} },
    );

    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'catalog_sync_adapter_manual_only',
        'catalog_sync_no_enabled_adapter',
      ]),
    );

    const ok = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        catalog: {
          sync: {
            enabled: true,
            write_to: 'cache',
            cache_file: './.siftgate/catalog-sync-cache.yaml',
            adapters: {
              openrouter: { enabled: true },
            },
          },
        },
      }),
      { env: {} },
    );
    expect(codes(ok.warnings)).not.toContain('catalog_sync_no_enabled_adapter');

    const zeroEvalOk = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        catalog: {
          sync: {
            enabled: true,
            write_to: 'cache',
            cache_file: './.siftgate/catalog-sync-cache.yaml',
            adapters: {
              zeroeval: { enabled: true },
            },
          },
        },
      }),
      { env: {} },
    );
    expect(codes(zeroEvalOk.warnings)).not.toContain('catalog_sync_no_enabled_adapter');
  });

  it('reuses shared node/model diagnostics for pricing and ambiguous names', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-a',
            name: 'OpenAI A',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
          {
            id: 'openai-b',
            name: 'OpenAI B',
            protocol: 'responses',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/responses',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-a', model: 'gpt-4o' },
              fallbacks: [{ node: 'openai-b', model: 'gpt-4o' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining(['duplicate_model_id', 'missing_model_pricing']),
    );
  });

  it('accepts targets-only load balancing tiers without legacy primary/fallbacks', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-a',
            name: 'OpenAI A',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o', 'gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              strategy: 'weighted',
              targets: [
                { node: 'openai-a', model: 'gpt-4o', weight: 70 },
                { node: 'openai-a', model: 'gpt-4o-mini', weight: 30 },
              ],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o': { input: 5, output: 15 },
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts v0.3 routing optimization and model capability metadata', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
            max_context_tokens: 128000,
            structured_output: true,
            model_capabilities: {
              'gpt-4o-mini': {
                max_context_tokens: 128000,
                structured_output: true,
                pricing: { input: 0.15, output: 0.6 },
                quality_score: 0.7,
              },
            },
          },
        ],
        routing: {
          optimization: 'cost',
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
    expect(codes(result.warnings)).not.toContain('missing_model_pricing');
  });

  it('accepts embedding models with dimensions and pricing metadata', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            embeddings_endpoint: '/v1/embeddings',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            embedding_models: ['text-embedding-3-small'],
            timeout_ms: 60000,
            model_capabilities: {
              'text-embedding-3-small': {
                dimensions: [512, 1536],
                pricing: { input: 0.02, output: 0 },
              },
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
    expect(codes(result.warnings)).not.toContain('missing_model_pricing');
  });

  it('accepts v0.6 multimodal capability schema on nodes and models', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o', 'dall-e-3', 'rerank-v1', 'realtime-model'],
            timeout_ms: 60000,
            modalities: ['text', 'image'],
            endpoints: {
              image: '/v1/images/generations',
              audio: '/v1/audio/transcriptions',
              rerank: '/v1/rerank',
              realtime: 'wss://api.openai.com/v1/realtime',
            },
            input_types: ['text', 'image', 'audio', 'documents'],
            output_types: ['text', 'image', 'ranked_documents', 'events'],
            max_file_size: 20_000_000,
            supports_streaming: true,
            supports_realtime: false,
            supports_rerank: false,
            model_capabilities: {
              'gpt-4o': {
                modalities: ['text', 'image', 'audio'],
                supports_streaming: true,
                pricing: { input: 2.5, output: 10 },
              },
              'dall-e-3': {
                modalities: ['image'],
                output_types: ['image'],
                max_file_size: 10_000_000,
                pricing: { input: 0.04, output: 0 },
              },
              'rerank-v1': {
                modalities: ['rerank'],
                supports_rerank: true,
                endpoints: { rerank: '/v1/rerank' },
                input_types: ['documents'],
                output_types: ['ranked_documents'],
                pricing: { input: 0.01, output: 0 },
              },
              'realtime-model': {
                modalities: ['realtime', 'audio', 'text'],
                supports_realtime: true,
                endpoints: { realtime: 'wss://api.openai.com/v1/realtime' },
                output_types: ['events'],
                pricing: { input: 1, output: 2 },
              },
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
    expect(codes(result.warnings)).not.toContain('missing_model_pricing');
  });

  it('accepts rerank models, endpoint, pricing metadata, and namespace references', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        namespaces: [
          {
            id: 'search',
            allowed_nodes: ['openai'],
            allowed_models: ['rerank-english-v3'],
          },
        ],
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            rerank_endpoint: '/v1/rerank',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            rerank_models: ['rerank-english-v3'],
            timeout_ms: 60000,
            model_capabilities: {
              'rerank-english-v3': {
                pricing: { input: 0.01, output: 0 },
              },
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
    expect(codes(result.warnings)).not.toContain('missing_model_pricing');
  });

  it('rejects invalid v0.6 capability schema fields', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
            modalities: ['telepathy'],
            endpoints: { image: 'v1/images', unknown: '/v1/custom' },
            input_types: ['text', ''],
            output_types: 'json',
            max_file_size: 0,
            supports_streaming: 'yes',
            model_capabilities: {
              'gpt-4o': {
                modalities: [],
                endpoints: { realtime: 'ftp://example.com/realtime' },
                input_types: ['text', 'telepathy'],
                supports_realtime: 'true',
              },
            },
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_capability_modalities',
        'invalid_capability_endpoints',
        'invalid_capability_io_types',
        'invalid_max_file_size',
        'invalid_capability_support_flag',
      ]),
    );
  });

  it('rejects invalid rerank model config', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            rerank_endpoint: 'v1/rerank',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            rerank_models: ['rerank-english-v3', 'rerank-english-v3', ''],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_node_endpoint',
        'duplicate_model_id_in_node',
        'invalid_model_id',
      ]),
    );
  });

  it('rejects invalid v0.3 routing optimization and capability metadata', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
            max_context_tokens: -1,
            structured_output: 'yes',
            model_capabilities: {
              'gpt-4o-mini': {
                max_context_tokens: 0,
                structured_output: 'yes',
                dimensions: [0],
                pricing: { input: -1, output: 0.6 },
              },
            },
          },
        ],
        routing: {
          optimization: 'magic',
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {},
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_max_context_tokens',
        'invalid_structured_output_flag',
        'invalid_embedding_dimensions',
        'invalid_pricing_entry',
        'invalid_routing_optimization',
      ]),
    );
  });

  it('accepts Redis state and cluster mode config', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        state: {
          backend: 'redis',
          redis: {
            url: '${REDIS_URL:-redis://127.0.0.1:6379}',
            prefix: 'siftgate:',
          },
          categories: {
            rate_limit: { unavailable_policy: 'fail_closed', ttl_seconds: 60 },
            circuit_breaker: { ttl_seconds: 3600 },
            cache_affinity: { unavailable_policy: 'fail_open' },
            momentum: { ttl_seconds: 1800 },
            prompt_cache: { ttl_seconds: 300 },
            concurrency: { unavailable_policy: 'fail_closed', ttl_seconds: 120 },
            health_probe: { ttl_seconds: 120 },
            realtime_session: { ttl_seconds: 1800 },
          },
        },
        cluster: {
          enabled: true,
          instance_id: 'gateway-a',
          heartbeat_interval_seconds: 10,
          heartbeat_ttl_seconds: 30,
          reload_broadcast: true,
        },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
  });

  it('rejects invalid Redis state and cluster mode settings', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        state: {
          backend: 'shared',
          redis: { url: 'http://localhost:6379', prefix: '' },
          categories: {
            unknown: { ttl_seconds: 60 },
            rate_limit: { unavailable_policy: 'closed', ttl_seconds: 0 },
            circuit_breaker: 'bad',
          },
        },
        cluster: {
          enabled: 'yes',
          instance_id: '',
          redis: { url: 'not-a-url' },
          heartbeat_interval_seconds: 10,
          heartbeat_ttl_seconds: 5,
          reload_broadcast: 'yes',
        },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_state_backend',
        'invalid_redis_url',
        'invalid_state_redis_prefix',
        'invalid_state_category',
        'invalid_state_category_policy',
        'invalid_state_category_ttl',
        'invalid_cluster_config',
      ]),
    );
    expect(codes(result.warnings)).toContain('cluster_heartbeat_ttl_short');
  });

  it('validates fallback policy shape and cost/race safety requirements', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
          fallback_policy: {
            immediate_429: 'yes',
            timeout: { enabled: true, race_fallback: true },
            structured_output: { enabled: 'yes' },
            cost_downgrade: { enabled: true },
          },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: {
          'gpt-4o': { input: 2.5, output: 10 },
        },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_fallback_policy',
        'fallback_race_requires_threshold',
        'invalid_structured_output_fallback_policy',
        'cost_downgrade_requires_limit',
      ]),
    );
  });

  it('validates webhook alert channels and spike rules', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-a',
            name: 'OpenAI A',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-a', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        alerts: {
          enabled: true,
          channels: [
            {
              type: 'webhook',
              url: 'ftp://hooks.example.test',
              events: ['node_down', 'unknown_event'],
              debounce_seconds: -1,
              retry: { attempts: 0, backoff_ms: -1, timeout_ms: 0 },
            },
          ],
          error_spike: { enabled: true, error_rate: 2 },
          latency_spike: { p95_ms: 0 },
        },
        models_pricing: { 'gpt-4o': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_alert_webhook_url',
        'invalid_alert_channel_event',
        'invalid_alert_channel',
        'invalid_alert_channel_retry',
        'invalid_alert_spike_rule',
      ]),
    );
  });

  it('validates external log sink configuration', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-a',
            name: 'OpenAI A',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-a', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        logging: {
          enabled: true,
          sinks: [
            {
              type: 'webhook',
              url: 'ftp://hooks.example.test',
              fields: ['request_id', 'prompt'],
              batch_size: 0,
              retry: { attempts: 0, backoff_ms: -1, timeout_ms: 0 },
            },
            {
              type: 's3',
              bucket: 'archive',
            },
          ],
        },
        models_pricing: { 'gpt-4o': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_log_sink_url',
        'invalid_log_sink_batching',
        'invalid_log_sink_retry',
      ]),
    );
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'log_sink_sensitive_field_ignored',
        'log_sink_interface_only',
      ]),
    );
  });

  it('validates Redis shared state backend configuration', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: { api_keys: [] },
        nodes: [
          {
            id: 'openai-a',
            name: 'OpenAI A',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai-a', model: 'gpt-4o' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        state: {
          backend: 'redis',
          unavailable_policy: 'fail_closed',
          redis: {
            url: 'http://redis.example.test',
            prefix: 'bad prefix',
            timeout_ms: 0,
          },
        },
        models_pricing: { 'gpt-4o': { input: 5, output: 15 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_state_redis_url',
        'invalid_state_redis_prefix',
        'invalid_state_redis_number',
      ]),
    );
  });

  it('validates custom provider auth header mapping without requiring provider secrets', () => {
    const valid = validateConfigObject(
      secretReferenceConfig('${env:CUSTOM_PROVIDER_API_KEY}', {
        nodes: [
          {
            id: 'custom-acme',
            name: 'Acme AI',
            protocol: 'chat_completions',
            base_url: 'https://api.acme.test',
            endpoint: '/v1/chat/completions',
            api_key: '${env:CUSTOM_PROVIDER_API_KEY}',
            auth_type: 'custom-header',
            auth_header_name: 'api-key',
            auth_header_prefix: 'Token',
            models: ['acme-chat'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: { node: 'custom-acme', model: 'acme-chat' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        models_pricing: { 'acme-chat': { input: 0.1, output: 0.2 } },
      }),
      { env: {} },
    );

    expect(valid.ok).toBe(true);
    expect(codes(valid.errors)).not.toContain('missing_custom_auth_header_name');

    const invalid = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        nodes: [
          {
            id: 'custom-acme',
            name: 'Acme AI',
            protocol: 'chat_completions',
            base_url: 'https://api.acme.test',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            auth_type: 'custom-header',
            models: ['acme-chat'],
            timeout_ms: 60000,
          },
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            auth_type: 'bearer',
            auth_header_name: 'api-key',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [
                { node: 'custom-acme', model: 'acme-chat' },
                { node: 'openai', model: 'gpt-4o-mini' },
              ],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        models_pricing: {
          'acme-chat': { input: 0.1, output: 0.2 },
          'gpt-4o-mini': { input: 0.15, output: 0.6 },
        },
      }),
      { env: {} },
    );

    expect(invalid.ok).toBe(false);
    expect(codes(invalid.errors)).toContain('missing_custom_auth_header_name');
    expect(codes(invalid.warnings)).toContain('custom_auth_header_ignored');
  });

  it('validates upstream model aliases on public node model ids', () => {
    const valid = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        nodes: [
          {
            id: 'anthropic-ada',
            name: 'Anthropic via Ada',
            protocol: 'messages',
            base_url: 'https://api.anthropic.com',
            endpoint: '/v1/messages',
            api_key: '${OPENAI_API_KEY:-test}',
            auth_type: 'x-api-key',
            models: ['claude-opus-4-7-ada'],
            upstream_model_aliases: {
              'claude-opus-4-7-ada': 'claude-opus-4-7',
            },
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              primary: {
                node: 'anthropic-ada',
                model: 'claude-opus-4-7-ada',
              },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        models_pricing: {
          'claude-opus-4-7-ada': { input: 15, output: 75 },
        },
      }),
      { env: {} },
    );

    expect(valid.ok).toBe(true);
    expect(codes(valid.errors)).not.toContain('invalid_upstream_model_aliases');
    expect(codes(valid.warnings)).not.toContain('upstream_model_alias_not_listed');

    const invalid = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            upstream_model_aliases: {
              'claude-opus-4-7-ada': 42,
            },
            timeout_ms: 60000,
          },
        ],
      }),
      { env: {} },
    );

    expect(invalid.ok).toBe(false);
    expect(codes(invalid.errors)).toContain('invalid_upstream_model_alias_target');
    expect(codes(invalid.warnings)).toContain('upstream_model_alias_not_listed');
  });

  it('validates local namespaces, API key bindings, and shadow traffic config', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: {
          api_keys: [
            { key: 'gw_sk_dev_test', name: 'dev', namespace_id: 'team-alpha' },
          ],
        },
        namespaces: [
          {
            id: 'team-alpha',
            allowed_nodes: ['openai'],
            allowed_models: ['gpt-4o-mini'],
            budget: { daily_token_limit: 10000, daily_cost_limit: 2 },
            rate_limit: { requests_per_minute: 60 },
          },
        ],
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        shadow: {
          enabled: true,
          sample_rate: 0.25,
          target_node: 'openai',
          target_model: 'gpt-4o-mini',
          compare: { store_prompts: false, store_responses: false, sample_max_chars: 4000 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).toHaveLength(0);
  });

  it('rejects invalid namespace references and unsafe shadow settings', () => {
    const result = validateConfigObject(
      {
        server: { port: 2099, host: '0.0.0.0' },
        database: { type: 'sqlite', path: ':memory:' },
        auth: {
          api_keys: [
            { key: 'gw_sk_dev_test', name: 'dev', namespace_id: 'missing' },
          ],
        },
        namespaces: [
          {
            id: 'team-alpha',
            allowed_nodes: ['missing-node'],
            budget: { daily_token_limit: -1 },
          },
        ],
        nodes: [
          {
            id: 'openai',
            name: 'OpenAI',
            protocol: 'chat_completions',
            base_url: 'https://api.openai.com',
            endpoint: '/v1/chat/completions',
            api_key: '${OPENAI_API_KEY:-test}',
            models: ['gpt-4o-mini'],
            timeout_ms: 60000,
          },
        ],
        routing: {
          tiers: {
            standard: {
              targets: [{ node: 'openai', model: 'gpt-4o-mini' }],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
        },
        shadow: {
          enabled: true,
          sample_rate: 2,
          compare: { store_prompts: true, sample_max_chars: 20 },
        },
        budget: {
          daily_token_limit: 1000000,
          daily_cost_limit: 25,
          alert_threshold: 0.8,
        },
        models_pricing: { 'gpt-4o-mini': { input: 0.15, output: 0.6 } },
      },
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'unknown_namespace_reference',
        'unknown_namespace_node',
        'invalid_namespace_budget',
        'invalid_shadow_config',
        'missing_shadow_target',
      ]),
    );
    expect(codes(result.warnings)).toContain('shadow_compare_storage_enabled');
  });

  it('accepts valid routing.cache_affinity settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
          cache_affinity: {
            enabled: true,
            min_consecutive_hits: 2,
            bonus_weight: 0.35,
            ttl_safety_margin: 0.8,
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_cache_affinity_config');
  });

  it('accepts privacy-safe intelligence loop settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        intelligence: {
          cost_optimizer: {
            enabled: true,
            action: 'evidence_only',
            objective: 'balanced',
            history_window_hours: 24,
            min_samples: 5,
            min_savings_ratio: 0.05,
            max_latency_penalty_ratio: 0.5,
            max_quality_penalty: 0.15,
            allow_quality_critical_downgrade: false,
          },
          token_prediction: {
            enabled: true,
            budget_policy: 'downgrade',
            near_limit_ratio: 0.9,
            allow_quality_critical_downgrade: false,
          },
          async_eval: {
            enabled: true,
            sample_rate: 0.1,
            dimensions: ['latency', 'toxicity', 'relevance', 'format'],
            metadata_only: true,
            max_recent_jobs: 200,
          },
          quality_gate: {
            enabled: true,
            rules: [
              {
                id: 'critical-coding',
                tiers: ['complex', 'reasoning'],
                agent_virtual_models: ['coding-deep', 'coding-security'],
                require_text: true,
                min_output_tokens: 16,
                max_latency_ms: 30000,
                fail_on_stop_reasons: ['max_tokens'],
                actions: ['fallback', 'alert'],
              },
            ],
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_intelligence_config');
    expect(codes(result.warnings)).not.toContain('intelligence_async_eval_content_storage');
  });

  it('accepts privacy-safe semantic platform settings with preview backend warnings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        semantic_cache: {
          enabled: true,
          backend: 'redis',
          similarity_threshold: 0.9,
          ttl_seconds: 600,
          max_entries: 250,
          vector_dimensions: 128,
          store_responses: false,
          max_response_bytes: 65536,
          isolation: 'workspace_api_key_model',
          response_storage_requires_header: true,
        },
        semantic_platform: {
          enabled: true,
          prompt_registry: {
            enabled: true,
            store_template_content: false,
            max_versions_per_key: 10,
          },
          context_optimizer: {
            enabled: true,
            strategy: 'metadata_only',
            max_context_ratio: 0.8,
            allow_content_mutation: false,
          },
          intent_classification: {
            enabled: true,
            categories: ['coding', 'task', 'security', 'reasoning', 'creative', 'multimodal', 'analysis', 'general'],
            min_confidence: 0.4,
          },
          guardrails_v2: {
            enabled: true,
            metadata_only: true,
            input: { enabled: true, pii: true, toxicity: true, jailbreak: true, action: 'observe' },
            output: { enabled: true, pii: true, toxicity: true, jailbreak: true, action: 'observe' },
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('invalid_semantic_cache_config');
    expect(codes(result.errors)).not.toContain('invalid_semantic_platform_config');
    expect(codes(result.warnings)).toContain('semantic_cache_backend_preview');
  });

  it('rejects invalid semantic platform settings and warns on content storage', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        semantic_cache: {
          enabled: 'yes',
          backend: 'pinecone',
          similarity_threshold: 2,
          ttl_seconds: 0,
          isolation: 'tenant',
          response_storage_requires_header: 'no',
          store_responses: true,
        },
        semantic_platform: {
          enabled: 'yes',
          prompt_registry: {
            enabled: true,
            store_template_content: true,
            max_versions_per_key: 0,
          },
          context_optimizer: {
            enabled: true,
            strategy: 'trim',
            max_context_ratio: 1.5,
            allow_content_mutation: false,
          },
          intent_classification: {
            categories: ['coding', 'unknown'],
            min_confidence: -0.2,
          },
          guardrails_v2: {
            metadata_only: 'yes',
            input: { enabled: 'true', action: 'redact' },
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_semantic_cache_config',
        'invalid_semantic_platform_config',
      ]),
    );
    expect(codes(result.warnings)).toEqual(
      expect.arrayContaining([
        'semantic_cache_response_storage_enabled',
        'prompt_registry_content_storage_enabled',
        'context_optimizer_mutation_disabled',
      ]),
    );
  });

  it('rejects invalid intelligence loop settings and warns on content eval mode', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        intelligence: {
          cost_optimizer: {
            enabled: 'yes',
            action: 'auto',
            objective: 'cheap',
            min_savings_ratio: 1.2,
          },
          token_prediction: {
            budget_policy: 'block',
            near_limit_ratio: -0.1,
          },
          async_eval: {
            sample_rate: 2,
            dimensions: ['latency', ''],
            metadata_only: false,
          },
          quality_gate: {
            enabled: true,
            rules: [
              {
                id: '',
                source_formats: ['unknown'],
                tiers: ['gold'],
                actions: ['page'],
              },
            ],
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(
      expect.arrayContaining([
        'invalid_intelligence_cost_optimizer',
        'invalid_intelligence_token_prediction',
        'invalid_intelligence_async_eval',
        'invalid_intelligence_quality_gate_rule',
      ]),
    );
    expect(codes(result.warnings)).toContain('intelligence_async_eval_content_storage');
  });

  it('rejects invalid routing.cache_affinity settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
          cache_affinity: {
            enabled: 'yes',
            min_consecutive_hits: 0,
            bonus_weight: -0.1,
            ttl_safety_margin: 1.2,
          },
        },
      }),
      { env: {} },
    );

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toContain('invalid_cache_affinity_config');
  });

  it('accepts valid routing.circuit_breaker settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
          circuit_breaker: {
            enabled: false,
            failure_threshold: 8,
            cooldown_ms: 30000,
            half_open_max: 1,
          },
        },
      }),
      { env: {} },
    );

    expect(codes(result.errors)).not.toContain('invalid_circuit_breaker_config');
  });

  it('rejects invalid routing.circuit_breaker settings', () => {
    const result = validateConfigObject(
      secretReferenceConfig('${OPENAI_API_KEY:-test}', {
        routing: {
          tiers: {
            standard: {
              primary: { node: 'openai', model: 'gpt-4o-mini' },
              fallbacks: [],
            },
          },
          scoring: { simple_max: -0.1, standard_max: 0.08, complex_max: 0.35 },
          circuit_breaker: {
            enabled: 'yes',
            failure_threshold: 0,
            cooldown_ms: -1,
            half_open_max: 1.5,
          },
        },
      }),
      { env: {} },
    );

    expect(codes(result.errors)).toEqual(
      expect.arrayContaining(['invalid_circuit_breaker_config']),
    );
  });

  it('accepts provider credential pools without a legacy node api_key', () => {
    const config = secretReferenceConfig('${OPENAI_API_KEY:-test}');
    (config.nodes[0] as Record<string, unknown>).api_key = undefined;
    (config.nodes[0] as Record<string, unknown>).credentials = [
      { id: 'primary', api_key: '${OPENAI_API_KEY_PRIMARY:-test}', weight: 2 },
      { id: 'backup', api_key: '${OPENAI_API_KEY_BACKUP:-test}', enabled: true },
    ];
    (config.nodes[0] as Record<string, unknown>).credential_pool = {
      strategy: 'cache_aware',
      sticky_by: 'agent_session',
      cooldown_ms: 60000,
      max_failures: 3,
      retry_on_status: [429, 500, 502, 503, 504],
    };

    const result = validateConfigObject(config, { env: {} });

    expect(result.ok).toBe(true);
    expect(codes(result.errors)).not.toContain('missing_required_field');
  });

  it('rejects duplicate credential ids and invalid pool settings', () => {
    const config = secretReferenceConfig('${OPENAI_API_KEY:-test}');
    (config.nodes[0] as Record<string, unknown>).credentials = [
      { id: 'dup', api_key: '${OPENAI_API_KEY_PRIMARY:-test}', weight: 0 },
      { id: 'dup', api_key: '' },
    ];
    (config.nodes[0] as Record<string, unknown>).credential_pool = {
      strategy: 'random',
      sticky_by: 'cookie',
      retry_on_status: [42],
    };

    const result = validateConfigObject(config, { env: {} });

    expect(result.ok).toBe(false);
    expect(codes(result.errors)).toEqual(expect.arrayContaining([
      'duplicate_credential_id',
      'missing_credential_api_key',
      'invalid_credential_weight',
      'invalid_credential_pool_strategy',
      'invalid_credential_pool_sticky_by',
      'invalid_credential_pool_retry_status',
    ]));
  });
});

describe('siftgate validate CLI', () => {
  it('prints text output and returns zero for a valid config', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['validate', '--config', fixture('valid.gateway.yaml')],
      {
        env: {},
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toHaveLength(0);
    expect(stdout.join('\n')).toContain('Result: OK');
  });

  it('prints JSON output and returns non-zero for invalid configs', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['validate', '--config', fixture('invalid.gateway.yaml'), '--json'],
      {
        env: {},
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveLength(0);
    const parsed = JSON.parse(stdout.join('\n'));
    expect(parsed.ok).toBe(false);
    expect(codes(parsed.errors)).toContain('route_references_unknown_node');
  });
});
