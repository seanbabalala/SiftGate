import { i18n } from '@/i18n'

const messages: Record<string, string> = {
  invalid_credentials: 'login.invalidPassword', invalid_access_code: 'identity.invalidCode',
  password_policy: 'identity.policy', identity_conflict: 'identity.conflict',
  identity_busy: 'identity.unavailable', identity_unavailable: 'identity.unavailable',
  identity_not_managed: 'identity.legacyHelp', managed_invite_unsupported: 'identity.legacyHelp',
}

export async function authenticationError(response: Response): Promise<string> {
  const data = await response.json().catch(() => null)
  if (response.status === 429) return i18n.t('login:identity.rateLimited')
  const key = messages[data?.error?.code]
  if (key) return i18n.t(`login:${key}`)
  if (response.status === 401) return i18n.t('login:login.invalidPassword')
  return i18n.t('login:identity.unavailable')
}

export async function updateIdentity(action: 'activate' | 'recover' | 'password', body: Record<string, string>, token?: string | null) {
  const response = await fetch(`/api/auth/identity/${action}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await authenticationError(response))
}

export function validNewPassword(password: string) {
  return [...password].length >= 15 && new TextEncoder().encode(password).length <= 72 && !password.includes('\0')
}
