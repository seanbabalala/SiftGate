import { randomUUID } from 'node:crypto';
import { AsyncResource } from 'node:async_hooks';
import { attachUsageEvidence, getUsageEvidence } from '../canonical/usage-evidence';
import { allocateBatchUsage } from '../pricing/cost-allocation';
import { normalizeCanonicalTokenUsage } from '../pricing/usage-normalizer';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '../config/config.service';
import {
  CanonicalEmbeddingRequest,
  CanonicalEmbeddingResponse,
  CanonicalEmbedding,
  Tier,
} from '../canonical/canonical.types';

type EmbeddingInputKind = 'text' | 'tokens';
type EmbeddingInputItem = string | number[];

interface NormalizedEmbeddingInput {
  kind: EmbeddingInputKind;
  items: EmbeddingInputItem[];
}

interface EmbeddingRoutingMeta {
  tier: Tier;
  score: number;
  is_fallback: boolean;
  fallback_reason?: string | null;
}

type EmbeddingBatchDispatch = (
  canonical: CanonicalEmbeddingRequest,
  nodeId: string,
  model: string,
  routingMeta: EmbeddingRoutingMeta,
  options?: { signal?: AbortSignal },
) => Promise<CanonicalEmbeddingResponse>;

interface BatchEntry {
  id: string;
  key: string;
  canonical: CanonicalEmbeddingRequest;
  inputs: NormalizedEmbeddingInput;
  nodeId: string;
  model: string;
  routingMeta: EmbeddingRoutingMeta;
  resolve: (response: CanonicalEmbeddingResponse) => void;
  reject: (error: Error) => void;
  dispatch: EmbeddingBatchDispatch;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled?: boolean;
  updateSharedAbort?: () => void;
}

interface BatchQueue {
  key: string;
  entries: BatchEntry[];
  inputKind: EmbeddingInputKind;
  itemCount: number;
  timer?: NodeJS.Timeout;
}

@Injectable()
export class EmbeddingBatchingService implements OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingBatchingService.name);
  private readonly queues = new Map<string, BatchQueue>();
  private queuedRequests = 0;

  constructor(private readonly config: ConfigService) {}

  onModuleDestroy(): void {
    const pending: BatchEntry[] = [];
    for (const queue of this.queues.values()) {
      if (queue.timer) {
        clearTimeout(queue.timer);
        queue.timer = undefined;
      }
      pending.push(...queue.entries);
    }
    this.queues.clear();
    this.queuedRequests = 0;

    for (const entry of pending) {
      this.settleEntry(
        entry,
        'reject',
        new Error('Embedding batching service is shutting down.'),
      );
    }
  }

  enqueue(
    canonical: CanonicalEmbeddingRequest,
    nodeId: string,
    model: string,
    routingMeta: EmbeddingRoutingMeta,
    dispatch: EmbeddingBatchDispatch,
    options: { signal?: AbortSignal } = {},
  ): Promise<CanonicalEmbeddingResponse> {
    const cfg = this.config.embeddingBatching;
    if (!cfg.enabled) {
      return dispatch(canonical, nodeId, model, routingMeta);
    }

    if (options.signal?.aborted) {
      return Promise.reject(new Error('Embedding batch request canceled.'));
    }

    const inputs = normalizeEmbeddingInput(canonical.input);
    if (
      !inputs ||
      inputs.items.length === 0 ||
      inputs.items.length > cfg.max_input_items ||
      inputs.items.length > cfg.max_batch_size
    ) {
      return dispatch(canonical, nodeId, model, routingMeta);
    }

    if (this.queuedRequests >= cfg.max_queue) {
      this.logger.warn(
        `Embedding batching queue is full (${this.queuedRequests}/${cfg.max_queue}); forwarding request without batching.`,
      );
      return dispatch(canonical, nodeId, model, routingMeta);
    }

    const key = this.buildBatchKey(canonical, nodeId, model, inputs.kind);

    return new Promise((resolve, reject) => {
      const entry: BatchEntry = {
        id: randomUUID(),
        key,
        canonical,
        inputs,
        nodeId,
        model,
        routingMeta,
        resolve,
        reject,
        dispatch: AsyncResource.bind(dispatch),
        signal: options.signal,
      };

      entry.timer = setTimeout(() => {
        this.cancelEntry(entry, new Error('Embedding batch request timed out.'));
      }, cfg.timeout_ms);
      entry.timer.unref?.();

      if (options.signal) {
        entry.onAbort = () => {
          this.cancelEntry(entry, new Error('Embedding batch request canceled.'));
        };
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }

      let queue = this.queues.get(key);
      if (queue && queue.itemCount + inputs.items.length > cfg.max_batch_size) {
        this.flushQueue(key);
        queue = undefined;
      }
      if (!queue) {
        queue = {
          key,
          entries: [],
          inputKind: inputs.kind,
          itemCount: 0,
        };
        this.queues.set(key, queue);
        queue.timer = setTimeout(() => this.flushQueue(key), cfg.window_ms);
        queue.timer.unref?.();
      }

      queue.entries.push(entry);
      queue.itemCount += inputs.items.length;
      this.queuedRequests += 1;

      if (queue.itemCount >= cfg.max_batch_size) {
        this.flushQueue(key);
      }
    });
  }

  private buildBatchKey(
    canonical: CanonicalEmbeddingRequest,
    nodeId: string,
    model: string,
    inputKind: EmbeddingInputKind,
  ): string {
    const metadata = canonical.metadata || {};
    return JSON.stringify({
      nodeId,
      model,
      dimensions: canonical.dimensions ?? null,
      encoding_format: canonical.encoding_format ?? null,
      user: canonical.user ?? null,
      inputKind,
      workspace: metadata.workspace_id ?? null,
      namespace: metadata.namespace_id ?? null,
      team: metadata.team_id ?? null,
      tenant: metadata.api_key_id || metadata.api_key_name || 'anonymous',
      session: metadata.session_key ?? null,
      credential: metadata.provider_credential_id ?? null,
      configVersion: this.config.getSnapshot?.().version ?? null,
    });
  }

  private cancelEntry(entry: BatchEntry, error: Error): void {
    const key = entry.key;
    const queue = this.queues.get(key);
    if (queue) {
      const index = queue.entries.indexOf(entry);
      if (index !== -1) {
        queue.entries.splice(index, 1);
        queue.itemCount -= entry.inputs.items.length;
        this.queuedRequests = Math.max(0, this.queuedRequests - 1);
      }
      if (queue.entries.length === 0) {
        if (queue.timer) clearTimeout(queue.timer);
        this.queues.delete(key);
      }
    }
    this.settleEntry(entry, 'reject', error);
    entry.updateSharedAbort?.();
  }

  private flushQueue(key: string): void {
    const queue = this.queues.get(key);
    if (!queue) return;

    if (queue.timer) clearTimeout(queue.timer);
    this.queues.delete(key);

    const entries: BatchEntry[] = [];
    this.queuedRequests = Math.max(0, this.queuedRequests - queue.entries.length);
    for (const entry of queue.entries) {
      if (entry.signal?.aborted) {
        this.settleEntry(
          entry,
          'reject',
          new Error('Embedding batch request canceled.'),
        );
      } else {
        entries.push(entry);
      }
    }

    if (entries.length === 0) return;

    void this.dispatchBatch(queue.inputKind, entries);
  }

  private async dispatchBatch(
    inputKind: EmbeddingInputKind,
    entries: BatchEntry[],
  ): Promise<void> {
    const first = entries[0];
    const sharedAbort = new AbortController();
    for (const entry of entries) entry.updateSharedAbort = () => {
      if (entries.every((member) => member.settled || member.signal?.aborted)) sharedAbort.abort();
    };
    const offsets: { entry: BatchEntry; start: number; count: number; estimate: number }[] = [];
    const combinedInputs: EmbeddingInputItem[] = [];

    for (const entry of entries) {
      offsets.push({
        entry,
        start: combinedInputs.length,
        count: entry.inputs.items.length,
        estimate: estimateEmbeddingInputTokens(entry.canonical.input),
      });
      combinedInputs.push(...entry.inputs.items);
    }

    const batchCanonical: CanonicalEmbeddingRequest = {
      ...first.canonical,
      input:
        inputKind === 'text'
          ? (combinedInputs as string[])
          : (combinedInputs as number[][]),
      metadata: { ...first.canonical.metadata },
    };

    try {
      const response = await first.dispatch(
        batchCanonical,
        first.nodeId,
        first.model,
        first.routingMeta,
        { signal: sharedAbort.signal },
      );
      this.resolveBatchEntries(response, offsets);
    } catch (error) {
      for (const entry of entries) {
        this.settleEntry(entry, 'reject', error as Error);
      }
    } finally {
      for (const entry of entries) entry.updateSharedAbort = undefined;
    }
  }

  private resolveBatchEntries(
    response: CanonicalEmbeddingResponse,
    offsets: { entry: BatchEntry; start: number; count: number; estimate: number }[],
  ): void {
    const dataByIndex = new Map<number, CanonicalEmbedding>();
    for (const item of response.data) {
      if (!Number.isSafeInteger(item.index) || item.index < 0 || dataByIndex.has(item.index)) throw new Error('Embedding batch response contains invalid or duplicate item indices.');
      dataByIndex.set(item.index, item);
    }

    const evidence = getUsageEvidence(response.usage);
    const physicalUsage = evidence?.usage ?? normalizeCanonicalTokenUsage(response.usage, {
      adapter_id: 'legacy-embedding-batch', adapter_version: '1', source: 'heuristic', quality: 'estimated',
    }, { absent_cache_is_zero: true });
    const weights = offsets.map((offset) => ({ id: offset.entry.id, weight: String(Math.max(1, offset.estimate)) }));
    const allocated = allocateBatchUsage(physicalUsage, weights);

    offsets.forEach((offset, offsetIndex) => {
      if (offset.entry.settled) return;
      if (offset.entry.signal?.aborted) {
        this.settleEntry(
          offset.entry,
          'reject',
          new Error('Embedding batch request canceled.'),
        );
        return;
      }

      const data: CanonicalEmbedding[] = [];
      for (let i = 0; i < offset.count; i++) {
        const upstreamIndex = offset.start + i;
        const item = dataByIndex.get(upstreamIndex);
        if (!item) {
          this.settleEntry(
            offset.entry,
            'reject',
            new Error(
              `Embedding batch response was missing item index ${upstreamIndex}.`,
            ),
          );
          return;
        }
        data.push({
          index: i,
          embedding: item.embedding,
        });
      }

      const actual = allocated[offsetIndex].quantities.total_input_tokens?.value;
      const inputTokens = actual == null ? offset.estimate : Number(actual);
      const usage = { input_tokens: Number.isSafeInteger(inputTokens) ? inputTokens : 0, output_tokens: 0 };
      attachUsageEvidence(usage, { ...evidence, usage: allocated[offsetIndex] });

      this.settleEntry(offset.entry, 'resolve', {
        id: response.id,
        object: 'list',
        data,
        usage,
        model: response.model,
        routing: {
          ...response.routing,
          ...offset.entry.routingMeta,
          node: offset.entry.nodeId,
          latency_ms: response.routing.latency_ms,
        },
      });
    });
  }

  private settleEntry(
    entry: BatchEntry,
    action: 'resolve',
    value: CanonicalEmbeddingResponse,
  ): void;
  private settleEntry(entry: BatchEntry, action: 'reject', value: Error): void;
  private settleEntry(
    entry: BatchEntry,
    action: 'resolve' | 'reject',
    value: CanonicalEmbeddingResponse | Error,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanupEntry(entry);
    if (action === 'resolve') {
      entry.resolve(value as CanonicalEmbeddingResponse);
    } else {
      entry.reject(value as Error);
    }
  }

  private cleanupEntry(entry: BatchEntry): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.signal && entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = undefined;
    }
  }
}

export function normalizeEmbeddingInput(
  input: unknown,
): NormalizedEmbeddingInput | null {
  if (typeof input === 'string') {
    return { kind: 'text', items: [input] };
  }

  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }

  if (input.every((item) => typeof item === 'string')) {
    return { kind: 'text', items: input as string[] };
  }

  if (input.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    return { kind: 'tokens', items: [input as number[]] };
  }

  if (
    input.every(
      (item) =>
        Array.isArray(item) &&
        item.length > 0 &&
        item.every((token) => typeof token === 'number' && Number.isFinite(token)),
    )
  ) {
    return { kind: 'tokens', items: input as number[][] };
  }

  return null;
}

function estimateEmbeddingInputTokens(input: unknown): number {
  if (typeof input === 'string') {
    return Math.max(1, Math.ceil(input.length / 4));
  }
  if (!Array.isArray(input)) {
    return 0;
  }
  if (input.every((item) => typeof item === 'string')) {
    return Math.max(
      1,
      Math.ceil((input as string[]).reduce((sum, item) => sum + item.length, 0) / 4),
    );
  }
  if (input.every((item) => typeof item === 'number')) {
    return input.length;
  }
  if (
    input.every((item) =>
      Array.isArray(item) &&
      item.every((token) => typeof token === 'number'),
    )
  ) {
    return (input as number[][]).reduce((sum, tokens) => sum + tokens.length, 0);
  }
  return 0;
}
