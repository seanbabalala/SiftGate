import { getAuthToken, clearAuthToken } from '@/contexts/AuthContext'
import { getActiveWorkspaceId, workspaceHeader, ApiError } from '@/lib/api'
import type { PricingDiagnostic } from '@/types/pricing'

export class PricingApiError extends ApiError {
  constructor(status: number, readonly code: string, readonly diagnostics: PricingDiagnostic[] = []) { super(status, code) }
}

/** Capture the workspace in both the cache key and the HTTP request; multi-step actions must never drift scopes. */
export function pricingClient(workspace: string) {
  return scopedDashboardClient(workspace, '/api/dashboard/pricing')
}

export function scopedDashboardClient(workspace: string, prefix = '/api/dashboard') {
  return async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', signal?: AbortSignal): Promise<T> {
    const checkScope = () => { if (getActiveWorkspaceId() !== workspace) throw new PricingApiError(409, 'workspace_changed') }
    checkScope()
    const token = getAuthToken()
    const response = await fetch(`${prefix}${path}`, { method, signal, credentials: 'same-origin', headers: { [workspaceHeader]: workspace, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (response.status === 401) { clearAuthToken(); window.location.href = '/login'; throw new PricingApiError(401, 'unauthorized') }
    const value = await response.json().catch(() => null)
    checkScope()
    if (!response.ok) throw new PricingApiError(response.status, value?.error?.code ?? 'request_failed', value?.diagnostics ?? value?.error?.diagnostics ?? value?.error?.details?.diagnostics ?? [])
    if (value === null) throw new PricingApiError(502, 'invalid_response')
    return value as T
  }
}
