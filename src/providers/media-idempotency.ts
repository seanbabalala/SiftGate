import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { CanonicalMediaRequest } from '../canonical/canonical.types';
import type { NodeConfig } from '../config/gateway.config';

/** Request-local random identities survive transport retries, never unrelated requests. */
export class MediaIdempotency {
  private readonly seeds = new WeakMap<CanonicalMediaRequest, string>();

  headers(canonical: CanonicalMediaRequest, node: NodeConfig): Record<string, string> {
    if (node.media_idempotency !== true) return {};
    const identity = canonical.metadata.api_key_id || canonical.metadata.api_key_name;
    if (!identity) throw new BadRequestException('Media idempotency requires an authenticated gateway identity');
    const supplied = Object.entries(canonical.metadata.raw_headers).find(([name]) => name.toLowerCase() === 'idempotency-key')?.[1];
    if (supplied !== undefined && !/^[\x21-\x7e]{1,256}$/.test(supplied)) {
      throw new BadRequestException('Idempotency-Key must contain 1–256 printable non-space ASCII characters');
    }
    let seed = supplied || this.seeds.get(canonical);
    if (!seed) { seed = randomUUID(); this.seeds.set(canonical, seed); }
    // Never forward gateway credentials, caller IDs, or arbitrary client headers.
    const scope = [canonical.metadata.workspace_id || 'default', identity,
      canonical.metadata.namespace_id || null, node.id, canonical.source_format, seed];
    return { 'Idempotency-Key': 'sg_media_' + createHash('sha256').update(JSON.stringify(scope)).digest('hex') };
  }
}
