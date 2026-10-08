import type { EntityManager } from 'typeorm';
import { pricingContentHash } from './pricing-json';
import { PricingRepositoryError } from './pricing-repository.types';

export const pricingBypassAuditId = (workspace: string, request: string) => `pricing-bypass:${pricingContentHash([workspace, request])}`;
export async function recordPricingBypass(manager: EntityManager, workspace: string, request: string, snapshotHash: string, operation: string, reason: 'no_active_bindings' | 'no_media_binding'): Promise<void> {
  const id = pricingBypassAuditId(workspace, request), document = { request_id: request, snapshot_hash: snapshotHash, operation, reason };
  const existing = await manager.createQueryBuilder().select('a.metadata_json', 'metadata_json').from('pricing_audit_events', 'a').where('a.id = :id AND a.workspace_id = :workspace', { id, workspace }).getRawOne<{ metadata_json: string }>();
  if (existing) { if (pricingContentHash(JSON.parse(existing.metadata_json)) !== pricingContentHash(document)) throw new PricingRepositoryError('pricing_version_conflict', 'Pricing bypass identity was reused', 409); return; }
  await manager.createQueryBuilder().insert().into('pricing_audit_events').values({ id, workspace_id: workspace, book_id: null, actor_id: 'system:pricing-admission', action: 'request.pricing_bypassed', reason, metadata_json: JSON.stringify(document), created_at: new Date().toISOString() }).execute();
}
export async function hasPricingBypass(manager: EntityManager, workspace: string, request: string, snapshotHash: string, operation: string): Promise<boolean> {
  const row = await manager.createQueryBuilder().select('a.*').from('pricing_audit_events', 'a').where('a.id = :id AND a.workspace_id = :workspace', { id: pricingBypassAuditId(workspace, request), workspace }).getRawOne<{ action: string; actor_id: string; reason: string; metadata_json: string }>();
  if (!row) return false;
  const document = JSON.parse(row.metadata_json);
  if (row.action !== 'request.pricing_bypassed' || row.actor_id !== 'system:pricing-admission' || !['no_active_bindings', 'no_media_binding'].includes(row.reason) ||
    document.request_id !== request || document.snapshot_hash !== snapshotHash || document.operation !== operation || document.reason !== row.reason)
    throw new PricingRepositoryError('pricing_version_conflict', 'Pricing bypass evidence is inconsistent', 409);
  return true;
}
