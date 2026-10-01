import { costHash } from './usage-recovery-form'
import type { HistoricalFxView } from '../../../src/pricing/historical-fx.types'

export interface HistoricalFxReference { workspace: string; request: string; receiptHash: string; version: string; from: string; to: string }
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const instant = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
const positive = (value: unknown): value is string => typeof value === 'string' && /^\d{1,30}(?:\.\d{1,18})?$/.test(value) && /[1-9]/.test(value)
const fail = (): never => { throw Error('invalid_historical_fx') }
export async function verifyHistoricalFx(value: HistoricalFxView, expected: HistoricalFxReference): Promise<HistoricalFxView> {
  const fx = value?.fx, snapshot = value?.snapshot
  if (!value || value.schema_version !== 1 || value.read_only !== true || value.workspace_id !== expected.workspace || value.request_id !== expected.request ||
    value.receipt_hash !== expected.receiptHash || !hash(value.receipt_hash) || !hash(value.evidence_hash) || !fx || fx.version_id !== expected.version ||
    fx.from_currency !== expected.from || fx.to_currency !== expected.to || !/^[A-Z]{3}$/.test(fx.from_currency) || !/^[A-Z]{3}$/.test(fx.to_currency) || fx.from_currency === fx.to_currency ||
    !positive(fx.numerator) || !positive(fx.denominator) || !instant(fx.effective_at) || typeof fx.source_redacted !== 'boolean' ||
    !(fx.source === null ? fx.source_redacted : typeof fx.source === 'string' && fx.source.length > 0 && fx.source.length <= 2048) ||
    !snapshot || snapshot.schema_version !== 1 || snapshot.workspace_id !== expected.workspace || snapshot.report_currency !== expected.to ||
    !hash(snapshot.snapshot_id) || !hash(snapshot.catalog_content_hash) || typeof snapshot.catalog_revision_id !== 'string' || !snapshot.catalog_revision_id ||
    !instant(snapshot.admitted_at) || Date.parse(fx.effective_at) > Date.parse(snapshot.admitted_at)) fail()
  const { evidence_hash, ...body } = value, { snapshot_id, ...descriptor } = snapshot
  if (await costHash(body) !== evidence_hash || await costHash(descriptor) !== snapshot_id) fail()
  return value
}
