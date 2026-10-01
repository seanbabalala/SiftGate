import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, apiPut, getActiveWorkspaceId, setActiveWorkspaceId } from '@/lib/api'
import type { WorkspaceAccess, WorkspaceMutationResponse, WorkspaceState } from '@/types/api'

const WORKSPACES_QUERY_KEY = ['workspaces'] as const

async function fetchWorkspaces(): Promise<WorkspaceState> {
  const state = await apiGet<WorkspaceState>('/api/dashboard/workspaces')
  if (!getActiveWorkspaceId()) {
    setActiveWorkspaceId(state.active_workspace.id)
  }
  return state
}

export function useWorkspaces() {
  const queryClient = useQueryClient()
  const query = useQuery<WorkspaceState>({
    queryKey: WORKSPACES_QUERY_KEY,
    queryFn: fetchWorkspaces,
    staleTime: 60_000,
  })

  const refresh = useCallback(async () => {
    await queryClient.fetchQuery({
      queryKey: WORKSPACES_QUERY_KEY,
      queryFn: fetchWorkspaces,
      staleTime: 0,
    })
  }, [queryClient])

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    if (!window.dispatchEvent(new CustomEvent('siftgate:before-workspace-change', { cancelable: true, detail: { workspaceId } }))) return;
    const result = await apiPost<{ state: WorkspaceState }>(
      '/api/dashboard/workspaces/switch',
      { workspace_id: workspaceId },
    )
    setActiveWorkspaceId(workspaceId)
    queryClient.setQueryData(WORKSPACES_QUERY_KEY, result.state)
    void queryClient.resetQueries({
      predicate: (query) => query.queryKey[0] !== WORKSPACES_QUERY_KEY[0],
    })
    window.dispatchEvent(new CustomEvent('siftgate:workspace-change', {
      detail: { workspaceId },
    }))
  }, [queryClient])

  const applyMutationResult = useCallback((result: WorkspaceMutationResponse) => {
    queryClient.setQueryData(WORKSPACES_QUERY_KEY, result.state)
    setActiveWorkspaceId(result.state.active_workspace.id)
    void queryClient.resetQueries({
      predicate: (query) => query.queryKey[0] !== WORKSPACES_QUERY_KEY[0],
    })
    window.dispatchEvent(new CustomEvent('siftgate:workspace-change', {
      detail: { workspaceId: result.state.active_workspace.id },
    }))
    return result
  }, [queryClient])

  const createWorkspace = useCallback(
    async (body: { name: string; slug?: string }) => {
      const result = await apiPost<WorkspaceMutationResponse>('/api/dashboard/workspaces', body)
      return applyMutationResult(result)
    },
    [applyMutationResult],
  )

  const renameWorkspace = useCallback(
    async (workspaceId: string, body: { name?: string; slug?: string }) => {
      const result = await apiPut<WorkspaceMutationResponse>(`/api/dashboard/workspaces/${workspaceId}`, body)
      return applyMutationResult(result)
    },
    [applyMutationResult],
  )

  const disableWorkspace = useCallback(
    async (workspaceId: string) => {
      const result = await apiPost<WorkspaceMutationResponse>(`/api/dashboard/workspaces/${workspaceId}/disable`)
      return applyMutationResult(result)
    },
    [applyMutationResult],
  )

  const reactivateWorkspace = useCallback(
    async (workspaceId: string) => {
      const result = await apiPost<WorkspaceMutationResponse>(`/api/dashboard/workspaces/${workspaceId}/reactivate`)
      return applyMutationResult(result)
    },
    [applyMutationResult],
  )

  return {
    data: query.data ?? null,
    error: query.error,
    isLoading: query.isLoading,
    refresh,
    switchWorkspace,
    createWorkspace,
    renameWorkspace,
    disableWorkspace,
    reactivateWorkspace,
  }
}

export function hasWorkspaceRole(
  access: WorkspaceAccess | null | undefined,
  required: 'viewer' | 'operator' | 'admin',
) {
  const rank = { viewer: 1, operator: 2, admin: 3 }
  return rank[access?.role || 'viewer'] >= rank[required]
}
