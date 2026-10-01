import type { CostLedgerSummary, CostReservationRow } from './cost-ledger.types';
import type { PricingRecoveryCaseSummary } from './pricing-orphan.types';

export const RECOVERY_VIEWS = ['open', 'resolved', 'unresolved_cost', 'all'] as const;
export type RecoveryView = typeof RECOVERY_VIEWS[number];
export interface RecoveryInventoryItem extends PricingRecoveryCaseSummary {
  budget_state: CostReservationRow['state'];
  budget_reserved_usd: string;
  budget_committed_usd: string;
  supplier_state: 'known' | 'unknown' | 'evidence_invalid';
  request_cost_status: CostLedgerSummary['status'] | null;
  request_amount_usd: string | null;
  known_request_subtotal_usd: string | null;
}
export interface RecoveryInventoryPage {
  items: RecoveryInventoryItem[];
  view: RecoveryView;
  limit: number;
  scanned: number;
  next_cursor: string | null;
  coverage: 'recorded_recovery_cases';
}
