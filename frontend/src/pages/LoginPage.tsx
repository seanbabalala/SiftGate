import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, Eye, KeyRound, Terminal, AlertCircle, LockKeyhole } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { LanguageSwitcher } from '@/components/i18n/LanguageSwitcher'
import { updateIdentity, validNewPassword } from '@/lib/identity-api'
import './login-page.css'

export function LoginPage({ security = false }: { security?: boolean }) {
  const { t } = useTranslation('login')
  const { token: sessionToken, authenticated, completeLogin, loading: authLoading, localLoginEnabled, login, oidc,
    identity, statusError, refreshStatus, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [recover, setRecover] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [current, setCurrent] = useState('')
  const [code, setCode] = useState('')
  const [visible, setVisible] = useState(false)
  const [capsLock, setCapsLock] = useState(false)
  const [help, setHelp] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(location.state?.credentialChanged === true)
  const [loading, setLoading] = useState(false)
  const mode = security ? 'password' : identity.setupRequired ? 'activate' : recover ? 'recover' : 'login'
  const managed = identity.mode === 'managed'
  const creating = mode !== 'login'
  const available = !security || managed
  const action = mode === 'activate' ? t('identity.activate') : mode === 'recover' ? t('identity.recover')
    : mode === 'password' ? t('identity.changePassword') : t('login.submit')

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    const token = hash.get('token')
    if (token) {
      completeLogin(token)
      window.history.replaceState(null, '', '/')
      navigate('/', { replace: true })
    } else if (hash.get('error')) {
      setError(t('identity.ssoError'))
      window.history.replaceState(null, '', '/login')
    }
  }, [completeLogin, navigate, t])

  useEffect(() => {
    if (!authLoading && authenticated && !security) navigate(managed ? '/launchpad' : '/', { replace: true })
  }, [authenticated, authLoading, navigate, security, managed])

  function switchRecovery() {
    setRecover(value => !value); setError(''); setSuccess(false)
    setPassword(''); setConfirmation(''); setCode(''); setVisible(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setSuccess(false)
    if (creating && !validNewPassword(password)) { setError(t('identity.policy')); return }
    if (creating && password !== confirmation) { setError(t('identity.mismatch')); return }
    setLoading(true)
    try {
      if (mode === 'login') {
        const invite = new URLSearchParams(window.location.search).get('invite')
        await login(password, invite)
      } else {
        await updateIdentity(mode, { password, ...(mode === 'password' ? { current_password: current } : { code }) }, sessionToken)
        setPassword(''); setConfirmation(''); setCode(''); setCurrent(''); setVisible(false)
        if (security) navigate('/login', { replace: true, state: { credentialChanged: true } })
        await logout(); setRecover(false); await refreshStatus(); setSuccess(true)
      }
    } catch (failure) {
      setError(failure instanceof TypeError ? t('identity.unavailable') : failure instanceof Error ? failure.message : t('identity.unavailable'))
    } finally { setLoading(false) }
  }

  function startOidc() {
    const url = new URL('/api/auth/oidc/start', window.location.origin)
    const invite = new URLSearchParams(window.location.search).get('invite')
    if (invite) url.searchParams.set('invite', invite)
    window.location.href = url.toString()
  }

  return (
    <main className="identity-shell">
      <header className="identity-topbar">
        <Link className="identity-brand" to={security ? '/' : '/login'}><img src="/favicon.svg" alt="" width={32} height={32} /><span>{t('login.title')}</span></Link>
        <div className="identity-language-wrap"><LanguageSwitcher className="identity-language" /></div>
      </header>
      <div className="identity-layout">
        <section className="identity-story">
          <p className="identity-eyebrow">{t('identity.eyebrow')}</p>
          <h1>{mode === 'activate' ? t('identity.welcomeTitle') : t('identity.storyTitle')}</h1>
          <p className="identity-story-copy">{t('identity.storyCopy')}</p>
          <ol className="identity-steps" aria-label={t('identity.stepsLabel')}>
            {[t('identity.stepOwn'), t('identity.stepConnect'), t('identity.stepControl')].map((label, index) => (
              <li key={index}><span className="identity-step-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>{label}</li>
            ))}
          </ol>
          <p className="identity-footnote"><LockKeyhole size={14} aria-hidden="true" />{t('identity.localNotice')}</p>
        </section>
        <section className="identity-panel" aria-labelledby="identity-form-title">
          <div className="identity-panel-meta"><span>{creating ? t('identity.secureSetup') : t('identity.access')}</span><LockKeyhole size={18} aria-hidden="true" /></div>
          <h2 id="identity-form-title">{mode === 'activate' ? t('identity.activateTitle') : mode === 'recover' ? t('identity.recoverTitle')
            : security ? t('identity.changePassword') : t('identity.loginTitle')}</h2>
          <p className="identity-panel-copy">{mode === 'activate' ? t('identity.activateCopy') : mode === 'recover' ? t('identity.recoverCopy')
            : security ? t('identity.revokeNotice') : t('login.subtitle')}</p>
          <div className="identity-instance"><span>{t('identity.instance')}</span><code>{window.location.host}</code></div>
          {success && <p className="identity-notice success" role="status"><Check size={17} aria-hidden="true" />{t('identity.success')}</p>}
          {error && <p className="identity-notice error" role="alert"><AlertCircle size={17} aria-hidden="true" />{error}</p>}
          {statusError && <div className="identity-notice error" role="alert"><span>{t('login.authStatusError')}</span><button type="button" onClick={() => void refreshStatus().catch(() => setError(t('identity.unavailable')))}>{t('identity.retry')}</button></div>}
          {identity.setupRequired && identity.activationExpired && <p className="identity-notice" role="status">{t('identity.expired')}</p>}
          {!authLoading && available && (localLoginEnabled || creating) && (
            <form onSubmit={submit} className="identity-form">
              {(mode === 'activate' || mode === 'recover') && <label>{t('identity.code')}<input name="access-code" value={code} onChange={event => setCode(event.target.value.trim())} autoComplete="off" spellCheck={false} maxLength={180} required aria-describedby="identity-code-help" /><small id="identity-code-help">{t('identity.codeHint')}</small></label>}
              {security && <label>{t('identity.currentPassword')}<input name="current-password" type="password" autoComplete="current-password" value={current} onChange={event => setCurrent(event.target.value)} required /></label>}
              <label>{creating ? t('identity.newPassword') : t('login.passwordPlaceholder')}
                <span className="identity-password"><input name={creating ? 'new-password' : 'password'} type={visible ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete={creating ? 'new-password' : 'current-password'} required aria-describedby={creating ? 'identity-policy' : undefined} onKeyUp={event => setCapsLock(event.getModifierState('CapsLock'))} onBlur={() => setCapsLock(false)} /><button type="button" aria-label={visible ? t('identity.hidePassword') : t('identity.showPassword')} aria-pressed={visible} onClick={() => setVisible(value => !value)}><Eye size={18} aria-hidden="true" /></button></span>
                {creating && <small id="identity-policy">{t('identity.policy')}</small>}
              </label>
              {capsLock && <p className="identity-caps" role="status">{t('identity.capsLock')}</p>}
              {creating && <label>{t('identity.confirmPassword')}<input name="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></label>}
              <button type="submit" className="identity-primary" disabled={loading || statusError || !password || (creating && !confirmation)}>{loading ? t('identity.working') : action}<ArrowRight size={18} aria-hidden="true" /></button>
            </form>
          )}
          {authLoading && <p role="status">{t('identity.working')}</p>}
          {!available && <p className="identity-notice">{t('identity.legacyHelp')}</p>}
          {!creating && oidc.enabled && <button className="identity-secondary" type="button" onClick={startOidc}><KeyRound size={16} aria-hidden="true" />{t('login.oidcSubmit')}</button>}
          {managed && !identity.setupRequired && !security && <button className="identity-text-button" type="button" onClick={switchRecovery}>{recover ? t('identity.backToLogin') : t('identity.forgot')}</button>}
          {security && <Link className="identity-text-button" to="/">{t('identity.backToDashboard')}</Link>}
          <div className="identity-help">
            <button type="button" onClick={() => setHelp(value => !value)} aria-expanded={help} aria-controls="identity-help-body"><Terminal size={16} aria-hidden="true" />{t('identity.helpTitle')}<span aria-hidden="true">{help ? '−' : '+'}</span></button>
            {help && <div id="identity-help-body"><p>{t('identity.addressHelp')}</p><p>{managed ? t('identity.managedHelp') : t('identity.legacyHelp')}</p><code>{managed
              ? `python3 "$HOME/siftgate/kit/siftgate.py" --directory "$HOME/siftgate" access-code --purpose ${identity.setupRequired ? 'activate' : 'recover'} --confirm`
              : 'cat "$HOME/siftgate/config/initial-admin-password.txt"'}</code>{managed && <code>{`cat "$HOME/siftgate/config/${identity.setupRequired ? 'activate' : 'recover'}-code.txt"`}</code>}<p>{t('identity.pathHelp')}</p><p>{t('identity.secretNotice')}</p></div>}
          </div>
        </section>
      </div>
      <footer className="identity-footer"><span>{t('identity.footer')}</span>{managed && <span>{t('identity.noRestart')}</span>}</footer>
    </main>
  )
}
