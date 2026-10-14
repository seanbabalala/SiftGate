// ===================================================================
// SiftGate — Canonical Internal Format
// ===================================================================
// All three API protocols (chat/completions, responses, messages)
// are normalized into this unified format for internal processing.
// ===================================================================

// ===== Roles =====
export type CanonicalRole = 'system' | 'user' | 'assistant' | 'tool';

// ===== Content Blocks =====
export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: Record<string, unknown>;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
  cache_control?: Record<string, unknown>;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | CanonicalContentBlock[];
  cache_control?: Record<string, unknown>;
}

/** Native Anthropic state. Preserve opaque signatures; never stringify as text. */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export type CanonicalContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

// ===== Messages =====
export interface CanonicalMessage {
  role: CanonicalRole;
  content: string | CanonicalContentBlock[];
}

// ===== Tool Definitions =====
export interface CanonicalTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  cache_control?: Record<string, unknown>;
}

// ===== Tool Choice =====
export type CanonicalToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { name: string };

// ===== Source Format =====
export type SourceFormat =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'rerank'
  | 'image_generation'
  | 'image_edit'
  | 'image_variation'
  | 'audio_transcription'
  | 'audio_translation'
  | 'audio_speech'
  | 'video_generation'
  | 'batch';

export type CanonicalMediaType = 'image' | 'audio' | 'video';

export type CanonicalMediaOperation =
  | 'generation'
  | 'edit'
  | 'variation'
  | 'transcription'
  | 'translation'
  | 'speech';

export interface CanonicalMediaMetadata {
  media_type: CanonicalMediaType;
  operation: CanonicalMediaOperation;
  multipart: boolean;
  file_count: number;
  byte_size: number;
  requested_format?: string | null;
  response_format?: string | null;
}

// ===== Structured Output =====
export type StructuredOutputFormatType =
  | 'text'
  | 'json_object'
  | 'json_schema'
  | 'unknown';

export type StructuredOutputSource =
  | 'chat_completions.response_format'
  | 'responses.text.format'
  | 'messages.output_config.format'
  | 'messages.output_format'
  | 'canonical';

export type StructuredOutputStrategy =
  | 'native'
  | 'passthrough'
  | 'downgraded'
  | 'none';

export interface CanonicalJsonSchemaFormat {
  name?: string;
  description?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

export interface CanonicalResponseFormat {
  type: StructuredOutputFormatType;
  source: StructuredOutputSource;
  raw: unknown;
  json_schema?: CanonicalJsonSchemaFormat;
}

export interface CanonicalStructuredOutput {
  requested: boolean;
  type: StructuredOutputFormatType;
  source: StructuredOutputSource;
  name?: string;
  schema?: Record<string, unknown>;
  strict?: boolean;
}

// ===== Reasoning / Thinking =====
export type CanonicalReasoningEffort =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'unknown';

export type ReasoningSource =
  | 'chat_completions.reasoning_effort'
  | 'responses.reasoning'
  | 'responses.reasoning_effort'
  | 'messages.thinking'
  | 'gemini.thinking_config'
  | 'canonical';

export type ReasoningStrategy =
  | 'native'
  | 'passthrough'
  | 'downgraded'
  | 'unsupported'
  | 'none';

export interface CanonicalThinkingConfig {
  source: ReasoningSource;
  raw: unknown;
  type?: string;
  budget_tokens?: number;
  include_thoughts?: boolean;
}

export interface CanonicalReasoningIntent {
  requested: boolean;
  source: ReasoningSource;
  effort?: CanonicalReasoningEffort;
  budget_tokens?: number;
  thinking?: CanonicalThinkingConfig;
  raw: unknown;
}
// ===== Shared Request Metadata =====
export interface CanonicalRequestMetadata {
  source_format: SourceFormat;
  original_model?: string;
  previous_response_id?: string;
  session_id?: string;
  session_key?: string;
  trace_id?: string;
  raw_headers: Record<string, string>;
  client_source?: string;
  raw_body?: unknown;
  media?: CanonicalMediaMetadata;
  workspace_id?: string | null;
  api_key_name?: string;
  api_key_id?: string;
  namespace_id?: string | null;
  namespace_name?: string | null;
  team_id?: string | null;
  team_name?: string | null;
  agent_profile_id?: string;
  agent_profile_name?: string;
  agent_connector?: string;
  agent_virtual_model?: string;
  agent_requested_model?: string;
  agent_session_id?: string;
  agent_turn_id?: string;
  agent_repo?: string;
  agent_project?: string;
  agent_routing_hint?: Record<string, unknown>;
  provider_credential_id?: string;
  provider_credential_strategy?: string;
  provider_credential_retry_count?: number;
  api_key_permissions?: {
    allow_auto: boolean;
    allow_direct: boolean;
    allowed_nodes: string[];
    allowed_models: string[];
    allowed_endpoints: string[];
    allowed_modalities: string[];
  };
}

// ===== Request =====
export interface CanonicalRequest {
  messages: CanonicalMessage[];
  tools?: CanonicalTool[];
  tool_choice?: CanonicalToolChoice;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  response_format?: CanonicalResponseFormat;
  structured_output?: CanonicalStructuredOutput;
  reasoning_effort?: CanonicalReasoningEffort;
  thinking?: CanonicalThinkingConfig;
  budget_tokens?: number;
  reasoning?: CanonicalReasoningIntent;
  stream: boolean;

  /** Original request metadata, preserved for response denormalization */
  metadata: CanonicalRequestMetadata;
}

// ===== Stop Reason =====
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence';

// ===== Tier =====
export type Tier = 'simple' | 'standard' | 'complex' | 'reasoning' | 'direct' | 'cached';

// ===== Response =====
export interface NativeChatMetadata {
  vertex_ai_grounding_metadata?: unknown;
  vertex_ai_url_context_metadata?: unknown;
}

export interface CanonicalResponse {
  /** Provider grounding metadata, serialized only back to Chat Completions. */
  native_chat_metadata?: NativeChatMetadata;
  /** Original Messages content, used only when serializing back to Messages. */
  native_messages_content?: Record<string, unknown>[];
  id: string;
  content: CanonicalContentBlock[];
  stop_reason: StopReason;
  stop_sequence?: string | null;
  usage: TokenUsage;
  model: string;

  /** Routing metadata for logging / observability */
  routing: {
    tier: Tier;
    node: string;
    latency_ms: number;
    score: number;
    is_fallback: boolean;
    fallback_reason?: string | null;
    credential_id?: string | null;
    credential_strategy?: string | null;
    credential_retry_count?: number;
  };
}

// ===== Embeddings =====
export type CanonicalEmbeddingInput =
  | string
  | string[]
  | number[]
  | number[][];

export interface CanonicalEmbeddingRequest {
  model: string;
  input: CanonicalEmbeddingInput | unknown;
  dimensions?: number;
  encoding_format?: string;
  user?: string;
  metadata: CanonicalRequestMetadata;
}

export interface CanonicalEmbedding {
  index: number;
  embedding: number[] | string;
}

export interface CanonicalEmbeddingResponse {
  id: string;
  object: 'list';
  data: CanonicalEmbedding[];
  usage: TokenUsage;
  model: string;
  routing: {
    tier: Tier;
    node: string;
    latency_ms: number;
    score: number;
    is_fallback: boolean;
    fallback_reason?: string | null;
    credential_id?: string | null;
    credential_strategy?: string | null;
    credential_retry_count?: number;
  };
}

// ===== Rerank =====
export type CanonicalRerankDocument =
  | string
  | Record<string, unknown>;

export interface CanonicalRerankRequest {
  model: string;
  query: string;
  documents: CanonicalRerankDocument[];
  top_n?: number;
  return_documents?: boolean;
  metadata: CanonicalRequestMetadata;
}

export interface CanonicalRerankResult {
  index: number;
  relevance_score: number;
  document?: CanonicalRerankDocument;
}

export interface CanonicalRerankResponse {
  id: string;
  object: 'rerank';
  results: CanonicalRerankResult[];
  usage: TokenUsage;
  model: string;
  routing: {
    tier: Tier;
    node: string;
    latency_ms: number;
    score: number;
    is_fallback: boolean;
    fallback_reason?: string | null;
    credential_id?: string | null;
    credential_strategy?: string | null;
    credential_retry_count?: number;
  };
}

// ===== Images / Audio =====
export type CanonicalMediaSourceFormat =
  | 'image_generation'
  | 'image_edit'
  | 'image_variation'
  | 'audio_transcription'
  | 'audio_translation'
  | 'audio_speech'
  | 'video_generation';

export type CanonicalMediaPayload = Record<string, unknown> | Buffer;
export type CanonicalMediaResponseBody = Record<string, unknown> | Buffer | string;

export interface CanonicalMediaRequest {
  model: string;
  source_format: CanonicalMediaSourceFormat;
  payload: CanonicalMediaPayload;
  content_type: string;
  is_multipart: boolean;
  media: CanonicalMediaMetadata;
  metadata: CanonicalRequestMetadata;
}

export interface CanonicalMediaResponse {
  id: string;
  body: CanonicalMediaResponseBody;
  content_type: string;
  provider_response_type: string;
  usage: TokenUsage;
  model: string;
  routing: {
    tier: Tier;
    node: string;
    latency_ms: number;
    score: number;
    is_fallback: boolean;
    fallback_reason?: string | null;
    credential_id?: string | null;
    credential_strategy?: string | null;
    credential_retry_count?: number;
  };
}

// ===== Token Usage =====
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;  // Anthropic: tokens written to cache
  cache_read_input_tokens?: number;      // Anthropic: cache read; OpenAI: cached_tokens
}

// ===== Stream Events =====
export interface StreamStartEvent {
  type: 'start';
  id: string;
  model: string;
}

export interface StreamTextDelta {
  type: 'text';
  text: string;
}

export interface StreamToolUseDelta {
  type: 'tool_use';
  id: string;
  name?: string;
  input_delta?: string;
}

export interface StreamDeltaEvent {
  type: 'delta';
  content: StreamTextDelta | StreamToolUseDelta;
}

export interface StreamToolCallCompleteEvent {
  type: 'tool_call_complete';
  id: string;
  tool_type: string;
}

export interface StreamStopEvent {
  type: 'stop';
  stop_reason: string;
  usage: TokenUsage;
}

export interface StreamErrorEvent {
  type: 'error';
  error: {
    message: string;
    code?: string;
    type?: string;
    status_code?: number;
  };
}

export interface StreamRawSseEvent {
  type: 'raw_sse';
  text: string;
  events?: CanonicalStreamEvent[];
}

export interface StreamChatMetadataEvent {
  type: 'chat_metadata';
  metadata: NativeChatMetadata;
}

export type CanonicalStreamEvent =
  | StreamChatMetadataEvent
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamToolCallCompleteEvent
  | StreamStopEvent
  | StreamErrorEvent
  | StreamRawSseEvent;

// ===== Normalizer / Denormalizer Interfaces =====

/** Converts protocol-specific input → CanonicalRequest */
export interface Normalizer {
  normalize(body: unknown, headers: Record<string, string>): CanonicalRequest;
}

/** Converts CanonicalRequest → protocol-specific request body for a provider */
export interface RequestDenormalizer {
  denormalize(
    canonical: CanonicalRequest,
    targetModel: string,
  ): Record<string, unknown>;
}

/** Converts CanonicalResponse → protocol-specific response body for the client */
export interface ResponseDenormalizer {
  denormalize(
    canonical: CanonicalResponse,
    sourceFormat: SourceFormat,
  ): Record<string, unknown>;
}
