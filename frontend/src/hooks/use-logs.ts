import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { scopedDashboardClient } from '@/lib/pricing-client'
import type { LogsResponse, LogsSummaryResponse } from '@/types/api'

export interface LogFilters {
  tier?: string
  node?: string
  status?: string
  api_key?: string
  api_key_id?: string
  namespace?: string
  period?: string
}

export function useLogs(page: number, limit: number, filters: LogFilters = {}) {
  const { data } = useWorkspaces(), workspace = data?.active_workspace.id ?? ''
  const request = useMemo(() => scopedDashboardClient(workspace), [workspace])
  return useQuery<LogsResponse>({
    queryKey: ['logs', workspace, page, limit, filters],
    enabled: Boolean(workspace),
    queryFn: ({ signal }) =>
      request<LogsResponse>(logsPath('/logs', {
        page,
        limit,
        tier: filters.tier,
        node: filters.node,
        status: filters.status,
        api_key_id: filters.api_key_id,
        api_key: filters.api_key,
        namespace: filters.namespace,
        period: filters.period,
      }), undefined, 'GET', signal),
  })
}

export function useLogsSummary(filters: LogFilters = {}) {
  const { data } = useWorkspaces(), workspace = data?.active_workspace.id ?? ''
  const request = useMemo(() => scopedDashboardClient(workspace), [workspace])
  return useQuery<LogsSummaryResponse>({
    queryKey: ['logs-summary', workspace, filters],
    enabled: Boolean(workspace),
    queryFn: ({ signal }) =>
      request<LogsSummaryResponse>(logsPath('/logs/summary', {
        tier: filters.tier,
        node: filters.node,
        status: filters.status,
        api_key_id: filters.api_key_id,
        api_key: filters.api_key,
        namespace: filters.namespace,
        period: filters.period,
      }), undefined, 'GET', signal),
    staleTime: 15_000,
  })
}

function logsPath(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value))
  return `${path}?${query}`
}
