import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ErrorDetailDto {
  @ApiProperty({ example: 'Invalid API key' })
  message!: string;

  @ApiPropertyOptional({ example: 'invalid_request_error' })
  type?: string;

  @ApiPropertyOptional({ example: 'budget_exceeded' })
  code?: string;

  @ApiPropertyOptional({
    example: 'req_1234567890',
    description:
      'Gateway request id. Matches the public x-siftgate-request-id response header and legacy x-request-id header.',
  })
  request_id?: string;
}

export class ErrorEnvelopeDto {
  @ApiProperty({ type: ErrorDetailDto })
  error!: ErrorDetailDto;
}

export class ActionResponseDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: 'Operation completed' })
  message!: string;
}

export class LoginRequestDto {
  @ApiProperty({
    example: 'dashboard-password',
    format: 'password',
    writeOnly: true,
  })
  password!: string;
}

export class LoginResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.redacted',
    description: 'Dashboard session JWT. Example is redacted.',
  })
  token!: string;
}

export class AuthStatusResponseDto {
  @ApiProperty({ example: true })
  authRequired!: boolean;

  @ApiProperty({
    example: false,
    description: 'Whether the current request has a valid Dashboard session cookie.',
  })
  authenticated!: boolean;
}

export class OrganizationSummaryDto {
  @ApiProperty({ example: 'default-org' })
  id!: string;

  @ApiProperty({ example: 'Default Organization' })
  name!: string;

  @ApiProperty({ example: 'default-org' })
  slug!: string;

  @ApiProperty({ example: 'active' })
  status!: string;
}

export class WorkspaceSummaryDto {
  @ApiProperty({ example: 'default-workspace' })
  id!: string;

  @ApiProperty({ example: 'default-org' })
  organization_id!: string;

  @ApiProperty({ example: 'Default Workspace' })
  name!: string;

  @ApiProperty({ example: 'default-workspace' })
  slug!: string;

  @ApiProperty({ example: 'active' })
  status!: string;

  @ApiProperty({ example: true })
  is_default!: boolean;
}

export class WorkspaceStateResponseDto {
  @ApiProperty({ type: OrganizationSummaryDto })
  organization!: OrganizationSummaryDto;

  @ApiProperty({ type: WorkspaceSummaryDto })
  active_workspace!: WorkspaceSummaryDto;

  @ApiProperty({ type: WorkspaceSummaryDto })
  default_workspace!: WorkspaceSummaryDto;

  @ApiProperty({ type: [WorkspaceSummaryDto] })
  workspaces!: WorkspaceSummaryDto[];

  @ApiPropertyOptional({
    description: 'Current Dashboard user role and coarse-grained workspace permissions.',
    example: {
      user_id: 'dashboard',
      role: 'admin',
      permissions: {
        can_read: true,
        can_operate: true,
        can_admin: true,
      },
    },
  })
  access?: {
    user_id: string;
    role: 'admin' | 'operator' | 'viewer';
    permissions: {
      can_read: boolean;
      can_operate: boolean;
      can_admin: boolean;
    };
  };
}

export class WorkspaceMutationResponseDto extends ActionResponseDto {
  @ApiProperty({ type: WorkspaceSummaryDto })
  item!: WorkspaceSummaryDto;

  @ApiProperty({ type: WorkspaceStateResponseDto })
  state!: WorkspaceStateResponseDto;
}

export class WorkspaceMemberDto {
  @ApiProperty({ example: 'membership-default-dashboard-admin' })
  id!: string;

  @ApiProperty({ example: 'dashboard' })
  user_id!: string;

  @ApiProperty({ example: 'default-org' })
  organization_id!: string;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ enum: ['admin', 'operator', 'viewer'], example: 'admin' })
  role!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  updated_at!: string;
}

export class WorkspaceMemberListResponseDto {
  @ApiProperty({ type: [WorkspaceMemberDto] })
  items!: WorkspaceMemberDto[];

  @ApiProperty({ type: [String], example: ['admin', 'operator', 'viewer'] })
  roles!: string[];

  @ApiProperty({ example: 'local_dashboard' })
  mode!: string;
}

export class WorkspaceMemberMutationResponseDto extends ActionResponseDto {
  @ApiProperty({ type: WorkspaceMemberDto })
  item!: WorkspaceMemberDto;
}

export class WorkspaceInvitationDto {
  @ApiProperty({ example: 'e7a1f4be-2af0-4c6d-8bfb-9a6c4ff7d4b0' })
  id!: string;

  @ApiProperty({ example: 'default-org' })
  organization_id!: string;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ enum: ['admin', 'operator', 'viewer'], example: 'viewer' })
  role!: string;

  @ApiPropertyOptional({ example: 'teammate@example.com', nullable: true })
  email?: string | null;

  @ApiProperty({ enum: ['pending', 'accepted', 'expired', 'revoked'], example: 'pending' })
  status!: string;

  @ApiProperty({ example: '2026-05-16T00:00:00.000Z' })
  expires_at!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  accepted_at?: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  accepted_by_user_id?: string | null;

  @ApiPropertyOptional({ example: 'dashboard', nullable: true })
  created_by_user_id?: string | null;

  @ApiPropertyOptional({
    example: 'sg_inv_redacted',
    description: 'Plain invitation token. Returned once on creation only.',
  })
  token?: string;

  @ApiPropertyOptional({ example: '/login?invite=sg_inv_redacted' })
  accept_path?: string;
}

export class WorkspaceInvitationListResponseDto {
  @ApiProperty({ type: [WorkspaceInvitationDto] })
  items!: WorkspaceInvitationDto[];
}

export class WorkspaceInvitationMutationResponseDto extends ActionResponseDto {
  @ApiProperty({ type: WorkspaceInvitationDto })
  item!: WorkspaceInvitationDto;
}

export class ManagementAuditEventDto {
  @ApiProperty({ example: 1 })
  id!: number;

  @ApiProperty({ example: 'mga_01HX...' })
  event_id!: string;

  @ApiPropertyOptional({ example: 'default-org', nullable: true })
  organization_id?: string | null;

  @ApiPropertyOptional({ example: 'default-workspace', nullable: true })
  workspace_id?: string | null;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 'dashboard' })
  actor_type!: string;

  @ApiProperty({ example: 'dashboard' })
  actor_id!: string;

  @ApiProperty({ example: 'api_key.create' })
  action!: string;

  @ApiProperty({ example: 'api_key' })
  resource_type!: string;

  @ApiPropertyOptional({ example: 'key_prod', nullable: true })
  resource_id?: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  before_summary!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  after_summary!: Record<string, unknown>;

  @ApiProperty({ enum: ['success', 'failure', 'denied'], example: 'success' })
  result!: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  failure_reason?: string | null;

  @ApiPropertyOptional({ example: 'req_123', nullable: true })
  request_id?: string | null;

  @ApiPropertyOptional({ example: 'dashboard', nullable: true })
  source?: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  metadata!: Record<string, unknown>;

  @ApiPropertyOptional({ example: null, nullable: true })
  previous_hash?: string | null;

  @ApiProperty({ example: 'b7a6d6f3e5...' })
  event_hash!: string;

  @ApiProperty({ example: 1 })
  schema_version!: number;
}

export class ManagementAuditPaginationDto {
  @ApiProperty({ example: 100 })
  limit!: number;

  @ApiProperty({ example: 12 })
  count!: number;
}

export class ManagementAuditPrivacyDto {
  @ApiProperty({ example: false })
  prompt_response_stored!: boolean;

  @ApiProperty({ example: false })
  raw_headers_stored!: boolean;

  @ApiProperty({ example: false })
  provider_keys_stored!: boolean;

  @ApiProperty({ example: false })
  tool_payloads_stored!: boolean;

  @ApiProperty({ example: false })
  hidden_reasoning_stored!: boolean;
}

export class ManagementAuditEventsResponseDto {
  @ApiProperty({ type: [ManagementAuditEventDto] })
  data!: ManagementAuditEventDto[];

  @ApiProperty({ type: ManagementAuditPaginationDto })
  pagination!: ManagementAuditPaginationDto;

  @ApiProperty({ type: ManagementAuditPrivacyDto })
  privacy!: ManagementAuditPrivacyDto;
}

export class ChatCompletionsRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate smart routing or a direct model/node name.' })
  model!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    example: [{ role: 'user', content: 'Hello from SiftGate' }],
  })
  messages!: unknown[];

  @ApiPropertyOptional({ example: false })
  stream?: boolean;

  @ApiPropertyOptional({ example: 512 })
  max_tokens?: number;

  @ApiPropertyOptional({ example: 0.7 })
  temperature?: number;

  @ApiPropertyOptional({ example: 1 })
  top_p?: number;

  @ApiPropertyOptional({
    enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    example: 'max',
    description:
      'OpenAI reasoning effort. Supported values are model-specific; GPT-5.6 supports none, low, medium, high, xhigh, and max.',
  })
  reasoning_effort?: string;

  @ApiPropertyOptional({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    example: ['END'],
  })
  stop?: string | string[];

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object' },
    description: 'OpenAI-compatible tool definitions.',
  })
  tools?: unknown[];

  @ApiPropertyOptional({
    oneOf: [{ type: 'string' }, { type: 'object' }],
    example: 'auto',
  })
  tool_choice?: unknown;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'OpenAI Chat Completions response_format, including json_object and json_schema.',
    example: {
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        strict: true,
      },
    },
  })
  response_format?: unknown;
}

export class ResponsesRequestDto {
  @ApiProperty({ example: 'auto' })
  model!: string;

  @ApiProperty({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    example: 'Summarize this request.',
  })
  input!: string | unknown[];

  @ApiPropertyOptional({ example: 'You are concise.' })
  instructions?: string;

  @ApiPropertyOptional({ example: false })
  stream?: boolean;

  @ApiPropertyOptional({ example: 512 })
  max_output_tokens?: number;

  @ApiPropertyOptional({ example: 0.7 })
  temperature?: number;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    properties: {
      effort: {
        type: 'string',
        enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    },
    example: { effort: 'max' },
    description:
      'OpenAI Responses reasoning controls. Supported effort values are model-specific; GPT-5.6 supports none, low, medium, high, xhigh, and max.',
  })
  reasoning?: Record<string, unknown>;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object' },
    description: 'OpenAI Responses tool definitions.',
  })
  tools?: unknown[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'OpenAI Responses text.format, including json_schema.',
    example: {
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        strict: true,
      },
    },
  })
  text?: unknown;
}

export class AnthropicMessagesRequestDto {
  @ApiProperty({ example: 'auto' })
  model!: string;

  @ApiPropertyOptional({
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object' } }],
    example: 'You are concise.',
  })
  system?: string | unknown[];

  @ApiProperty({
    type: 'array',
    items: { type: 'object' },
    example: [{ role: 'user', content: 'Hello from SiftGate' }],
  })
  messages!: unknown[];

  @ApiProperty({ example: 1024 })
  max_tokens!: number;

  @ApiPropertyOptional({ example: false })
  stream?: boolean;

  @ApiPropertyOptional({ example: 0.7 })
  temperature?: number;

  @ApiPropertyOptional({ type: [String], example: ['END'] })
  stop_sequences?: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Anthropic structured-output passthrough when using native Messages output_config.format.',
    example: {
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    },
  })
  output_config?: unknown;
}

export class EmbeddingsRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for cost-aware embedding routing or a configured embedding model.' })
  model!: string;

  @ApiProperty({
    oneOf: [
      { type: 'string' },
      { type: 'array', items: { type: 'string' } },
      { type: 'array', items: { type: 'number' } },
      { type: 'array', items: { type: 'array', items: { type: 'number' } } },
    ],
    example: ['SiftGate routes AI traffic.', 'Embeddings are useful for search.'],
  })
  input!: string | string[] | number[] | number[][];

  @ApiPropertyOptional({ example: 1536 })
  dimensions?: number;

  @ApiPropertyOptional({ example: 'float' })
  encoding_format?: string;

  @ApiPropertyOptional({ example: 'user-123' })
  user?: string;
}

export class RerankRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for cost-aware rerank routing or a configured rerank model.' })
  model!: string;

  @ApiProperty({ example: 'What is SiftGate?' })
  query!: string;

  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { type: 'string' },
        { type: 'object' },
      ],
    },
    example: [
      'SiftGate is a self-hosted AI traffic gateway.',
      'A database migration tool moves SQLite data into PostgreSQL.',
    ],
  })
  documents!: Array<string | Record<string, unknown>>;

  @ApiPropertyOptional({ example: 3 })
  top_n?: number;

  @ApiPropertyOptional({ example: true })
  return_documents?: boolean;
}

export class ImageGenerationRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate image routing or a configured image model.' })
  model!: string;

  @ApiProperty({ example: 'A clean product render of a self-hosted AI gateway appliance.' })
  prompt!: string;

  @ApiPropertyOptional({ example: 1 })
  n?: number;

  @ApiPropertyOptional({ example: '1024x1024' })
  size?: string;

  @ApiPropertyOptional({ example: 'url', enum: ['url', 'b64_json'] })
  response_format?: string;

  @ApiPropertyOptional({ example: 'user-123' })
  user?: string;
}

export class ImageEditRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate image routing or a configured image model.' })
  model!: string;

  @ApiPropertyOptional({
    example: 'Replace the background with a neutral studio backdrop.',
    description: 'For JSON requests. Multipart requests should send the usual OpenAI-compatible image/mask fields.',
  })
  prompt?: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Multipart image file. SiftGate passes multipart bytes through and only rewrites/appends the model field.',
  })
  image?: unknown;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Optional multipart mask file.',
  })
  mask?: unknown;

  @ApiPropertyOptional({ example: '1024x1024' })
  size?: string;
}

export class ImageVariationRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate image routing or a configured image model.' })
  model!: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Multipart source image. SiftGate passes multipart bytes through and only rewrites/appends the model field.',
  })
  image?: unknown;

  @ApiPropertyOptional({ example: 1 })
  n?: number;

  @ApiPropertyOptional({ example: '1024x1024' })
  size?: string;

  @ApiPropertyOptional({ example: 'url', enum: ['url', 'b64_json'] })
  response_format?: string;
}

export class AudioTranscriptionRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate audio routing or a configured audio model.' })
  model!: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Multipart audio file. SiftGate passes multipart bytes through and only rewrites/appends the model field.',
  })
  file?: unknown;

  @ApiPropertyOptional({ example: 'json' })
  response_format?: string;

  @ApiPropertyOptional({ example: 'en' })
  language?: string;
}

export class AudioTranslationRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate audio routing or a configured audio model.' })
  model!: string;

  @ApiPropertyOptional({
    type: 'string',
    format: 'binary',
    description: 'Multipart audio file. SiftGate passes multipart bytes through and only rewrites/appends the model field.',
  })
  file?: unknown;

  @ApiPropertyOptional({ example: 'json' })
  response_format?: string;

  @ApiPropertyOptional({ example: 'Translate this audio to English when the upstream supports OpenAI-compatible translations.' })
  prompt?: string;
}

export class AudioSpeechRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate audio routing or a configured speech model.' })
  model!: string;

  @ApiProperty({ example: 'SiftGate routes this text to an audio-capable upstream.' })
  input!: string;

  @ApiPropertyOptional({ example: 'alloy' })
  voice?: string;

  @ApiPropertyOptional({ example: 'mp3' })
  response_format?: string;

  @ApiPropertyOptional({ example: 1 })
  speed?: number;
}

export class VideoGenerationRequestDto {
  @ApiProperty({ example: 'auto', description: 'Use "auto" for SiftGate video routing or a configured video model.' })
  model!: string;

  @ApiPropertyOptional({ example: 'A short product demo clip of a self-hosted AI gateway dashboard.', description: 'Generic video prompt. Native profiles instead require their documented request envelope.' })
  prompt?: string;

  @ApiPropertyOptional({ description: 'Gemini Veo REST input instances (one input). Requires an explicitly selected native result profile.' })
  instances?: Record<string, unknown>[];

  @ApiPropertyOptional({ description: 'Gemini Veo REST parameters, including durationSeconds and sampleCount.' })
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Native Runway text prompt. Requires an explicitly selected native result profile.' })
  promptText?: string;

  @ApiPropertyOptional({ example: '16:9' })
  aspect_ratio?: string;

  @ApiPropertyOptional({ example: '1280x720' })
  size?: string;

  @ApiPropertyOptional({ example: 5 })
  duration?: number;

  @ApiPropertyOptional({ example: 'standard' })
  quality?: string;

  @ApiPropertyOptional({ description: 'Optional provider-specific image or asset reference. SiftGate forwards it but does not persist it.' })
  input_reference?: unknown;

  @ApiPropertyOptional({ description: 'Optional client metadata forwarded to the provider.' })
  metadata?: Record<string, unknown>;
}

export class BatchCreateRequestDto {
  @ApiProperty({
    example: 'file-batch-input',
    description: 'Provider file id that contains OpenAI-compatible JSONL batch input. SiftGate forwards this id but does not store file contents.',
  })
  input_file_id!: string;

  @ApiProperty({
    example: '/v1/chat/completions',
    description: 'Provider endpoint to process inside the batch, for example /v1/chat/completions or /v1/embeddings.',
  })
  endpoint!: string;

  @ApiProperty({
    example: '24h',
    description: 'Provider completion window.',
  })
  completion_window!: string;

  @ApiPropertyOptional({
    example: 'gpt-4o-mini',
    description: 'Optional SiftGate routing/model permission hint. Required when the Gateway API key restricts allowed_models.',
  })
  model?: string;

  @ApiPropertyOptional({
    example: 'openai-prod',
    description: 'Optional SiftGate node hint for provider passthrough/custom endpoint selection.',
  })
  node?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Forwarded provider metadata. SiftGate stores metadata keys only, never values.',
  })
  metadata?: Record<string, unknown>;
}

export class ModelItemDto {
  @ApiProperty({ example: 'gpt-4o' })
  id!: string;

  @ApiProperty({ example: 'model' })
  object!: string;

  @ApiProperty({ example: 0 })
  created!: number;

  @ApiProperty({ example: 'openai' })
  owned_by!: string;

  @ApiPropertyOptional({ example: 'OpenAI Main Account' })
  node_name?: string;

  @ApiPropertyOptional({ type: [String], example: ['gpt4'] })
  aliases?: string[];

  @ApiPropertyOptional({ example: true })
  is_alias?: boolean;

  @ApiPropertyOptional({ example: 'gpt-4o' })
  resolves_to?: string;

  @ApiPropertyOptional({ example: true })
  is_agent_profile_model?: boolean;

  @ApiPropertyOptional({ example: 'profile_01h...' })
  agent_profile_id?: string;

  @ApiPropertyOptional({ example: 'Claude Code local' })
  agent_profile_name?: string;

  @ApiPropertyOptional({ example: 'claude_code' })
  agent_connector?: string;

  @ApiPropertyOptional({ example: 'claude-siftgate-auto' })
  agent_virtual_model?: string;

  @ApiPropertyOptional({ example: 'coding-auto' })
  agent_virtual_alias?: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  routing_hint?: Record<string, unknown> | null;
}

export class ModelListResponseDto {
  @ApiProperty({ example: 'list' })
  object!: string;

  @ApiProperty({ type: [ModelItemDto] })
  data!: ModelItemDto[];
}

export class HealthModelCircuitDto {
  @ApiProperty({ example: 'CLOSED' })
  state!: string;

  @ApiProperty({ example: 0 })
  consecutiveFailures!: number;

  @ApiProperty({ example: null, nullable: true })
  lastFailureAt!: string | null;
}

export class HealthRealtimeDto {
  @ApiProperty({ example: false })
  enabled!: boolean;

  @ApiProperty({ example: true })
  experimental!: true;

  @ApiProperty({ example: true })
  supported!: boolean;

  @ApiProperty({ example: '/v1/realtime', nullable: true })
  endpoint!: string | null;

  @ApiProperty({ type: [String], example: ['gpt-4o-realtime-preview'] })
  models!: string[];

  @ApiProperty({ example: 0 })
  active_connections!: number;

  @ApiProperty({ example: 25 })
  max_connections_per_node!: number;

  @ApiProperty({ example: null, nullable: true })
  last_connected_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  last_closed_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  last_error!: string | null;
}

export class HealthNodeDto {
  @ApiProperty({ example: 'openai' })
  id!: string;

  @ApiProperty({ example: 'OpenAI' })
  name!: string;

  @ApiProperty({ example: 'chat_completions' })
  protocol!: string;

  @ApiProperty({ example: 'CLOSED' })
  circuit!: string;

  @ApiProperty({ example: 0 })
  consecutiveFailures!: number;

  @ApiProperty({ example: null, nullable: true })
  lastFailureAt!: string | null;

  @ApiProperty({ example: true })
  healthy!: boolean;

  @ApiProperty({ type: HealthRealtimeDto })
  realtime!: HealthRealtimeDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: '#/components/schemas/HealthModelCircuitDto' },
  })
  models!: Record<string, HealthModelCircuitDto>;
}

export class HealthBudgetDto {
  @ApiProperty({ example: 'daily_tokens' })
  type!: string;

  @ApiProperty({ example: 1200 })
  current!: number;

  @ApiProperty({ example: 5000000 })
  limit!: number;

  @ApiProperty({ example: 12.4 })
  percentage!: number;

  @ApiProperty({ example: false })
  exceeded!: boolean;

  @ApiProperty({ example: false })
  alert!: boolean;
}

export class HealthDatabaseDto {
  @ApiProperty({ example: true })
  healthy!: boolean;

  @ApiProperty({ enum: ['sqlite', 'postgres'], example: 'postgres' })
  type!: 'sqlite' | 'postgres';

  @ApiProperty({
    example: 'postgresql://siftgate:***@postgres:5432/siftgate',
    description: 'Database target with credentials redacted.',
  })
  target!: string;

  @ApiProperty({ example: true })
  connected!: boolean;

  @ApiProperty({ example: 4, nullable: true })
  latency_ms!: number | null;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  checked_at!: string;

  @ApiProperty({ example: null, nullable: true })
  error!: string | null;

  @ApiProperty({ example: false })
  synchronize!: boolean;

  @ApiPropertyOptional({
    example: {
      min: 0,
      max: 10,
      idle_timeout_ms: 30000,
      connection_timeout_ms: 5000,
      application_name: 'siftgate',
    },
  })
  pool?: Record<string, unknown>;

  @ApiPropertyOptional({ enum: ['disabled', 'enabled', 'enabled-no-verify'] })
  ssl?: 'disabled' | 'enabled' | 'enabled-no-verify';
}

export class HealthResponseDto {
  @ApiProperty({ enum: ['healthy', 'degraded'], example: 'healthy' })
  status!: 'healthy' | 'degraded';

  @ApiProperty({ example: 12345 })
  uptime_ms!: number;

  @ApiProperty({ example: '12s' })
  uptime_human!: string;

  @ApiProperty({ example: '2026-05-02T04:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ type: HealthDatabaseDto })
  database!: HealthDatabaseDto;

  @ApiProperty({ type: [HealthNodeDto] })
  nodes!: HealthNodeDto[];

  @ApiProperty({ type: [HealthBudgetDto] })
  budget!: HealthBudgetDto[];
}

export class SanitizedNodeConfigDto {
  @ApiProperty({ example: 'openai' })
  id!: string;

  @ApiProperty({ example: 'OpenAI' })
  name!: string;

  @ApiProperty({ example: 'chat_completions' })
  protocol!: string;

  @ApiProperty({ example: 'https://api.openai.com' })
  base_url!: string;

  @ApiProperty({ example: '/v1/chat/completions' })
  endpoint!: string;

  @ApiProperty({
    example: 'sk-live...',
    description: 'Masked provider key. The full provider API key is never returned.',
    readOnly: true,
  })
  api_key!: string;

  @ApiProperty({ type: [String], example: ['gpt-4o', 'gpt-4o-mini'] })
  models!: string[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'claude-opus-4-7-ada': 'claude-opus-4-7' },
    description: 'Public model id to upstream provider model mapping.',
  })
  upstream_model_aliases?: Record<string, string>;

  @ApiPropertyOptional({
    type: 'object',
    properties: {
      messages_tool_result_content: {
        type: 'string',
        enum: ['native', 'string'],
      },
      chat_tool_messages: {
        type: 'string',
        enum: ['native', 'stringify_as_user', 'drop'],
      },
      drop_parameters: {
        type: 'array',
        items: { type: 'string' },
      },
      default_parameters: {
        type: 'object',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
    example: {
      messages_tool_result_content: 'string',
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
    description: 'Optional request-shape compatibility overrides for upstream providers.',
  })
  request_compatibility?: {
    messages_tool_result_content?: 'native' | 'string';
    chat_tool_messages?: 'native' | 'stringify_as_user' | 'drop';
    drop_parameters?: string[];
    default_parameters?: Record<string, unknown>;
  };

  @ApiPropertyOptional({ type: [String], example: ['text-embedding-3-small'] })
  embedding_models?: string[];

  @ApiPropertyOptional({ example: '/v1/embeddings' })
  embeddings_endpoint?: string;

  @ApiPropertyOptional({ type: [String], example: ['gpt-image-1'] })
  image_models?: string[];

  @ApiPropertyOptional({ example: '/v1/images/generations' })
  images_generations_endpoint?: string;

  @ApiPropertyOptional({ example: '/v1/images/edits' })
  images_edits_endpoint?: string;

  @ApiPropertyOptional({ example: '/v1/images/variations' })
  images_variations_endpoint?: string;

  @ApiPropertyOptional({ type: [String], example: ['gpt-4o-mini-transcribe', 'tts-1'] })
  audio_models?: string[];

  @ApiPropertyOptional({ example: '/v1/audio/transcriptions' })
  audio_transcriptions_endpoint?: string;

  @ApiPropertyOptional({ example: '/v1/audio/translations' })
  audio_translations_endpoint?: string;

  @ApiPropertyOptional({ example: '/v1/audio/speech' })
  audio_speech_endpoint?: string;
}

export class SanitizedConfigResponseDto {
  @ApiProperty({ type: 'object', additionalProperties: true, example: { port: 2099, host: '0.0.0.0' } })
  server!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true, example: { type: 'sqlite' } })
  database!: { type: string };

  @ApiProperty({ type: 'object', additionalProperties: true, example: { api_keys: [], managed_in_dashboard: true } })
  auth!: Record<string, unknown>;

  @ApiProperty({ type: [SanitizedNodeConfigDto] })
  nodes!: SanitizedNodeConfigDto[];

  @ApiProperty({ type: 'object', additionalProperties: true })
  routing!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  budget!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  models_pricing!: Record<string, unknown>;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  diagnostics!: unknown[];
}

export class GatewayApiKeyTodayDto {
  @ApiProperty({ example: 10 })
  calls!: number;

  @ApiProperty({ example: 1 })
  errors!: number;

  @ApiProperty({ example: 0.1 })
  error_rate!: number;

  @ApiProperty({ example: 0.123456 })
  cost_usd!: number;

  @ApiProperty({ example: 1200 })
  input_tokens!: number;

  @ApiProperty({ example: 400 })
  output_tokens!: number;
}

export class GatewayApiKeySummaryDto {
  @ApiProperty({ example: 'key_01h...' })
  id!: string;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ example: 'production-app' })
  name!: string;

  @ApiProperty({ example: null, nullable: true })
  description!: string | null;

  @ApiProperty({ example: 'gw_sk_live_abcd...wxyz' })
  key_prefix!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: true })
  allow_auto!: boolean;

  @ApiProperty({ example: false })
  allow_direct!: boolean;

  @ApiProperty({ type: [String], example: [] })
  allowed_nodes!: string[];

  @ApiProperty({ type: [String], example: [] })
  allowed_models!: string[];

  @ApiProperty({ type: [String], example: [] })
  allowed_endpoints!: string[];

  @ApiProperty({ type: [String], example: [] })
  allowed_modalities!: string[];

  @ApiProperty({ example: null, nullable: true })
  namespace_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_name!: string | null;

  @ApiProperty({ example: null, nullable: true })
  team_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  team_name!: string | null;

  @ApiProperty({ example: null, nullable: true })
  daily_token_limit!: number | null;

  @ApiProperty({ example: null, nullable: true })
  daily_cost_limit!: number | null;

  @ApiProperty({ example: null, nullable: true })
  rate_limit_per_minute!: number | null;

  @ApiProperty({ type: GatewayApiKeyTodayDto })
  today!: GatewayApiKeyTodayDto;
}

export class GatewayApiKeyListResponseDto {
  @ApiProperty({ type: [String], example: ['production-app'] })
  keys!: string[];

  @ApiProperty({ type: [GatewayApiKeySummaryDto] })
  items!: GatewayApiKeySummaryDto[];
}

export class GatewayApiKeyMutationResponseDto extends ActionResponseDto {
  @ApiProperty({ type: GatewayApiKeySummaryDto })
  item!: GatewayApiKeySummaryDto;
}

export class GatewayApiKeyCreatedResponseDto extends GatewayApiKeyMutationResponseDto {
  @ApiProperty({
    example: 'gw_sk_redacted',
    description: 'Plain Gateway API key returned once. Example is redacted.',
  })
  key!: string;
}

export class AgentProfileGatewayKeySummaryDto {
  @ApiProperty({ example: 'key_01h...' })
  id!: string;

  @ApiProperty({ example: 'agent-local-key' })
  name!: string;

  @ApiProperty({
    example: 'gw_sk_live_abcd...wxyz',
    description: 'Masked Gateway API key metadata only. Plaintext is never returned.',
  })
  key_prefix!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: true })
  allow_auto!: boolean;

  @ApiProperty({ example: false })
  allow_direct!: boolean;

  @ApiProperty({ type: [String], example: [] })
  allowed_models!: string[];

  @ApiProperty({ example: null, nullable: true })
  namespace_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_name!: string | null;
}

export class AgentProfileSummaryDto {
  @ApiProperty({ example: 'profile_01h...' })
  id!: string;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ example: 'Claude Code local' })
  name!: string;

  @ApiProperty({ example: null, nullable: true })
  description!: string | null;

  @ApiProperty({
    enum: [
      'cursor',
      'cline',
      'roo_code',
      'continue',
      'codex',
      'claude_code',
      'opencode',
      'cherry_studio',
      'hermes',
      'openclaw',
      'generic_openai',
      'generic_anthropic',
    ],
    example: 'claude_code',
  })
  connector!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: 'key_01h...', nullable: true })
  api_key_id!: string | null;

  @ApiProperty({ type: AgentProfileGatewayKeySummaryDto, nullable: true })
  api_key!: AgentProfileGatewayKeySummaryDto | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_name!: string | null;

  @ApiProperty({ example: 'auto' })
  default_model!: string;

  @ApiProperty({ example: 'claude-siftgate-auto' })
  smart_model_id!: string;

  @ApiProperty({
    type: [String],
    example: ['coding-auto', 'coding-fast', 'coding-deep', 'coding-security'],
  })
  virtual_model_aliases!: string[];

  @ApiProperty({
    enum: ['openai_v1', 'anthropic_v1', 'root'],
    example: 'anthropic_v1',
  })
  base_url_mode!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  routing_hint!: Record<string, unknown> | null;

  @ApiProperty({ type: [String], example: [] })
  mcp_server_ids!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ example: null, nullable: true })
  last_generated_at!: string | null;

  @ApiProperty({ example: '2026-05-08T00:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-08T00:00:00.000Z' })
  updated_at!: string;
}

export class AgentProfileListResponseDto {
  @ApiProperty({ type: [AgentProfileSummaryDto] })
  items!: AgentProfileSummaryDto[];

  @ApiProperty({ type: [String], example: ['cursor', 'cline', 'codex', 'claude_code'] })
  connectors!: string[];

  @ApiProperty({ example: 'local_only' })
  mode!: string;
}

export class AgentProfileMutationResponseDto extends ActionResponseDto {
  @ApiProperty({ type: AgentProfileSummaryDto })
  item!: AgentProfileSummaryDto;
}

export class AgentProfileGatewayApiKeyRenderDto {
  @ApiProperty({ example: '<SIFTGATE_GATEWAY_API_KEY>' })
  placeholder!: string;

  @ApiProperty({ example: 'gw_sk_live_abcd...wxyz', nullable: true })
  key_prefix!: string | null;

  @ApiProperty({ example: 'agent-local-key', nullable: true })
  name!: string | null;

  @ApiProperty({ example: 'active', nullable: true })
  status!: string | null;
}

export class AgentProfileRenderedCardDto {
  @ApiProperty({ example: 'claude_code-anthropic' })
  id!: string;

  @ApiProperty({ example: 'Claude Code Anthropic-compatible config' })
  title!: string;

  @ApiProperty({ enum: ['openai', 'anthropic', 'root'], example: 'anthropic' })
  protocol!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  fields!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  env!: Record<string, string>;

  @ApiProperty({
    example:
      'export ANTHROPIC_BASE_URL="http://localhost:2099"\nexport ANTHROPIC_AUTH_TOKEN="<SIFTGATE_GATEWAY_API_KEY>"',
  })
  snippet!: string;

  @ApiProperty({ type: [String] })
  notes!: string[];
}

export class AgentProfileRenderedConfigDto {
  @ApiProperty({ example: 'claude_code' })
  connector!: string;

  @ApiProperty({ example: 'Claude Code' })
  connector_label!: string;

  @ApiProperty({ example: 'profile_01h...' })
  profile_id!: string;

  @ApiProperty({ example: 'Claude Code local' })
  profile_name!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: 'http://localhost:2099' })
  base_url!: string;

  @ApiProperty({ enum: ['openai_v1', 'anthropic_v1', 'root'] })
  base_url_mode!: string;

  @ApiProperty({ example: 'claude-siftgate-auto' })
  smart_model_id!: string;

  @ApiProperty({ example: 'auto' })
  default_model!: string;

  @ApiProperty({
    type: [String],
    example: ['coding-auto', 'coding-fast', 'coding-deep', 'coding-security'],
  })
  virtual_model_aliases!: string[];

  @ApiProperty({ type: AgentProfileGatewayApiKeyRenderDto })
  gateway_api_key!: AgentProfileGatewayApiKeyRenderDto;

  @ApiProperty({ example: true })
  secrets_redacted!: true;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  routing_hint!: Record<string, unknown> | null;

  @ApiProperty({ type: [String], example: [] })
  mcp_server_ids!: string[];

  @ApiProperty({ type: [AgentProfileRenderedCardDto] })
  cards!: AgentProfileRenderedCardDto[];
}

export class AgentProfileRenderResponseDto extends ActionResponseDto {
  @ApiProperty({ type: AgentProfileRenderedConfigDto })
  item!: AgentProfileRenderedConfigDto;
}

export class AgentPlatformPrivacyDto {
  @ApiProperty({ example: true })
  metadata_only!: true;

  @ApiProperty({ example: false })
  stores_prompts!: false;

  @ApiProperty({ example: false })
  stores_responses!: false;

  @ApiProperty({ example: false })
  stores_source_code!: false;

  @ApiProperty({ example: false })
  stores_diffs!: false;

  @ApiProperty({ example: false })
  stores_tool_payloads!: false;

  @ApiProperty({ example: false })
  stores_raw_headers!: false;

  @ApiProperty({ example: false })
  stores_provider_keys!: false;

  @ApiProperty({ example: false })
  stores_gateway_key_plaintext!: false;

  @ApiProperty({ example: false })
  stores_media_bytes!: false;

  @ApiProperty({ example: false })
  stores_hidden_reasoning!: false;

  @ApiProperty({ example: false })
  stores_resolved_secrets!: false;
}

export class AgentPlatformAgentDto {
  @ApiProperty({ example: 'profile_01h...' })
  id!: string;

  @ApiProperty({ example: 'PR review agent' })
  name!: string;

  @ApiProperty({ example: null, nullable: true })
  description!: string | null;

  @ApiProperty({ example: 'codex' })
  connector!: string;

  @ApiProperty({ enum: ['active', 'disabled'], example: 'active' })
  status!: string;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ example: 'key_01h...', nullable: true })
  api_key_id!: string | null;

  @ApiProperty({ example: 'engineering-agent-key', nullable: true })
  api_key_name!: string | null;

  @ApiProperty({ example: 'active', nullable: true })
  api_key_status!: string | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  namespace_name!: string | null;

  @ApiProperty({ example: 'auto' })
  default_model!: string;

  @ApiProperty({ example: 'coding-auto' })
  smart_model_id!: string;

  @ApiProperty({ type: [String], example: ['coding-auto', 'coding-fast'] })
  virtual_model_aliases!: string[];

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  routing_hint!: Record<string, unknown> | null;

  @ApiProperty({ type: [String], example: ['local-tools'] })
  mcp_server_ids!: string[];

  @ApiProperty({ example: 3 })
  tool_count!: number;

  @ApiProperty({ example: 3 })
  permitted_tool_count!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      allow_auto: true,
      allow_direct: false,
      allowed_models: [],
      allowed_endpoints: ['mcp'],
    },
  })
  route_policy!: Record<string, unknown>;
}

export class AgentPlatformToolDto {
  @ApiProperty({ example: 'search_docs' })
  name!: string;

  @ApiProperty({ example: 'Search local documentation', nullable: true })
  description!: string | null;

  @ApiProperty({ example: true })
  has_input_schema!: boolean;

  @ApiProperty({ type: [String], example: ['profile_01h...'] })
  permitted_profile_ids!: string[];

  @ApiProperty({ type: [String], example: [] })
  blocked_profile_ids!: string[];

  @ApiProperty({ enum: ['permitted', 'blocked', 'unlinked'], example: 'permitted' })
  permission!: string;

  @ApiProperty({ type: [String], example: ['gateway_key_and_namespace_policy_allow'] })
  policy_reasons!: string[];
}

export class AgentPlatformToolServerDto {
  @ApiProperty({ example: 'local-tools' })
  id!: string;

  @ApiProperty({ example: 'Local Tools' })
  name!: string;

  @ApiProperty({ example: null, nullable: true })
  description!: string | null;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({ example: 'http_json_rpc' })
  transport!: string;

  @ApiProperty({ example: 'http://mcp.local/rpc' })
  endpoint!: string;

  @ApiProperty({ type: [String], example: [] })
  allowed_namespaces!: string[];

  @ApiProperty({ type: [String], example: ['code'] })
  tags!: string[];

  @ApiProperty({ type: [String], example: ['profile_01h...'] })
  linked_profile_ids!: string[];

  @ApiProperty({ type: [AgentPlatformToolDto] })
  tools!: AgentPlatformToolDto[];
}

export class AgentPlatformWorkflowDto {
  @ApiProperty({ example: 'engineering-pr-review-preview' })
  id!: string;

  @ApiProperty({ example: 'Engineering PR Review Preview' })
  name!: string;

  @ApiProperty({ example: 'Preview-only ordered metadata for coding agent steps.' })
  description!: string;

  @ApiProperty({ enum: ['preview'], example: 'preview' })
  status!: string;

  @ApiProperty({ example: false })
  runtime_enabled!: false;

  @ApiProperty({ type: [String], example: ['profile_01h...'] })
  profile_ids!: string[];

  @ApiProperty({ type: [Object] })
  steps!: Array<Record<string, unknown>>;

  @ApiProperty({ type: [Object] })
  edges!: Array<Record<string, unknown>>;
}

export class AgentPlatformSpanDto {
  @ApiProperty({ example: 'req_123' })
  request_id!: string;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  timestamp!: string;

  @ApiProperty({ example: 'codex', nullable: true })
  connector!: string | null;

  @ApiProperty({ example: 'profile_01h...', nullable: true })
  profile_id!: string | null;

  @ApiProperty({ example: 'PR review agent', nullable: true })
  profile_name!: string | null;

  @ApiProperty({ example: 'session-1', nullable: true })
  session_id!: string | null;

  @ApiProperty({ example: 'turn-1', nullable: true })
  turn_id!: string | null;

  @ApiProperty({ example: 'frontend', nullable: true })
  repo!: string | null;

  @ApiProperty({ example: 'web', nullable: true })
  project!: string | null;

  @ApiProperty({ example: 'req_123' })
  route_decision_id!: string;

  @ApiProperty({ example: false })
  fallback!: boolean;

  @ApiProperty({ example: 0 })
  retry_count!: number;

  @ApiProperty({ type: 'object', additionalProperties: true })
  tokens!: Record<string, number>;

  @ApiProperty({ example: 0.001234 })
  cost_usd!: number;

  @ApiProperty({ example: 240 })
  latency_ms!: number;

  @ApiProperty({ example: 200 })
  status_code!: number;
}

export class AgentPlatformResponseDto {
  @ApiProperty({ example: 'v1' })
  version!: string;

  @ApiProperty({ example: true })
  preview!: true;

  @ApiProperty({ example: 'default-workspace' })
  workspace_id!: string;

  @ApiProperty({ example: '2026-05-09T00:00:00.000Z' })
  generated_at!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  a2a_hub!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  tool_registry!: {
    enabled: boolean;
    mode: string;
    injection: Record<string, unknown>;
    servers: AgentPlatformToolServerDto[];
  };

  @ApiProperty({ type: 'object', additionalProperties: true })
  workflow_preview!: {
    preview: true;
    runtime_enabled: false;
    mode: string;
    promise: string;
    workflows: AgentPlatformWorkflowDto[];
  };

  @ApiProperty({ type: 'object', additionalProperties: true })
  memory_gateway!: Record<string, unknown>;

  @ApiProperty({ type: 'object', additionalProperties: true })
  traces!: {
    metadata_only: true;
    spans: AgentPlatformSpanDto[];
  };

  @ApiProperty({ type: AgentPlatformPrivacyDto })
  privacy!: AgentPlatformPrivacyDto;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  totals!: Record<string, number>;
}
