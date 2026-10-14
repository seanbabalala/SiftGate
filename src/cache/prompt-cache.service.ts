// ===================================================================
// PromptCacheService — In-memory LRU cache for deterministic responses
// ===================================================================
// Caches CanonicalResponse keyed by SHA-256 hash of request semantics.
// Only caches temperature=0 (deterministic) requests.
// Format-agnostic: caches at the canonical layer, works for all protocols.
//
// Features:
//   - LRU eviction via Map insertion-order trick
//   - TTL expiration (checked lazily on read)
//   - Per-entry size limit (1MB)
//   - Dashboard stats (hit rate, entries, memory)
// ===================================================================

import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { ConfigService } from '../config/config.service';
import { CacheConfig } from '../config/gateway.config';
import {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalRequest,
  CanonicalResponse,
} from '../canonical/canonical.types';
import { StateBackendService } from '../state/state-backend.service';
import { normalizeWorkspaceId } from '../workspaces/workspace-scope';
import { hasGeminiNativeTools } from '../canonical/gemini-native-tools';

interface CacheEntry {
  response: CanonicalResponse;
  createdAt: number;
  sizeBytes: number;
}

export interface CacheStats {
  enabled: boolean;
  entries: number;
  maxEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  totalSizeBytes: number;
  memoryMb: number;
}

interface SemanticCacheEntry {
  vector: number[];
  requestHash: string;
  createdAt: number;
  expiresAt: number;
  metadata: {
    source_format: string;
    model: string;
    workspace_id: string | null;
    api_key_id: string | null;
    namespace_id: string | null;
    team_id: string | null;
  };
  response?: CanonicalResponse;
  responseSizeBytes?: number;
}

export interface SemanticCacheLookupResult {
  matched: boolean;
  hit: boolean;
  score: number | null;
  threshold: number;
  response: CanonicalResponse | null;
  metadataOnly: boolean;
  reason:
    | 'disabled'
    | 'ineligible'
    | 'miss'
    | 'metadata_match'
    | 'hit';
}

export interface SemanticCacheStats {
  enabled: boolean;
  backend: string;
  vectorBackend: string;
  entries: number;
  maxEntries: number;
  matches: number;
  hits: number;
  misses: number;
  threshold: number;
  storeResponses: boolean;
  ttlSeconds: number;
  isolation: string;
  responseStorageRequiresHeader: boolean;
  invalidations: number;
}

@Injectable()
export class PromptCacheService {
  private readonly logger = new Logger(PromptCacheService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private totalSizeBytes = 0;
  private readonly semanticCache = new Map<string, SemanticCacheEntry>();
  private semanticHits = 0;
  private semanticMatches = 0;
  private semanticMisses = 0;
  private semanticInvalidations = 0;

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly stateBackend?: StateBackendService,
  ) {}

  // ══════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════

  /**
   * Check if this request is eligible for caching.
   * Call this before lookup/store to avoid unnecessary key computation.
   */
  shouldCache(canonical: CanonicalRequest): boolean {
    // Search/URL/Maps/execution results must not reuse ordinary chat answers.
    if (hasGeminiNativeTools(canonical)) return false;
    const cfg = this.config.cache;
    if (!cfg.enabled) return false;

    // Only cache deterministic requests (temperature = 0 or unset)
    if (canonical.temperature !== undefined && canonical.temperature !== 0) {
      return false;
    }

    // Must have at least one message
    if (!canonical.messages || canonical.messages.length === 0) {
      return false;
    }

    return true;
  }

  /**
   * Stream caching is an explicit opt-in because replaying long responses can
   * surprise clients that expect a fresh live provider stream.
   */
  shouldCacheStream(canonical: CanonicalRequest): boolean {
    const cfg = this.config.cache;
    if (!cfg.stream_cache?.enabled) return false;
    return this.shouldCache(canonical);
  }

  /**
   * Look up a cached response. Returns deep-cloned response on hit, null on miss.
   */
  lookup(canonical: CanonicalRequest): CanonicalResponse | null {
    if (hasGeminiNativeTools(canonical)) return null;
    const cfg = this.config.cache;
    if (!cfg.enabled) return null;

    const key = this.buildKey(canonical);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    const age = (Date.now() - entry.createdAt) / 1000;
    if (age > cfg.ttl_seconds) {
      // Expired — evict
      this.evictEntry(key, entry);
      this.misses++;
      return null;
    }

    // LRU touch: delete and re-insert to move to end (most recent)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.hits++;
    this.logger.log(`Cache HIT (key=${key.slice(0, 12)}…, age=${age.toFixed(0)}s)`);

    // Return deep clone to prevent mutation
    return JSON.parse(JSON.stringify(entry.response));
  }

  /**
   * Async lookup used by the request pipeline. Memory mode returns immediately;
   * Redis mode reads a String+TTL entry from the shared state backend.
   */
  async lookupAsync(canonical: CanonicalRequest): Promise<CanonicalResponse | null> {
    if (hasGeminiNativeTools(canonical)) return null;
    if (!this.stateBackend?.isRedisConfigured()) {
      return this.lookup(canonical);
    }

    const cfg = this.config.cache;
    if (!cfg.enabled) return null;

    const key = this.buildKey(canonical);
    try {
      const entry = await this.stateBackend.getJson<CacheEntry>('prompt_cache', key);
      if (!entry) {
        this.misses++;
        return null;
      }
      const age = (Date.now() - entry.createdAt) / 1000;
      if (age > cfg.ttl_seconds) {
        await this.stateBackend.delete('prompt_cache', key);
        this.misses++;
        return null;
      }
      this.hits++;
      this.logger.log(`Cache HIT(redis, key=${key.slice(0, 12)}…, age=${age.toFixed(0)}s)`);
      return JSON.parse(JSON.stringify(entry.response));
    } catch (err) {
      this.misses++;
      this.logger.warn(`Cache lookup skipped: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Store a response in the cache.
   */
  store(canonical: CanonicalRequest, response: CanonicalResponse): void {
    const cfg = this.config.cache;
    if (!cfg.enabled) return;
    if (!this.shouldCache(canonical)) return;
    if (!this.shouldStore(response, cfg)) return;

    const key = this.buildKey(canonical);

    // Serialize to measure size
    const json = JSON.stringify(response);
    const sizeBytes = json.length * 2; // rough UTF-16 in-memory estimate

    // Per-entry size limit: 1MB
    if (sizeBytes > 1_048_576) {
      this.logger.debug(`Cache SKIP (response too large: ${(sizeBytes / 1024).toFixed(0)}KB)`);
      return;
    }

    // Evict existing entry for this key (if updating)
    const existing = this.cache.get(key);
    if (existing) {
      this.totalSizeBytes -= existing.sizeBytes;
      this.cache.delete(key);
    }

    // LRU eviction: remove oldest entries until under max
    while (this.cache.size >= cfg.max_entries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldEntry = this.cache.get(oldestKey);
        if (oldEntry) {
          this.totalSizeBytes -= oldEntry.sizeBytes;
        }
        this.cache.delete(oldestKey);
      } else {
        break;
      }
    }

    // Store deep clone
    const entry: CacheEntry = {
      response: JSON.parse(json),
      createdAt: Date.now(),
      sizeBytes,
    };
    this.cache.set(key, entry);
    this.totalSizeBytes += sizeBytes;

    this.logger.log(
      `Cache STORE (key=${key.slice(0, 12)}…, size=${(sizeBytes / 1024).toFixed(1)}KB, entries=${this.cache.size}/${cfg.max_entries})`,
    );
  }

  /**
   * Async store used by the request pipeline. Redis mode writes the same
   * sanitized canonical cache entry as a shared String+TTL value.
   */
  async storeAsync(
    canonical: CanonicalRequest,
    response: CanonicalResponse,
  ): Promise<void> {
    if (!this.stateBackend?.isRedisConfigured()) {
      this.store(canonical, response);
      return;
    }

    const cfg = this.config.cache;
    if (!cfg.enabled) return;
    if (!this.shouldCache(canonical)) return;
    if (!this.shouldStore(response, cfg)) return;

    const key = this.buildKey(canonical);
    const json = JSON.stringify(response);
    const sizeBytes = json.length * 2;
    if (sizeBytes > 1_048_576) {
      this.logger.debug(`Cache SKIP (response too large: ${(sizeBytes / 1024).toFixed(0)}KB)`);
      return;
    }

    const entry: CacheEntry = {
      response: JSON.parse(json),
      createdAt: Date.now(),
      sizeBytes,
    };
    try {
      await this.stateBackend.setJson('prompt_cache', key, entry, cfg.ttl_seconds);
      this.logger.log(
        `Cache STORE(redis, key=${key.slice(0, 12)}…, size=${(sizeBytes / 1024).toFixed(1)}KB)`,
      );
    } catch (err) {
      this.logger.warn(`Cache store skipped: ${(err as Error).message}`);
    }
  }

  /**
   * Get cache statistics for dashboard.
   */
  getStats(): CacheStats {
    const cfg = this.config.cache;
    const total = this.hits + this.misses;
    return {
      enabled: cfg.enabled,
      entries: this.cache.size,
      maxEntries: cfg.max_entries,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Number(((this.hits / total) * 100).toFixed(1)) : 0,
      totalSizeBytes: this.totalSizeBytes,
      memoryMb: Number((this.totalSizeBytes / 1_048_576).toFixed(2)),
    };
  }

  /**
   * Clear all cache entries and reset stats.
   */
  clear(): void {
    const count = this.cache.size;
    this.cache.clear();
    this.totalSizeBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.logger.log(`Cache cleared (${count} entries removed)`);
    if (this.stateBackend?.isRedisConfigured()) {
      this.stateBackend
        .clearNamespace('prompt_cache')
        .catch((err) =>
          this.logger.warn(`Shared cache clear skipped: ${(err as Error).message}`),
        );
    }
  }

  shouldSemanticCache(canonical: CanonicalRequest): boolean {
    if (hasGeminiNativeTools(canonical)) return false;
    const cfg = this.config.semanticCache;
    if (!cfg.enabled) return false;
    if (canonical.stream) return false;
    if (!canonical.messages || canonical.messages.length === 0) return false;
    if (this.extractSemanticText(canonical).length === 0) return false;
    return true;
  }

  lookupSemantic(canonical: CanonicalRequest): SemanticCacheLookupResult {
    const cfg = this.config.semanticCache;
    if (!cfg.enabled) {
      return this.semanticResult('disabled', cfg.similarity_threshold);
    }
    if (!this.shouldSemanticCache(canonical)) {
      return this.semanticResult('ineligible', cfg.similarity_threshold);
    }

    const now = Date.now();
    this.evictExpiredSemanticEntries(now);
    const vector = this.buildSemanticVector(canonical);
    const scope = this.semanticScope(canonical);
    let best: { entry: SemanticCacheEntry; score: number } | null = null;

    for (const entry of this.semanticCache.values()) {
      if (!this.sameSemanticScope(scope, entry.metadata)) continue;
      const score = this.cosineSimilarity(vector, entry.vector);
      if (!best || score > best.score) {
        best = { entry, score };
      }
    }

    if (!best || best.score < cfg.similarity_threshold) {
      this.semanticMisses++;
      return {
        matched: false,
        hit: false,
        score: best ? Number(best.score.toFixed(4)) : null,
        threshold: cfg.similarity_threshold,
        response: null,
        metadataOnly: false,
        reason: 'miss',
      };
    }

    this.semanticMatches++;
    const score = Number(best.score.toFixed(4));
    if (!best.entry.response) {
      return {
        matched: true,
        hit: false,
        score,
        threshold: cfg.similarity_threshold,
        response: null,
        metadataOnly: true,
        reason: 'metadata_match',
      };
    }

    this.semanticHits++;
    return {
      matched: true,
      hit: true,
      score,
      threshold: cfg.similarity_threshold,
      response: JSON.parse(JSON.stringify(best.entry.response)),
      metadataOnly: false,
      reason: 'hit',
    };
  }

  storeSemantic(canonical: CanonicalRequest, response: CanonicalResponse): void {
    const cfg = this.config.semanticCache;
    if (!cfg.enabled || !this.shouldSemanticCache(canonical)) return;
    if (cfg.backend !== 'memory') {
      this.logger.warn(
        `Semantic cache backend "${cfg.backend}" is preview-only; using local memory for this process.`,
      );
    }

    const responseJson = JSON.stringify(response);
    const responseSizeBytes = Buffer.byteLength(responseJson, 'utf8');
    const responseStorageOptedIn =
      !cfg.response_storage_requires_header ||
      truthyHeader(canonical.metadata.raw_headers?.['x-siftgate-semantic-store-response']);
    const canStoreResponse =
      cfg.store_responses &&
      responseStorageOptedIn &&
      responseSizeBytes <= cfg.max_response_bytes;
    const key = this.semanticCacheKey(canonical);
    const entry: SemanticCacheEntry = {
      vector: this.buildSemanticVector(canonical),
      requestHash: key,
      createdAt: Date.now(),
      expiresAt: Date.now() + cfg.ttl_seconds * 1000,
      metadata: this.semanticScope(canonical),
      response: canStoreResponse ? JSON.parse(responseJson) : undefined,
      responseSizeBytes: canStoreResponse ? responseSizeBytes : undefined,
    };

    this.semanticCache.delete(key);
    while (this.semanticCache.size >= cfg.max_entries) {
      const oldest = this.semanticCache.keys().next().value;
      if (oldest === undefined) break;
      this.semanticCache.delete(oldest);
    }
    this.semanticCache.set(key, entry);
  }

  getSemanticStats(): SemanticCacheStats {
    const cfg = this.config.semanticCache;
    this.evictExpiredSemanticEntries(Date.now());
    return {
      enabled: cfg.enabled,
      backend: cfg.backend,
      vectorBackend: cfg.backend,
      entries: this.semanticCache.size,
      maxEntries: cfg.max_entries,
      matches: this.semanticMatches,
      hits: this.semanticHits,
      misses: this.semanticMisses,
      threshold: cfg.similarity_threshold,
      storeResponses: cfg.store_responses,
      ttlSeconds: cfg.ttl_seconds,
      isolation: cfg.isolation,
      responseStorageRequiresHeader: cfg.response_storage_requires_header,
      invalidations: this.semanticInvalidations,
    };
  }

  clearSemantic(workspaceId?: string | null): number {
    const before = this.semanticCache.size;
    if (workspaceId === undefined) {
      this.semanticCache.clear();
    } else {
      const normalized = normalizeWorkspaceId(workspaceId);
      for (const [key, entry] of [...this.semanticCache.entries()]) {
        if (normalizeWorkspaceId(entry.metadata.workspace_id) === normalized) {
          this.semanticCache.delete(key);
        }
      }
    }
    const removed = before - this.semanticCache.size;
    if (removed > 0) this.semanticInvalidations += 1;
    if (workspaceId === undefined && this.stateBackend?.isRedisConfigured()) {
      this.stateBackend
        .clearNamespace('semantic_cache')
        .catch((err) =>
          this.logger.warn(`Shared semantic cache clear skipped: ${(err as Error).message}`),
        );
    }
    return removed;
  }

  // ══════════════════════════════════════════════════════
  // Internal
  // ══════════════════════════════════════════════════════

  /**
   * Build a deterministic cache key from the semantic parts of a request.
   * Excludes only transient transport details such as the stream flag.
   * Includes caller/routing context so cached responses do not bleed across keys/sessions.
   */
  buildKey(canonical: CanonicalRequest): string {
    const rawHeaders = canonical.metadata.raw_headers || {};
    const keyData = {
      model: canonical.metadata.original_model || 'auto',
      messages: canonical.messages,
      tools: canonical.tools || null,
      tool_choice: canonical.tool_choice || null,
      temperature: canonical.temperature ?? 0,
      top_p: canonical.top_p ?? null,
      stop: canonical.stop || null,
      max_tokens: canonical.max_tokens ?? null,
      request_context: {
        source_format: canonical.metadata.source_format,
        workspace_id: canonical.metadata.workspace_id ?? null,
        api_key_id: canonical.metadata.api_key_id ?? null,
        api_key_name: canonical.metadata.api_key_name ?? null,
        session_key: canonical.metadata.session_key ?? null,
        routing_headers: {
          'anthropic-version': rawHeaders['anthropic-version'] ?? null,
          'anthropic-beta': rawHeaders['anthropic-beta'] ?? null,
          'user-agent': rawHeaders['user-agent'] ?? null,
        },
      },
    };

    const hash = createHash('sha256')
      .update(JSON.stringify(keyData))
      .digest('hex');

    return hash;
  }

  /**
   * Check if a response should be stored (additional checks beyond shouldCache).
   */
  private shouldStore(response: CanonicalResponse, cfg: CacheConfig): boolean {
    // Skip tool_use responses if configured
    if (cfg.exclude_tool_use && response.stop_reason === 'tool_use') {
      return false;
    }

    return true;
  }

  private semanticResult(
    reason: SemanticCacheLookupResult['reason'],
    threshold: number,
  ): SemanticCacheLookupResult {
    return {
      matched: false,
      hit: false,
      score: null,
      threshold,
      response: null,
      metadataOnly: false,
      reason,
    };
  }

  private semanticCacheKey(canonical: CanonicalRequest): string {
    const keyData = {
      text_hash: createHash('sha256')
        .update(this.extractSemanticText(canonical))
        .digest('hex'),
      scope: this.semanticScope(canonical),
      tools: canonical.tools ? this.hashObject(canonical.tools) : null,
      tool_choice: canonical.tool_choice ? this.hashObject(canonical.tool_choice) : null,
      temperature: canonical.temperature ?? 0,
      max_tokens: canonical.max_tokens ?? null,
    };
    return createHash('sha256').update(JSON.stringify(keyData)).digest('hex');
  }

  private semanticScope(canonical: CanonicalRequest): SemanticCacheEntry['metadata'] {
    return {
      source_format: canonical.metadata.source_format,
      model: canonical.metadata.original_model || 'auto',
      workspace_id: canonical.metadata.workspace_id ?? null,
      api_key_id:
        this.config.semanticCache.isolation === 'workspace_api_key_model'
          ? canonical.metadata.api_key_id ?? null
          : null,
      namespace_id:
        this.config.semanticCache.isolation === 'workspace_api_key_model'
          ? canonical.metadata.namespace_id ?? null
          : null,
      team_id:
        this.config.semanticCache.isolation === 'workspace_api_key_model'
          ? canonical.metadata.team_id ?? null
          : null,
    };
  }

  private sameSemanticScope(
    scope: SemanticCacheEntry['metadata'],
    candidate: SemanticCacheEntry['metadata'],
  ): boolean {
    return (
      scope.source_format === candidate.source_format &&
      (this.config.semanticCache.isolation === 'workspace'
        ? true
        : scope.model === candidate.model) &&
      scope.workspace_id === candidate.workspace_id &&
      scope.api_key_id === candidate.api_key_id &&
      scope.namespace_id === candidate.namespace_id &&
      scope.team_id === candidate.team_id
    );
  }

  private buildSemanticVector(canonical: CanonicalRequest): number[] {
    const dimensions = Math.max(16, Math.floor(this.config.semanticCache.vector_dimensions));
    const vector = new Array<number>(dimensions).fill(0);
    const tokens = this.extractSemanticText(canonical)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, ' url ')
      .replace(/[^a-z0-9_\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/giu, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1);

    for (const token of tokens) {
      const hash = createHash('sha256').update(token).digest();
      const index = hash.readUInt32BE(0) % dimensions;
      const sign = hash[4] % 2 === 0 ? 1 : -1;
      vector[index] += sign;
    }

    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? vector.map((value) => value / norm) : vector;
  }

  private cosineSimilarity(left: number[], right: number[]): number {
    const length = Math.min(left.length, right.length);
    let score = 0;
    for (let index = 0; index < length; index++) {
      score += left[index] * right[index];
    }
    return Math.max(0, Math.min(1, score));
  }

  private extractSemanticText(canonical: CanonicalRequest): string {
    return canonical.messages
      .map((message) => this.messageText(message))
      .join('\n')
      .trim();
  }

  private messageText(message: CanonicalMessage): string {
    if (typeof message.content === 'string') return message.content;
    return message.content.map((block) => this.blockText(block)).join('\n');
  }

  private blockText(block: CanonicalContentBlock): string {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_result') {
      return typeof block.content === 'string'
        ? block.content
        : block.content.map((nested) => this.blockText(nested)).join('\n');
    }
    if (block.type === 'tool_use') return block.name;
    return '';
  }

  private hashObject(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  private evictExpiredSemanticEntries(now: number): void {
    for (const [key, entry] of this.semanticCache.entries()) {
      if (entry.expiresAt <= now) {
        this.semanticCache.delete(key);
      }
    }
  }

  /**
   * Remove a specific entry and update size tracking.
   */
  private evictEntry(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.totalSizeBytes -= entry.sizeBytes;
  }
}

function truthyHeader(value: string | undefined): boolean {
  return typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}
