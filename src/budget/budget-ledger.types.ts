export interface BudgetLedgerIdentity {
  workspaceId: string;
  apiKeyName: string | null;
  apiKeyId: string | null;
  namespaceId: string | null;
  teamId: string | null;
}

export interface BudgetLedgerHold {
  ruleId: number;
  workspaceId: string;
  periodStart: string;
  amount: string;
  type: string;
}

/** Transaction-local virtual balances for a multi-member no-write preview. Never persist or reuse across requests. */
export type BudgetLedgerPreview = Map<string, string>;
