import { getAuthToken } from '@/contexts/AuthContext'

export interface LaunchpadChoice { node_id: string; model: string; key_id: string }
export interface LaunchpadAttempt {
  attempt_id: string; node_id: string; model: string; key_id: string
  prepared_at: string; expires_at: string; status: 'pending' | 'unknown' | 'stale' | 'failed' | 'verified'
  evidence: null | { request_id: string; timestamp: string; status_code: number; node_id: string; model: string; input_tokens: number; output_tokens: number; recorded_cost_usd: number; latency_ms: number }
}
export interface LaunchpadOverview {
  workspace_id: string; timezone: string; next_daily_reset_at: string; observed_at: string
  nodes: { id: string; name: string; enabled: boolean; models: string[] }[]
  selection: null | { node_id: string; model: string; enabled: boolean; target: string; digest: string; pricing_configured: boolean }
  keys: { id: string; name: string; key_prefix: string; daily_token_limit: number; daily_cost_limit: number; rate_limit_per_minute: number }[]
  last_attempt: LaunchpadAttempt | null
}
export interface LaunchpadPrepared {
  workspace_id: string; attempt_id: string; expires_at: string
  request: { path: string; headers: Record<string, string>; body: Record<string, unknown> }
}
export class LaunchpadError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code) }
}
export async function launchpadApi<T>(workspace: string, path = '', body?: unknown): Promise<T> {
  const token = getAuthToken()
  let response: Response
  try {
    response = await fetch(`/api/dashboard/launchpad${path}`, { method: body ? 'POST' : 'GET', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-siftgate-workspace-id': workspace, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined })
  } catch { throw new LaunchpadError('unavailable') }
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new LaunchpadError(typeof error?.error?.code === 'string' ? error.error.code : 'unavailable', response.status)
  }
  return response.json()
}
export async function sendLaunchpadProbe(prepared: LaunchpadPrepared, workspace: string, secret: string): Promise<void> {
  if (prepared.workspace_id !== workspace || prepared.request.path !== '/v1/chat/completions' || !Number.isFinite(Date.parse(prepared.expires_at)) || Date.now() >= Date.parse(prepared.expires_at))
    throw new LaunchpadError('launchpad_review_stale')
  if (!/^launchpad-[a-f0-9-]{36}$/.test(prepared.attempt_id) || prepared.request.body.max_tokens !== 16 || prepared.request.body.stream !== false || typeof prepared.request.body.model !== 'string' || JSON.stringify(prepared.request.body.messages) !== JSON.stringify([{role:'user',content:'Reply with OK.'}])) throw new LaunchpadError('launchpad_review_stale')
  // Real API-key ingress, not an admin Playground shortcut. No cookies, retries,
  // background effects, prompt display, or key in a URL/clipboard/storage.
  const response = await fetch('/v1/chat/completions', { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}`, 'x-session-key': prepared.attempt_id },
    body: JSON.stringify(prepared.request.body), signal: AbortSignal.timeout(60_000) })
  await response.body?.cancel()
  // HTTP success alone isn't the completion signal; the scoped persisted log is.
}
export function readLaunchpadChoice(workspace: string): LaunchpadChoice {
  try {
    const saved = JSON.parse(localStorage.getItem(`siftgate.launchpad.choice.${workspace}`) || '{}')
    return { node_id: typeof saved.node_id === 'string' ? saved.node_id.slice(0, 120) : '',
      model: typeof saved.model === 'string' ? saved.model.slice(0, 240) : '',
      key_id: typeof saved.key_id === 'string' ? saved.key_id.slice(0, 80) : '' }
  } catch { return { node_id: '', model: '', key_id: '' } }
}
export function saveLaunchpadChoice(workspace: string, choice: LaunchpadChoice) {
  try { localStorage.setItem(`siftgate.launchpad.choice.${workspace}`, JSON.stringify({ node_id: choice.node_id, model: choice.model, key_id: choice.key_id })) } catch { /* Optional selection persistence only. */ }
}
export function launchpadSnippet(origin: string, target: string) {
  // Shell-quote serialized data rather than interpolating untrusted model names.
  const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`
  return `curl ${quote(`${origin}/v1/chat/completions`)} \\\n  -H 'Content-Type: application/json' \\\n  -H "Authorization: Bearer $SIFTGATE_API_KEY" \\\n  -d ${quote(JSON.stringify({ model: target, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 16, stream: false }))}`
}
