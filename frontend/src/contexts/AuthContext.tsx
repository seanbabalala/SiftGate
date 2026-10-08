import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { i18n } from '@/i18n'
import { authenticationError } from '@/lib/identity-api'

interface IdentityStatus { mode: 'legacy' | 'managed'; setupRequired: boolean; activationExpired: boolean }
const legacyIdentity: IdentityStatus = { mode: 'legacy', setupRequired: false, activationExpired: false }

interface AuthContextValue {
  token: string | null
  authRequired: boolean
  authenticated: boolean
  localLoginEnabled: boolean
  oidc: {
    enabled: boolean
    issuer: string | null
    client_id: string | null
    scopes: string[]
  }
  loading: boolean
  identity: IdentityStatus
  statusError: boolean
  refreshStatus: () => Promise<void>
  login: (password: string, invite?: string | null) => Promise<void>
  completeLogin: (token: string) => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const TOKEN_KEY = 'siftgate-token'

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setAuthToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearAuthToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [token, setToken] = useState<string | null>(() => getAuthToken())
  const [authRequired, setAuthRequired] = useState(true)
  const [sessionAuthenticated, setSessionAuthenticated] = useState(false)
  const [localLoginEnabled, setLocalLoginEnabled] = useState(false)
  const [oidc, setOidc] = useState<AuthContextValue['oidc']>({
    enabled: false,
    issuer: null,
    client_id: null,
    scopes: [],
  })
  const [loading, setLoading] = useState(true)
  const [identity, setIdentity] = useState<IdentityStatus>(legacyIdentity)
  const [statusError, setStatusError] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
    const res = await fetch('/api/auth/status', { credentials: 'same-origin', headers: getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {} })
    if (!res.ok) { setStatusError(true); throw new Error(i18n.t('login:login.authStatusError')) }
    const data = await res.json()
    setIdentity(data.identity ?? legacyIdentity)
    setLocalLoginEnabled(data.localLoginEnabled ?? data.authRequired)
    setAuthRequired(data.authRequired !== false)
    setSessionAuthenticated(Boolean(data.authenticated))
    setOidc(data.oidc ?? { enabled: false, issuer: null, client_id: null, scopes: [] })
    setStatusError(false)
    } catch {
      setStatusError(true); setAuthRequired(true); setSessionAuthenticated(false)
      throw new Error(i18n.t('login:login.authStatusError'))
    }
  }, [])

  // Check auth status on mount
  useEffect(() => {
    let cancelled = false

    async function checkStatus() {
      try {
        const res = await fetch('/api/auth/status', { credentials: 'same-origin', headers: getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {} })
        if (!res.ok) throw new Error(i18n.t('login:login.authStatusError'))
        const data = (await res.json()) as {
          authRequired: boolean
          authenticated?: boolean
          localLoginEnabled?: boolean
          identity?: IdentityStatus
          oidc?: AuthContextValue['oidc']
        }
        if (!cancelled) {
          setAuthRequired(data.authRequired !== false)
          setIdentity(data.identity ?? legacyIdentity)
          setStatusError(false)
          setSessionAuthenticated(Boolean(data.authenticated))
          setLocalLoginEnabled(data.localLoginEnabled ?? data.authRequired)
          setOidc(data.oidc ?? {
            enabled: false,
            issuer: null,
            client_id: null,
            scopes: [],
          })
        }
      } catch {
        // If auth status is unavailable, keep protected routes closed.
        if (!cancelled) {
          setAuthRequired(true)
          setStatusError(true)
          setSessionAuthenticated(false)
          setLocalLoginEnabled(true)
          setOidc({ enabled: false, issuer: null, client_id: null, scopes: [] })
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    checkStatus()
    return () => { cancelled = true }
  }, [])

  const login = useCallback(async (password: string, invite?: string | null) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, invite: invite || undefined }),
    })

    if (!res.ok) {
      throw new Error(await authenticationError(res))
    }

    const data = (await res.json()) as { token: string }
    queryClient.clear()
    setAuthToken(data.token)
    setToken(data.token)
    setSessionAuthenticated(true)
  }, [queryClient])

  const completeLogin = useCallback((nextToken: string) => {
    queryClient.clear()
    setAuthToken(nextToken)
    setToken(nextToken)
    setSessionAuthenticated(true)
  }, [queryClient])

  const logout = useCallback(async () => {
    queryClient.clear()
    clearAuthToken()
    try {
      localStorage.removeItem('siftgate-active-workspace-id')
    } catch {
      // localStorage may be unavailable in hardened browsers.
    }
    setToken(null)
    setSessionAuthenticated(false)
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    }).catch(() => undefined)
  }, [queryClient])

  const authenticated = !statusError && (!authRequired || sessionAuthenticated)

  return (
    <AuthContext.Provider value={{ token, authRequired, authenticated, localLoginEnabled, oidc, loading, identity, statusError, refreshStatus, login, completeLogin, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
