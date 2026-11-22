/** A stored budget (including legacy unknown rows) must not be guessed as high/max. */
export function formatReasoningEffort(
  effort: string | null | undefined,
  budget: number | null | undefined,
  budgetLabel: string,
  emptyLabel: string,
): string {
  if (
    (!effort || effort === 'unknown') &&
    typeof budget === 'number' && Number.isFinite(budget) && budget >= 0
  ) return budgetLabel;
  return effort || emptyLabel;
}
