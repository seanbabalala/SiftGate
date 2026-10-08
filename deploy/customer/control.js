'use strict'
// Credentials are never cookies: cookies are not isolated by localhost port.
// This scoped token lives only in this tab's origin-bound sessionStorage.
const SESSION_KEY = 'siftgate-control-session-v1'
const S = { auth: null, user: null, dictionaries: {}, locale: 'en', view: 'control', sites: [], jobs: [], health: null, site: '', job: '', busy: false, detail: {}, forms: {}, proposalKeys: {}, selected: new Set(), authMode: 'login', noticeTimer: null }
const app = document.getElementById('app')
const notice = document.getElementById('notice')
const t = key => S.dictionaries[S.locale]?.[key] || S.dictionaries.en?.[key] || key
const phase = key => S.dictionaries[S.locale]?.['phase_' + key] || S.dictionaries[S.locale]?.['status_' + key] || key
const role = value => S.user?.roles.includes(value)
const canPlan = () => role('planner')
const date = value => value == null ? '—' : new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString(S.locale)
const short = value => typeof value === 'string' && value.length > 24 ? value.slice(0, 13) + '…' + value.slice(-8) : value || '—'
const siteName = id => S.sites.find(item => item.id === id)?.name || short(id)
const stateTone = status => ['completed', 'succeeded'].includes(status) ? 'good' : ['failed', 'rejected', 'needs_attention', 'completed_with_failures'].includes(status) ? 'bad' : ['paused', 'awaiting_promotion', 'planned', 'approval_pending', 'queued'].includes(status) ? 'warn' : ''
function el(tag, attrs, ...children) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs || {})) {
    if (name.startsWith('on')) node.addEventListener(name.slice(2).toLowerCase(), value)
    else if (name === 'class') node.className = value
    else if (name === 'text') node.textContent = value
    else if (name === 'checked' || name === 'disabled' || name === 'selected') node[name] = !!value
    else if (value !== undefined && value !== null) node.setAttribute(name, value)
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  return node
}
function button(label, action, options = {}) { return el('button', { type: 'button', disabled: S.busy || options.disabled, class: options.class || '', onClick: () => { if (!S.busy) action() } }, t(label)) }
function badge(status) { return el('span', { class: 'tag ' + stateTone(status) }, t('status_' + status)) }
function brand() { return el('div', { class: 'brand' }, el('img', { src: '/favicon.svg', alt: 'SiftGate', width: 36, height: 36 }), el('div', {}, 'SiftGate', el('small', {}, 'CONTROL ROOM'))) }
function textNotice(message, error = false) {
  clearTimeout(S.noticeTimer); notice.className = error ? 'error' : ''; notice.textContent = message
  S.noticeTimer = setTimeout(() => { notice.textContent = '' }, 7000)
}
async function api(path, method = 'GET', body) {
  const headers = {}
  if (S.auth) headers.Authorization = 'Bearer ' + S.auth.token
  if (method !== 'GET') { headers['Content-Type'] = 'application/json'; if (S.auth) headers['X-SiftGate-CSRF'] = S.auth.csrf }
  const response = await fetch(path, { method, headers, credentials: 'omit', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login' && path !== '/api/activate') { S.auth = null; S.user = null; sessionStorage.removeItem(SESSION_KEY); render() }
    const error = new Error(data.error_code || 'control_request_failed'); error.data = data; error.status = response.status; throw error
  }
  return data
}
async function act(action, success = true) {
  if (S.busy) return
  S.busy = true
  render()
  try { await action(); if (success) textNotice(t('done')); await refresh(false) }
  catch (error) { textNotice(error.status === 401 ? t('signInAgain') : t('actionFailed') + ': ' + error.message, true) }
  finally { S.busy = false; render() }
}
function formState(key) { return S.forms[key] || (S.forms[key] = {}) }
function field(key, name, label, initial = '', type = 'text', attrs = {}) {
  const values = formState(key)
  if (!(name in values)) values[name] = initial
  return el('label', {}, t(label), el('input', { type, name, value: values[name], ...attrs, onInput: event => { values[name] = event.target.value } }))
}
function checkbox(key, name, label, initial = false) {
  const values = formState(key); if (!(name in values)) values[name] = initial
  return el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: values[name], onChange: event => { values[name] = event.target.checked } }), el('span', {}, t(label)))
}
function facts(rows) { return el('dl', { class: 'facts' }, rows.map(([name, value]) => el('div', {}, el('dt', {}, t(name)), el('dd', {}, value)))) }
function table(headers, rows) {
  const head = el('thead', {}, el('tr', {}, headers.map(header => el('th', { scope: 'col' }, t(header)))))
  const body = el('tbody', {}, rows.map(row => el('tr', {}, row.map(cell => el('td', {}, cell)))))
  return el('div', { class: 'table-wrap' }, el('table', {}, head, body))
}
function panel(title, ...children) { return el('section', { class: 'panel' }, el('div', { class: 'panel-head' }, el('h2', {}, t(title))), ...children) }
function boundary(key) { return el('p', { class: 'notice' }, t(key)) }
function detailError(key) { return S.detail[key + 'Error'] ? el('p', { class: 'notice', role: 'status' }, t('actionFailed'), ': ', el('code', {}, S.detail[key + 'Error'])) : null }
function command(value) {
  return el('div', {}, el('pre', {}, el('code', {}, value)), button('copy', () => navigator.clipboard.writeText(value).then(() => textNotice(t('copied'))).catch(() => textNotice(t('copyFailed'), true))))
}
function language() {
  return el('select', { 'aria-label': t('language'), onChange: event => { S.locale = event.target.value; localStorage.setItem('siftgate-control-language', S.locale); render() } },
    Object.keys(S.dictionaries).map(value => el('option', { value, selected: value === S.locale }, ({ en: 'English', zh: '简体中文', 'zh-TW': '繁體中文', ja: '日本語', ko: '한국어', th: 'ไทย', es: 'Español' })[value] || value)))
}
function preferredLocale(value) {
  const normalized = String(value || '').replaceAll('_', '-').toLowerCase()
  if (/^zh-(tw|hk|mo|hant)(-|$)/.test(normalized)) return 'zh-TW'
  const primary = normalized.split('-')[0]
  return Object.hasOwn(S.dictionaries, primary) ? primary : 'en'
}
function emptySites() { return el('section', { class: 'empty' }, brand(), el('h2', {}, t('noSites')), el('p', {}, t('noSitesBody')), command('python3 "$INSTALL_DIR/kit/siftgate_agent.py" --directory "$INSTALL_DIR" enroll --confirm\npython3 "$INSTALL_DIR/kit/siftgate_control.py" --home "$CONTROL_HOME" enroll-local \\\n  --name "My gateway" --directory "$INSTALL_DIR" --confirm'), el('small', {}, t('hostEnrollOnly'))) }
function selector() {
  return el('div', { class: 'toolbar' }, el('label', {}, t('selectSite'), el('select', { disabled: S.busy, onChange: async event => { if (S.busy) return; S.site = event.target.value; S.detail = {}; render(); await loadDetail(); render() } }, S.sites.map(site => el('option', { value: site.id, selected: site.id === S.site }, site.name)))), button('refresh', () => act(loadDetail, false)))
}
function pageHeader(title, description) { return el('header', { class: 'page-head' }, el('div', {}, el('p', { class: 'eyebrow' }, 'SIFTGATE / ' + t('nav' + S.view[0].toUpperCase() + S.view.slice(1))), el('h1', {}, t(title)), el('p', {}, t(description))), button('refresh', () => act(() => refresh(true), false))) }
async function refresh(detail = true) {
  if (!S.auth) return
  const [session, sites, jobs, health] = await Promise.all([api('/api/session'), api('/api/sites'), api('/api/jobs'), api('/health')])
  S.user = session.user; S.auth.csrf = session.csrf
  S.sites = sites.sites; S.jobs = jobs.jobs; S.health = health
  if (!S.sites.some(site => site.id === S.site)) S.site = S.sites[0]?.id || ''
  if (!S.jobs.some(job => job.id === S.job)) S.job = S.jobs[0]?.id || ''
  if (detail) await loadDetail()
}
async function loadDetail() {
  const view = S.view, site = S.site
  if (view === 'identity') { if (role('admin')) { const data = await api('/api/users'); if (view === S.view) S.detail.users = data.users } return }
  if (view === 'audit') { const data = await api('/api/audit'); if (view === S.view) S.detail.events = data.events; return }
  if (!site || !['release', 'vault', 'fleet'].includes(view)) return
  const paths = view === 'release' ? ['observation', 'releases'] : view === 'vault' ? ['vault', 'drills'] : ['observation', 'offline']
  for (const path of paths) {
    try {
      const result = await api('/api/sites/' + site + '/' + path)
      if (view === S.view && site === S.site) { S.detail[path] = result; S.detail[path + 'Error'] = false }
    } catch (error) { if (view === S.view && site === S.site) S.detail[path + 'Error'] = error.message }
  }
}
async function navigate(view) { if (S.busy) return; S.view = view; S.detail = {}; render(); try { await loadDetail() } catch (error) { textNotice(t('actionFailed') + ': ' + error.message, true) } render() }
function authView() {
  const activation = S.authMode === 'activate'
  const form = el('form', { class: 'login-form', onSubmit: event => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    act(async () => {
      if (activation) { await api('/api/activate', 'POST', { username: data.get('username'), code: data.get('code'), password: data.get('password') }); S.authMode = 'login'; return }
      const login = await api('/api/login', 'POST', { username: data.get('username'), password: data.get('password') })
      S.auth = { token: login.token, csrf: login.csrf }; S.user = login.user
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(S.auth)); await refresh(true)
    })
  } }, el('p', { class: 'eyebrow' }, t('independent')), el('h2', {}, t(activation ? 'activate' : 'loginTitle')), el('p', {}, t(activation ? 'hostCodeHelp' : 'loginIntro')),
  el('label', {}, t('username'), el('input', { name: 'username', required: true, autocomplete: 'username', pattern: '[a-z][a-z0-9._-]{2,63}', maxlength: 64 })),
  activation ? el('label', {}, t('code'), el('input', { name: 'code', required: true, autocomplete: 'off', spellcheck: 'false', maxlength: 100 })) : null,
  el('label', {}, t('password'), el('input', { type: 'password', name: 'password', required: true, minlength: 12, maxlength: 128, autocomplete: activation ? 'new-password' : 'current-password' })),
  el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', disabled: S.busy }, t(activation ? 'createPassword' : 'signin'))),
  el('div', { class: 'actions' }, button(activation ? 'backLogin' : 'activate', () => { S.authMode = activation ? 'login' : 'activate'; render() }, { class: 'subtle' })),
  el('p', { class: 'muted' }, t('noGatewayPassword')), language())
  return el('div', { class: 'login' }, el('section', { class: 'login-story' }, brand(), el('div', {}, el('p', { class: 'eyebrow' }, 'RELEASE / RECOVERY / FLEET'), el('h1', {}, t('authIntroTitle')), el('p', {}, t('authIntro'))), el('small', {}, t('footerAuthority'))), el('main', { id: 'main', class: 'login-form-area' }, form))
}
function operationName(job) { return t('operation_' + job.plan.targets[0].operation) }
function jobDetails(job) {
  if (!job) return el('p', { class: 'loading-line' }, t('noJobs'))
  const targetRows = job.plan.targets.map(target => {
    const result = job.results.find(item => item.site_id === target.site_id)
    return [siteName(target.site_id), !target.summary.source_version || target.summary.source_version === 'unknown' ? t('unknown') : target.summary.source_version, target.summary.target_version || '—', result ? badge(result.status) : job.inflight?.site_id === target.site_id ? phase(job.inflight.stage) : '—']
  })
  const detail = el('article', { class: 'panel' }, el('div', { class: 'panel-head' }, el('div', {}, el('small', { class: 'digest' }, job.id), el('h2', {}, operationName(job))), badge(job.status)),
    facts([['proposer', job.plan.requester], ['planDigest', el('code', {}, job.plan_digest)], ['updated', date(job.updated_at)], ['revision', job.revision]]),
    job.error_code ? el('p', { class: 'notice', role: 'status' }, t(job.status === 'needs_attention' ? 'reconciliationHelp' : 'replanRequired'), el('code', { class: 'digest' }, job.error_code)) : null,
    table(['targets', 'source', 'target', 'status'], targetRows))
  if (job.approval) detail.append(facts([['approval', job.approval.actor], ['notBefore', date(job.approval.not_before)], ['notAfter', date(job.approval.not_after)]]), boundary('windowNotice'))
  if (job.inflight) detail.append(el('p', { class: 'boundary', role: 'status' }, siteName(job.inflight.site_id), ' / ', phase(job.inflight.stage)))
  detail.append(el('h3', {}, t('progress')), el('ol', { class: 'timeline' }, job.events.slice(-16).map(event => el('li', {}, el('div', {}, phase(event.details?.stage || event.event), el('small', {}, event.actor === 'executor' ? t('executor') : event.actor)), el('time', {}, date(event.at))))))
  for (const result of job.results) {
    if (Array.isArray(result.receipt?.events)) detail.append(el('h3', {}, siteName(result.site_id)), el('ol', { class: 'timeline' }, result.receipt.events.map(event => el('li', {}, el('div', {}, phase(event.stage || event.event)), el('time', {}, date(event.at))))))
  }
  if (job.status === 'planned') {
    if (Date.now() / 1000 > job.plan.approve_before) detail.append(boundary('approvalExpired'))
    else if (job.plan.requester === S.user.name) detail.append(boundary('selfApprovalNotice'))
    else if (!role('approver')) detail.append(boundary('notApprover'))
    else {
      const key = 'approve-' + job.id
      const localTime = offset => { const d = new Date(Date.now() + offset); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
      const disruptive = job.plan.targets.some(target => target.operation !== 'verify_restore')
      detail.append(el('form', { onSubmit: event => {
        event.preventDefault(); const values = formState(key)
        act(() => api('/api/jobs/' + job.id + '/approve', 'POST', { plan_digest: job.plan_digest, not_before: new Date(values.start).toISOString(), not_after: new Date(values.end).toISOString(), accept_downtime: !!values.disruption }))
      } }, el('h3', {}, t('maintenanceWindow')), el('div', { class: 'form-grid' }, field(key, 'start', 'notBefore', localTime(5 * 60000), 'datetime-local', { required: true }), field(key, 'end', 'notAfter', localTime(35 * 60000), 'datetime-local', { required: true })),
      el('small', {}, Intl.DateTimeFormat().resolvedOptions().timeZone), boundary('windowNotice'), disruptive ? checkbox(key, 'disruption', 'acceptDowntime') : boundary('noAutoRestore'), el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', disabled: S.busy }, t('approve')))))
    }
  }
  const failures = job.results.filter(item => item.status !== 'succeeded').length
  if (job.reconciliation) {
    detail.append(boundary(job.reconciliation.confirmed ? 'reconciliationClosed' : 'reconciliationPending'))
    for (const item of job.reconciliation.observations) detail.append(el('p', { class: 'boundary' }, siteName(item.site_id), ' / ', item.confirmed ? badge(item.status) : el('code', { class: 'digest' }, item.error_code)))
  }
  if (job.status === 'needs_attention') {
    detail.append(boundary('reconciliationHelp'))
    if (role('approver') && job.plan.requester !== S.user.name) {
      const key = 'reconcile-' + job.id
      detail.append(checkbox(key, 'cancelPending', 'reconciliationConsent'), el('div', { class: 'actions' }, button('reconcile', () => {
        if (!formState(key).cancelPending) return textNotice(t('reconciliationConsent'), true)
        act(() => api('/api/jobs/' + job.id + '/reconcile', 'POST', { plan_digest: job.plan_digest, revision: job.revision, cancel_pending: true }))
      })))
    } else detail.append(boundary(job.plan.requester === S.user.name ? 'selfApprovalNotice' : 'notApprover'))
  }
  if (['awaiting_promotion', 'paused'].includes(job.status) && role('approver') && job.plan.requester !== S.user.name && !job.error_code) {
    const key = 'promote-' + job.id
    if (failures) detail.append(checkbox(key, 'reviewed', 'ackFailures'))
    detail.append(el('div', { class: 'actions' }, button('promote', () => {
      if (failures && !formState(key).reviewed) return textNotice(t('ackFailures'), true)
      act(() => api('/api/jobs/' + job.id + '/promote', 'POST', { plan_digest: job.plan_digest, acknowledge_failures: failures }))
    }, { class: 'primary' })))
  }
  if ((role('approver') || (role('planner') && job.plan.requester === S.user.name)) && !['completed', 'completed_with_failures', 'cancelled', 'rejected', 'resolved', 'needs_attention'].includes(job.status)) {
    detail.append(boundary('stopNotice'), el('div', { class: 'actions' }, job.status !== 'planned' ? button('pause', () => act(() => api('/api/jobs/' + job.id + '/pause', 'POST', {}))) : null, button('cancel', () => act(() => api('/api/jobs/' + job.id + '/cancel', 'POST', {})), { class: 'danger' })))
  }
  return detail
}
function controlView() {
  return el('div', {}, pageHeader('controlTitle', 'controlIntro'), el('div', { class: 'strip' },
    el('div', {}, el('small', {}, t('executor')), el('strong', {}, el('i', { class: 'dot ' + (S.health?.executor_running ? 'live' : '') }), t(S.health?.executor_running ? 'executorOnline' : 'executorOffline'))),
    el('div', {}, el('small', {}, t('activeJobs')), el('strong', {}, S.jobs.filter(job => ['approval_pending', 'running', 'queued'].includes(job.status)).length)), el('div', {}, el('small', {}, t('pendingApproval')), el('strong', {}, S.jobs.filter(job => ['planned', 'awaiting_promotion'].includes(job.status)).length))),
    !S.sites.length ? emptySites() : !S.jobs.length ? el('div', { class: 'empty' }, el('h2', {}, t('noJobs')), el('p', {}, t('flowBoundary')), button('navRelease', () => navigate('release'), { class: 'primary' })) :
      el('div', { class: 'split' }, el('aside', {}, el('h3', {}, t('journal')), el('div', { class: 'journal' }, S.jobs.map(job => el('button', { type: 'button', class: job.id === S.job ? 'active' : '', onClick: () => { S.job = job.id; render() } }, el('span', {}, operationName(job), el('small', {}, date(job.plan.created_at)), el('small', {}, job.plan.targets.length + ' · ' + t('targets'))), badge(job.status))))), jobDetails(S.jobs.find(job => job.id === S.job))))
}
async function propose(operation, targets, policy = {}) {
  let result
  const spec = { operation, targets, canary: policy.canary ?? 1, wave_size: policy.wave_size ?? 1, failure_threshold: policy.failure_threshold ?? 1 }
  const key = JSON.stringify([S.user?.name, spec])
  const request_id = S.proposalKeys[key] || (S.proposalKeys[key] = 'web-' + crypto.randomUUID().replaceAll('-', ''))
  try { result = await api('/api/proposals', 'POST', { request_id, ...spec }) }
  catch (error) { if (Array.isArray(error.data?.preflight)) S.detail.preflight = error.data.preflight; if (error.status && error.status < 500) delete S.proposalKeys[key]; throw error }
  if (!result.proposal) throw new Error('preflight_not_passed')
  delete S.proposalKeys[key]
  S.job = result.proposal.id; S.view = 'control'; S.detail = {}; S.jobs.unshift(result.proposal)
}
function preflightResults() { return S.detail.preflight ? panel('preflight', table(['targets', 'status'], S.detail.preflight.map(item => [siteName(item.site_id), item.passed ? '✓' : el('code', {}, item.error_code)]))) : null }
function releaseView() {
  const observation = S.detail.observation, key = 'release-' + S.site, values = formState(key)
  if (!S.sites.length) return el('div', {}, pageHeader('releaseTitle', 'releaseIntro'), emptySites())
  const staged = S.detail.releases || []
  const manifest = S.detail.manifest?.manifest
  const inspectedDigest = S.detail.manifest?.release_digest
  const observedStatus = S.detail.observationError ? 'stale' : !observation ? 'waitingSource' : !observation.running ? 'nodeStopped' : observation.ready ? 'nodeReady' : 'nodeNotReady'
  return el('div', {}, pageHeader('releaseTitle', 'releaseIntro'), selector(),
    el('div', { class: 'strip' }, el('div', {}, el('small', {}, t('currentVersion')), el('strong', {}, !observation?.app_version || observation.app_version === 'unknown' ? t('unknown') : observation.app_version)), el('div', {}, el('small', {}, t('status')), el('strong', {}, t(observedStatus))), el('div', {}, el('small', {}, t('cache')), el('strong', {}, S.detail.releasesError ? t('unknown') : staged.length))),
    panel('publishedRelease', button('discover', () => act(async () => { try { S.detail.discovery = await api('/api/sites/' + S.site + '/discover', 'POST', { current_version: observation?.app_version && observation.app_version !== 'unknown' ? observation.app_version : '0.0.0' }); S.detail.discoveryError = false } catch (error) { S.detail.discoveryError = error.message; throw error } }, false)), detailError('discovery'),
      S.detail.discovery?.releases?.length ? table(['publishedRelease', 'status', 'action'], S.detail.discovery.releases.map(item => [item.version, t(item.managed_metadata_available === false ? 'legacyRelease' : 'signatureUnavailable'), button('fetchVerify', () => act(async () => { S.detail.manifest = await api('/api/sites/' + S.site + '/fetch-release', 'POST', { version: item.version }); await loadDetail() }), { disabled: !canPlan() || item.managed_metadata_available === false })])) : el('p', { class: 'loading-line' }, t(S.detail.discovery ? 'nothingPublished' : 'discoveryNotChecked')),
      el('form', { onSubmit: event => { event.preventDefault(); act(async () => { S.detail.manifest = await api('/api/sites/' + S.site + '/fetch-release', 'POST', { version: values.version }); await loadDetail() }) } }, el('div', { class: 'toolbar' }, field(key, 'version', 'manualVersion', '', 'text', { required: true, pattern: '[0-9]+\\.[0-9]+\\.[0-9]+', placeholder: 'X.Y.Z', maxlength: 32 }), el('button', { type: 'submit', disabled: S.busy || !canPlan() }, t('fetchVerify'))))),
    panel('cache', detailError('releases'), staged.length ? table(['currentVersion', 'updated', 'action'], staged.map(item => [item.version || t('unknown'), date(item.verified_at), button('inspect', () => act(async () => { S.detail.manifest = await api('/api/sites/' + S.site + '/inspect-release', 'POST', { release_digest: item.release_digest, offline: !!values.offline }) }, false))])) : el('p', { class: 'muted' }, t('chooseRelease')), checkbox(key, 'offline', 'offlineMode')),
    manifest ? panel('changes', el('div', { class: 'panel-head' }, el('h2', {}, manifest.version), el('span', { class: 'tag good' }, t('signatureVerified'))), facts([['releaseDigest', el('code', {}, inspectedDigest)], ['source', manifest.compatibility.source_versions.join(', ')], ['target', el('code', {}, manifest.platforms['linux/' + observation?.architecture]?.config_digest || '—')]]),
      el('ul', { class: 'release-notes' }, manifest.changes.map(item => el('li', {}, el('span', { class: 'tag' }, item.kind), item.summary))), boundary('compatibilityBound'), el('div', { class: 'actions' }, button('preflight', () => act(() => propose('upgrade', [{ site_id: S.site, release_digest: inspectedDigest, offline: !!values.offline }])), { class: 'primary', disabled: !canPlan() }))) : null,
    preflightResults(), el('div', { class: 'actions' }, button('prepareBackup', () => act(() => propose('backup', [{ site_id: S.site }])), { disabled: !canPlan() })), boundary('flowBoundary'))
}
function vaultView() {
  if (!S.sites.length) return el('div', {}, pageHeader('vaultTitle', 'vaultIntro'), emptySites())
  const backups = S.detail.vault?.items || [], drills = S.detail.drills || []
  return el('div', {}, pageHeader('vaultTitle', 'vaultIntro'), selector(), boundary('checksumNotCurrent'),
    panel('backup', detailError('vault'), backups.length ? table(['backup', 'purpose', 'lastDrill', 'action'], backups.map(item => [el('div', {}, el('code', {}, short(item.id)), el('small', {}, date(item.created_at))), item.purpose || '—', item.last_verified_at ? date(item.last_verified_at) : t('neverDrilled'), button('prepareRestore', () => act(() => propose('verify_restore', [{ site_id: S.site, backup_id: item.id, manifest_digest: item.manifest_digest }])), { disabled: !canPlan() || !item.manifest_digest })])) : !S.detail.vaultError ? el('p', { class: 'muted' }, t('noBackups')) : null, el('div', { class: 'actions' }, button('prepareBackup', () => act(() => propose('backup', [{ site_id: S.site }])), { disabled: !canPlan() }))), detailError('drills'),
    !drills.length ? el('p', { class: 'loading-line' }, t('noDrills')) : drills.map(drill => panel('recoveryPath', el('div', { class: 'panel-head' }, el('div', {}, el('code', { class: 'digest' }, drill.id), el('small', {}, date(drill.updated_at))), badge(drill.status)),
      drill.restore_drill_verified ? el('p', { class: 'boundary' }, t('restoreSuccess')) : el('p', { class: 'notice' }, drill.error_code || t('neverDrilled')),
      drill.evidence ? facts([['configFiles', drill.evidence.configuration_files_verified], ['identityRotation', (drill.evidence.managed_sessions_revoked || drill.evidence.legacy_sessions_revoked) ? '✓' : '—']]) : null,
      drill.evidence?.database ? table(['table', 'rowCount', 'hashChain'], Object.entries(drill.evidence.database.tables).map(([name, info]) => [name, info.rows, el('code', {}, short(info.sha256))])) : null,
      drill.evidence?.legacy_session_rotation_required_before_cutover ? boundary('legacyRecoveryWarning') : null,
      el('p', { class: 'muted' }, t('safeRestoreHelp')), command('python3 "$INSTALL_DIR/kit/siftgate.py" --directory "$NEW_INSTALL_DIR" restore \\\n  --backup "$INSTALL_DIR/backups/' + drill.backup_id + '" --port "$RECOVERY_PORT"'), boundary('noAutoRestore'))))
}
function fleetView() {
  if (!S.sites.length) return el('div', {}, pageHeader('fleetTitle', 'fleetIntro'), emptySites())
  const key = 'fleet', values = formState(key)
  const inbox = S.detail.offline || []
  return el('div', {}, pageHeader('fleetTitle', 'fleetIntro'), table(['selected', 'name', 'group', 'status'], S.sites.map(site => [el('input', { type: 'checkbox', 'aria-label': site.name, checked: S.selected.has(site.id), onChange: event => { if (event.target.checked) S.selected.add(site.id); else S.selected.delete(site.id) } }), site.name, site.group, site.enabled ? site.transport : t('executorOffline')])),
    panel('fleetPlan', el('form', { onSubmit: event => { event.preventDefault(); if (!S.selected.size) return textNotice(t('selectTargets'), true); act(() => propose('upgrade', [...S.selected].map(site_id => ({ site_id, release_digest: values.digest, offline: !!values.offline })), { canary: Number(values.canary), wave_size: Number(values.wave), failure_threshold: Number(values.failures) })) } },
      field(key, 'digest', 'releaseDigest', '', 'text', { required: true, pattern: '[a-f0-9]{64}', maxlength: 64, spellcheck: 'false' }), el('div', { class: 'form-grid' }, field(key, 'canary', 'canary', '1', 'number', { min: 1, max: 100, required: true }), field(key, 'wave', 'waveSize', '1', 'number', { min: 1, max: 10, required: true }), field(key, 'failures', 'failureThreshold', '1', 'number', { min: 1, max: 100, required: true })), checkbox(key, 'offline', 'offlineMode'), boundary('sequentialWaves'), el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', disabled: S.busy || !canPlan() }, t('fleetPlan'))))),
    preflightResults(), selector(), panel('offlineInbox', el('p', { class: 'muted' }, t('stageOfflineHelp')), boundary('offlineHelp'), detailError('offline'), inbox.length ? table(['name', 'currentVersion', 'action'], inbox.map(item => [short(item.id), item.version || t('unknown'), button('importOffline', () => act(() => api('/api/sites/' + S.site + '/import-offline', 'POST', { package_id: item.id })), { disabled: !canPlan() || !item.version })])) : !S.detail.offlineError ? el('p', { class: 'loading-line' }, t('noOffline')) : null,
      command('python3 "$INSTALL_DIR/kit/siftgate_agent.py" --directory "$INSTALL_DIR" stage-offline \\\n  --source "$OFFLINE_PACKAGE" --confirm')))
}
function identityView() {
  const users = S.detail.users || []
  const key = 'invitation', values = formState(key)
  return el('div', {}, pageHeader('adminTitle', 'adminIntro'),
    role('admin') ? panel('roles', table(['name', 'roles', 'enabled', 'action'], users.map(user => {
      const key = 'roles-' + user.name, values = formState(key)
      return [user.name, ['viewer', 'planner', 'approver', 'admin'].map(value => checkbox(key, value, 'role_' + value, user.roles.includes(value))), checkbox(key, 'enabled', 'enabled', user.enabled),
        button('save', () => act(() => api('/api/users/' + user.name, 'POST', { roles: ['viewer', 'planner', 'approver', 'admin'].filter(value => values[value]), enabled: !!values.enabled })))]
    }))) : null,
    role('admin') ? panel('invite', el('form', { onSubmit: event => { event.preventDefault(); act(async () => { const roles = ['viewer', 'planner', 'approver', 'admin'].filter(value => values[value]); S.detail.invitation = await api('/api/users/invite', 'POST', { username: values.username, roles }); await loadDetail() }) } }, field(key, 'username', 'username', '', 'text', { required: true, pattern: '[a-z][a-z0-9._-]{2,63}', maxlength: 64 }), ['viewer', 'planner', 'approver', 'admin'].map(value => checkbox(key, value, 'role_' + value, value === 'viewer')), el('div', { class: 'actions' }, el('button', { type: 'submit', class: 'primary', disabled: S.busy }, t('invite')))),
      S.detail.invitation ? el('div', { class: 'code-box' }, el('p', {}, t('inviteCodeNote')), el('code', {}, S.detail.invitation.name), el('code', {}, S.detail.invitation.code)) : null) : null,
    panel('passwordChange', el('form', { onSubmit: event => { event.preventDefault(); const data = new FormData(event.currentTarget); act(async () => { await api('/api/password', 'POST', { current_password: data.get('current'), new_password: data.get('replacement') }); S.auth = null; S.user = null; sessionStorage.removeItem(SESSION_KEY) }) } },
      el('div', { class: 'form-grid' }, el('label', {}, t('currentPassword'), el('input', { type: 'password', name: 'current', autocomplete: 'current-password', required: true })), el('label', {}, t('newPassword'), el('input', { type: 'password', name: 'replacement', autocomplete: 'new-password', required: true, minlength: 12, maxlength: 128 }))), el('div', { class: 'actions' }, el('button', { type: 'submit', disabled: S.busy }, t('changePassword'))))), boundary('recoveryHelp'))
}
function auditView() {
  return el('div', {}, pageHeader('auditTitle', 'auditIntro'), panel('navAudit', table(['time', 'actor', 'action', 'resource'], (S.detail.events || []).map(item => [date(item.event.at), item.event.actor, item.event.action, el('div', {}, short(item.event.target), el('code', { class: 'digest' }, short(item.digest)))]))))
}
function render() {
  document.documentElement.lang = S.locale
  document.querySelector('.skip-link').textContent = t('skipToContent')
  if (!S.user) { app.replaceChildren(authView()); return }
  const pages = [['control', 'navControl'], ['release', 'navRelease'], ['vault', 'navVault'], ['fleet', 'navFleet'], ['identity', 'navIdentity'], ...(role('admin') ? [['audit', 'navAudit']] : [])]
  if (!pages.some(([view]) => view === S.view)) S.view = 'control'
  const sidebar = el('aside', { class: 'sidebar' }, brand(), el('nav', { class: 'nav', 'aria-label': 'SiftGate Control' }, pages.map(([view, label], index) => el('button', { type: 'button', class: view === S.view ? 'active' : '', 'aria-current': view === S.view ? 'page' : null, onClick: () => navigate(view) }, el('span', {}, '0' + (index + 1)), t(label)))), el('div', { class: 'sidebar-bottom' }, el('small', {}, t('independent')), language()))
  const current = { control: controlView, release: releaseView, vault: vaultView, fleet: fleetView, identity: identityView, audit: auditView }[S.view]()
  const layout = el('div', { class: 'layout' }, el('header', { class: 'topbar' }, el('small', {}, t('independent')), el('div', { class: 'account' }, S.user.name, el('span', { class: 'tag' }, S.user.roles.map(value => t('role_' + value)).join(' / ')), button('logout', () => act(async () => { await api('/api/logout', 'POST', {}); S.auth = null; S.user = null; sessionStorage.removeItem(SESSION_KEY) }, false)))), el('main', { id: 'main', class: 'workspace' }, current, el('footer', { class: 'footer' }, t('footerAuthority'), el('p', {}, t('flowBoundary')))))
  app.replaceChildren(sidebar, layout)
}
async function boot() {
  try {
    const response = await fetch('/control-i18n.json', { credentials: 'omit', cache: 'no-store' }); S.dictionaries = await response.json()
    const preferred = localStorage.getItem('siftgate-control-language') || navigator.language
    S.locale = preferredLocale(preferred)
    try { const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY)); if (saved && /^sgc_[A-Za-z0-9_-]{43}$/.test(saved.token)) S.auth = saved } catch { sessionStorage.removeItem(SESSION_KEY) }
    if (S.auth) { try { await refresh(true) } catch { S.auth = null; S.user = null; sessionStorage.removeItem(SESSION_KEY) } }
    else { const state = await api('/api/bootstrap'); if (state.activation_required) S.authMode = 'activate' }
    render()
    setInterval(async () => {
      if (!S.user || S.busy || document.hidden) return
      try { await refresh(false); if (!document.activeElement?.closest('form') && !document.activeElement?.matches('input,select')) render() }
      catch { textNotice(t('stale'), true) }
    }, 5000)
  } catch { app.replaceChildren(el('main', { id: 'main', class: 'workspace' }, el('h1', {}, 'SiftGate Control'), el('p', {}, 'Control interface unavailable. Inspect the independent host service.'))) }
}
boot()
