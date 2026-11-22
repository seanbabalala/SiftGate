import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { scopedDashboardClient } from '@/lib/pricing-client'

export const GOVERNANCE_DENIAL_REASONS = [
  'budget_exceeded',
  'rate_limited',
  'endpoint_not_allowed',
  'modality_not_allowed',
  'routing_mode_not_allowed',
  'model_not_allowed',
] as const

export type GovernanceDenialReason = (typeof GOVERNANCE_DENIAL_REASONS)[number]
export type GovernanceDenialPeriod = '1h' | '24h' | '7d' | '30d'

export type ContentStoreId =
  | 'response_cache'
  | 'semantic_cache_responses'
  | 'prompt_template_content'
  | 'evaluation_samples'
  | 'shadow_prompt_samples'
  | 'shadow_response_samples'
  | 'system_prompt_capture'

export interface PrivacyPosture {
  metadata_only: boolean
  active_content_stores: number
  content_stores: Array<{
    id: ContentStoreId
    enabled: boolean
    config_path: string
    stores: string
    location: 'memory' | 'database' | 'file'
    requires: string[]
  }>
  plugins: { configured: number; unreviewed: number }
  never_stored: string[]
}

export interface GovernanceDenial {
  id: string
  first_at: string
  last_at: string
  request_count: number
  reason: GovernanceDenialReason
  status_code: number
  budget_scope: string | null
  api_key_id: string | null
  api_key_name: string | null
  namespace_id: string | null
  team_id: string | null
  source_format: string | null
  requested_model: string | null
  client_source: string | null
  first_request_id: string | null
}

export interface GovernanceDenialsResponse {
  data: GovernanceDenial[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

export interface GovernanceDenialSummary {
  period: GovernanceDenialPeriod
  since: string
  total: number
  by_reason: Array<{ reason: GovernanceDenialReason; requests: number }>
  by_key: Array<{ api_key_id: string | null; api_key_name: string | null; requests: number }>
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text ? `?${text}` : ''
}

function useScopedRequest() {
  const { data } = useWorkspaces()
  const workspace = data?.active_workspace.id ?? ''
  const request = useMemo(() => scopedDashboardClient(workspace, '/api/dashboard/governance'), [workspace])
  return { workspace, request }
}

export function useGovernanceDenials(filters: {
  period: GovernanceDenialPeriod
  reason?: string
  apiKeyId?: string
  page: number
  limit: number
}) {
  const { workspace, request } = useScopedRequest()
  return useQuery<GovernanceDenialsResponse>({
    queryKey: ['governance-denials', workspace, filters],
    enabled: Boolean(workspace),
    queryFn: ({ signal }) =>
      request<GovernanceDenialsResponse>(
        `/denials${query({ period: filters.period, reason: filters.reason, api_key_id: filters.apiKeyId, page: filters.page, limit: filters.limit })}`,
        undefined,
        'GET',
        signal,
      ),
    refetchInterval: 30_000,
  })
}

export function useGovernanceDenialSummary(period: GovernanceDenialPeriod = '24h', enabled = true) {
  const { workspace, request } = useScopedRequest()
  return useQuery<GovernanceDenialSummary>({
    queryKey: ['governance-denials-summary', workspace, period],
    enabled: enabled && Boolean(workspace),
    queryFn: ({ signal }) => request<GovernanceDenialSummary>(`/denials/summary${query({ period })}`, undefined, 'GET', signal),
    refetchInterval: 30_000,
  })
}

/** Which content stores the running configuration has turned on. Gateway-wide, read-only. */
export function usePrivacyPosture(enabled = true) {
  const { workspace, request } = useScopedRequest()
  return useQuery<PrivacyPosture>({
    queryKey: ['governance-privacy-posture', workspace],
    enabled: enabled && Boolean(workspace),
    queryFn: ({ signal }) => request<PrivacyPosture>('/privacy-posture', undefined, 'GET', signal),
    staleTime: 60_000,
  })
}
