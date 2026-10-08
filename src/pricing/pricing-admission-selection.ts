import type { CatalogAdmissionPolicy, PricingAdmissionPolicy } from "./pricing-admission.types";

/** Whole-policy precedence; a missing basis never inherits one field from a lower policy. */
export function selectAdmissionPolicy(policies: readonly CatalogAdmissionPolicy[], workspace: string | null, operation?: string): PricingAdmissionPolicy {
  let selected: CatalogAdmissionPolicy | undefined, rank = -1;
  for (const entry of policies) {
    if ((entry.workspace_id !== null && entry.workspace_id !== workspace) || (entry.operation !== undefined && entry.operation !== operation)) continue;
    const priority = Number(entry.workspace_id !== null) * 2 + Number(entry.operation !== undefined);
    if (priority > rank) { selected = entry; rank = priority; }
  }
  return structuredClone(selected?.policy ?? { mode: "compatibility" });
}
