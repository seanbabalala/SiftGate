import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiDelete, apiGet, apiPost, apiPut, getActiveWorkspaceId } from '@/lib/api'
import type { AlertConnectorInput, AlertConnectorSettings, AlertConnectorTestResult } from '@/types/alert-connectors'

const endpoint = '/api/dashboard/alerts/connectors'
type Change = { revision: string } & (
  { action: 'create'; channel: AlertConnectorInput } |
  { action: 'update'; id: string; channel: AlertConnectorInput } |
  { action: 'remove'; id: string } | { action: 'enabled'; enabled: boolean }
)

export function useAlertConnectors(enabled: boolean) {
  const client = useQueryClient()
  const key = ['alert-connectors', getActiveWorkspaceId()]
  const query = useQuery({ queryKey: key, enabled, staleTime: 15_000,
    queryFn: () => apiGet<AlertConnectorSettings>(endpoint) })
  const change = useMutation({
    mutationFn: (input: Change) => {
      const body = { revision: input.revision }
      if (input.action === 'enabled') return apiPut<AlertConnectorSettings>(`${endpoint}/enabled`, { ...body, enabled: input.enabled })
      if (input.action === 'remove') return apiDelete<AlertConnectorSettings>(`${endpoint}/${encodeURIComponent(input.id)}`, body)
      if (input.action === 'create') return apiPost<AlertConnectorSettings>(endpoint, { ...body, channel: input.channel })
      return apiPut<AlertConnectorSettings>(`${endpoint}/${encodeURIComponent(input.id)}`, { ...body, channel: input.channel })
    },
    onSuccess: (data) => { client.setQueryData(key, data); void client.invalidateQueries({ queryKey: ['alerts'] }) },
    onError: (error) => { if (error instanceof ApiError && error.status === 409) void client.invalidateQueries({ queryKey: key }) },
  })
  const test = useMutation({
    mutationFn: (input: { id: string; revision: string; confirm: true }) => apiPost<AlertConnectorTestResult>(
      `${endpoint}/${encodeURIComponent(input.id)}/test`, { revision: input.revision, confirm: input.confirm }),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['alerts'] }) },
  })
  return { ...query, change, test }
}
