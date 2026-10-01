/** Wait for the initial basis attempt, but never unmount a restored retry editor
 * when its failed basis is refetched after a verified acknowledgement. */
export function waitForRecoveryBasis(query: { isLoading: boolean; errorUpdatedAt: number }, hasPending: boolean): boolean {
  return query.isLoading && (!hasPending || query.errorUpdatedAt === 0)
}
