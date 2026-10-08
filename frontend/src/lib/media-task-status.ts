import type { MediaTaskSummary } from '@/types/pricing'

const generationStates = ['pending', 'completed', 'failed', 'cancelled'] as const
const accountingStates = ['reserved', 'submitted', 'pending', 'terminal', 'settled', 'uncertain', 'synchronous'] as const
const generationVariants = {
  pending: 'amber',
  completed: 'emerald',
  failed: 'red',
  cancelled: 'zinc',
  unknown: 'zinc',
} as const

/** A recorded cost or completed accounting task does not establish generation or delivery success. */
export function mediaTaskStatus(task: Pick<MediaTaskSummary, 'state' | 'provider_status'> | null | undefined) {
  const generation = generationStates.find((value) => value === task?.provider_status) ?? 'unknown'
  const accounting = accountingStates.find((value) => value === task?.state) ?? 'unknown'
  return {
    generationKey: `mediaOps.job.${generation}`,
    generationVariant: generationVariants[generation],
    accountingKey: `mediaOps.state.${accounting}`,
    accountingVariant: accounting === 'uncertain' || accounting === 'terminal' ? 'amber' as const : 'zinc' as const,
  }
}

export function mediaTaskSubtotalKey(amount: string | null | undefined) {
  return amount == null ? 'simulation.knownSubtotal' : 'recovery.actual.knownSubtotal'
}
