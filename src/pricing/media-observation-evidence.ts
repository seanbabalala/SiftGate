import { pricingContentHash } from "./pricing-json";
import { PricingRepositoryError } from "./pricing-repository.types";
import type { MediaTaskContext, MediaTaskRow, MediaTaskObservationRow } from "./media-task.types";
import type { CostComputation, NormalizedUsage, PricingContext } from "./pricing.types";

const conflict = (message: string): never => { throw new PricingRepositoryError("pricing_media_task_conflict", message, 409); };

export function mediaProcessingHash(row: MediaTaskObservationRow): string {
  return pricingContentHash({ id: row.id, task: row.task_id, workspace: row.workspace_id, revision: row.revision,
    observation: row.observation_hash, action: row.action, expected: row.expected_hash, cost: row.cost_json ? JSON.parse(row.cost_json) : null });
}
export function verifyMediaObservation(task: MediaTaskRow, row: MediaTaskObservationRow): void {
  const usage = JSON.parse(row.usage_json) as NormalizedUsage, context = JSON.parse(row.context_json) as PricingContext;
  if (row.task_id !== task.id || row.workspace_id !== task.workspace_id || row.request_id !== task.request_id || row.revision > task.revision ||
    row.observation_hash !== pricingContentHash({ status: row.status, usage, context })) conflict("Media task observation integrity check failed");
  const prepared = row.action !== null || row.cost_json !== null || row.processing_hash !== null;
  if (prepared && (!row.action || !row.cost_json || !row.processing_hash || row.processing_hash !== mediaProcessingHash(row))) conflict("Media task processing integrity check failed");
  if (row.cost_json && pricingContentHash((JSON.parse(row.cost_json) as CostComputation).usage) !== pricingContentHash(usage)) conflict("Media task cost usage differs from observed evidence");
}
export function mediaTaskContext(task: MediaTaskRow): MediaTaskContext {
  const context = JSON.parse(task.context_json) as MediaTaskContext;
  if (pricingContentHash(context) !== task.context_hash || context.identity.workspaceId !== task.workspace_id || context.identity.apiKeyId !== task.api_key_id ||
    context.identity.apiKeyName !== task.api_key_name || context.identity.namespaceId !== task.namespace_id || context.operation !== task.operation ||
    context.target.node_id !== task.node_id || context.target.model !== task.model) conflict("Media task context integrity check failed");
  return context;
}
