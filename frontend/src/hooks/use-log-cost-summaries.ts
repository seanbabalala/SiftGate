import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWorkspaces } from './use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import { verifyLogCostSummaries } from '@/lib/cost-report-model'
import type { LogCostSummaryPage } from '@/types/pricing'
export function useLogCostSummaries(ids: number[]) {
  const { data } = useWorkspaces(), workspace = data?.active_workspace.id ?? '', signature = ids.join(',')
  const request = useMemo(() => pricingClient(workspace), [workspace])
  return useQuery({ queryKey: ['pricing', workspace, 'log-cost-summaries', signature], enabled: Boolean(workspace && ids.length),
    queryFn: async ({ signal }) => verifyLogCostSummaries(await request<LogCostSummaryPage>(`/log-cost-summaries?ids=${encodeURIComponent(signature)}`, undefined, 'GET', signal), workspace, ids),
    retry: false, refetchInterval: 30000,
  })
}
