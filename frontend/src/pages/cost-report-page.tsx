import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FileChartColumn } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { CardStatic } from '@/components/ui/card'
import { Button, buttonVariants } from '@/components/ui/button'
import { useWorkspaces } from '@/hooks/use-workspaces'
import { PriceInput } from '@/components/pricing/pricing-fields'
import { CostValue } from '@/components/pricing/cost-metadata'
import { ReportCostCell } from '@/components/pricing/report-cost-cell'
import { PricingNavigationGuard, usePricingNavigationState } from '@/components/pricing/pricing-navigation-guard'
import { pricingClient } from '@/lib/pricing-client'
import { emptyCostReportTotals, formatReportTimestamp, mergeCostReportTotals, reportWindowFromInputs, verifyCostReportPage } from '@/lib/cost-report-model'
import { COST_REPORT_STATUSES } from '../../../src/pricing/cost-report.types'
import type { CostReportPage, CostReportTotals, CostReportWindow } from '@/types/pricing'

export function CostReportPageView() {
  const { data, isLoading, error } = useWorkspaces(), { t } = useTranslation('pricing')
  if (isLoading) return <p role="status">{t('report.loading')}</p>
  if (error || !data?.access) return <p role="alert">{t('error.workspace')}</p>
  return <PricingNavigationGuard key={`${data.active_workspace.id}/${data.access.user_id}`}><CostReport workspace={data.active_workspace.id} /></PricingNavigationGuard>
}
interface Scan { window: CostReportWindow; totals: CostReportTotals; page: CostReportPage; pages: number; started: string; complete: boolean }
function CostReport({ workspace }: { workspace: string }) {
  const { t, i18n } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [from, setFrom] = useState(() => new Date(Date.now() - 86400000).toISOString().slice(0, 16)), [to, setTo] = useState(() => new Date(Date.now() + 60000).toISOString().slice(0, 16))
  const [scan, setScan] = useState<Scan | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false)
  const active = useRef<AbortController | null>(null), paused = useRef(false), current = useRef<Scan | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  usePricingNavigationState(false, busy)
  let windowValid = true
  try { reportWindowFromInputs(from, to) } catch { windowValid = false }
  const start = async (fresh: boolean, continueAll: boolean) => {
    if (active.current || !windowValid || !fresh && (!current.current || current.current.complete)) return
    const controller = new AbortController(); active.current = controller; paused.current = false; setBusy(true); setError(false)
    let progress = fresh ? null : current.current
    if (fresh) { setScan(null); current.current = null }
    const selected = progress?.window ?? reportWindowFromInputs(from, to)
    try {
      // Deliberately bounded and sequential. No full table load, off-screen task or timer continues the scan.
      for (let pages = 0; pages < (continueAll ? 200 : 1); pages++) {
        const cursor = progress?.page.next_cursor ?? null
        const query = new URLSearchParams({ ...selected, limit: '50', ...(cursor ? { cursor } : {}) })
        const page = await request<CostReportPage>(`/cost-report?${query}`, undefined, 'GET', controller.signal)
        await verifyCostReportPage(page, workspace, selected, cursor, progress?.page.report_id ?? null)
        if (controller.signal.aborted) return
        const next: Scan = { window: selected, totals: mergeCostReportTotals(progress?.totals ?? emptyCostReportTotals(), page.totals), page, pages: (progress?.pages ?? 0) + 1, started: progress?.started ?? page.scanned_at, complete: page.next_cursor === null }
        progress = next; current.current = next; setScan(next)
        if (next.complete || paused.current) break
      }
    } catch { if (!controller.signal.aborted) setError(true) }
    finally { if (active.current === controller) { active.current = null; if (!controller.signal.aborted) setBusy(false) } }
  }
  const exportSummary = () => {
    if (!scan) return
    const data = { schema: 'siftgate-cost-report-v1', workspace_id: workspace, window: scan.window, report_id: scan.page.report_id, scan_complete: scan.complete, page_count: scan.pages,
      first_read_at: scan.started, last_read_at: scan.page.scanned_at, population: scan.page.population, consistency: scan.page.consistency, totals: scan.totals,
      note: 'Totals cover scanned rows only. Legacy estimates and unknown amounts are separate. This is not a supplier invoice or a single point-in-time snapshot.' }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), link = document.createElement('a'); link.href = url; link.download = 'cost-report-summary.json'; link.click(); URL.revokeObjectURL(url)
  }
  const totals = scan?.totals
  const metrics = totals ? [
    ['report.requests', totals.requests.toLocaleString(i18n.resolvedLanguage)],
    ['report.coverage', `${totals.requests ? (totals.calculated_requests / totals.requests * 100).toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits: 1 }) : '—'}${totals.requests ? '%' : ''}`],
    ['report.unknown', totals.unknown_amount_requests.toLocaleString(i18n.resolvedLanguage)],
    ['report.legacyRequests', totals.legacy_requests.toLocaleString(i18n.resolvedLanguage)],
  ] : []
  return <div className="space-y-5">
    <PageHeader title={t('report.title')} description={t('report.description')} icon={FileChartColumn}>
      <Link to="/logs" className={buttonVariants({ variant: 'outline' })}>{t('cost.back')}</Link>
      <Button variant="outline" disabled={!scan || busy} onClick={exportSummary}>{t('report.export')}</Button>
    </PageHeader>
    <CardStatic className="space-y-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2"><PriceInput type="datetime-local" label={t('report.from')} value={from} disabled={busy} onChange={e => setFrom(e.target.value)} /><PriceInput type="datetime-local" label={t('report.to')} value={to} disabled={busy} onChange={e => setTo(e.target.value)} /></div>
      <p className="text-xs leading-6 text-[var(--foreground-muted)]">{t('report.timeHelp')}</p>
      <div className="flex flex-wrap gap-3"><Button disabled={!windowValid || busy} onClick={() => void start(true, false)}>{t('report.start')}</Button>
        <Button variant="outline" disabled={!scan || scan.complete || busy || from !== scan.window.from.slice(0, 16) || to !== scan.window.to.slice(0, 16)} onClick={() => void start(false, false)}>{t('report.next')}</Button>
        <Button variant="outline" disabled={!scan || scan.complete || busy || from !== scan.window.from.slice(0, 16) || to !== scan.window.to.slice(0, 16)} onClick={() => void start(false, true)}>{t('report.scan')}</Button>
        {busy && <Button variant="ghost" onClick={() => { paused.current = true }}>{t('report.pause')}</Button>}</div>
      {!windowValid && <p role="alert">{t('report.invalidWindow')}</p>}
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">{t('report.error')}</p>}
      <p className="border-l-2 border-amber-500 pl-4 text-sm leading-6">{t('report.scopeHelp')}</p>
    </CardStatic>
    {scan && totals && <>
      <div role="status" className="space-y-1"><p className="font-semibold">{t(busy ? 'report.scanning' : scan.complete ? 'report.complete' : 'report.incomplete', { count: totals.requests, pages: scan.pages })}</p><p className="text-xs leading-6">{t('report.consistency')}</p><p className="text-xs">{t('report.windowUsed')}: {formatReportTimestamp(scan.window.from, i18n.resolvedLanguage)} — {formatReportTimestamp(scan.window.to, i18n.resolvedLanguage)}</p></div>
      <CardStatic className="grid divide-y divide-[var(--border)] sm:grid-cols-2 xl:grid-cols-4 xl:divide-x xl:divide-y-0">{metrics.map(([label, value]) => <div key={label} className="min-w-0 p-5"><p className="text-xs text-[var(--foreground-muted)]">{t(label)}</p><p className="mt-2 break-all text-2xl font-semibold tabular-nums">{value}</p></div>)}</CardStatic>
      <CardStatic className="space-y-4 p-5"><h2 className="text-lg font-semibold">{t('report.amounts')}</h2><p className="text-xs leading-6">{t('report.amountHelp')}</p>
        <dl className="grid gap-5 sm:grid-cols-2">{(['calculated_usd', 'estimated_usd', 'legacy_estimate_usd', 'partial_known_usd'] as const).map(key => <div key={key} className="min-w-0"><dt className="text-xs text-[var(--foreground-muted)]">{t(`report.${key}`)}</dt><dd className="mt-1 break-all text-lg"><CostValue value={totals[key]} currency="USD" /></dd></div>)}</dl>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs">{COST_REPORT_STATUSES.map(status => <span key={status}>{t(`status.${status}`)}: {totals.statuses[status].toLocaleString(i18n.resolvedLanguage)}</span>)}</div>
        <p className="text-xs">{t('report.additional', { logs: totals.missing_log_requests, pending: totals.pending_financial_requests })}</p>
      </CardStatic>
      <CardStatic className="overflow-hidden"><h2 className="px-5 pt-5 font-semibold">{t('report.lastPage')}</h2><div className="overflow-x-auto p-5"><table className="w-full min-w-[650px] text-left text-xs"><thead><tr><th className="pb-3">{t('cost.request')}</th><th>{t('cost.model')}</th><th>{t('report.basis')}</th><th className="text-right">{t('cost.upstream')}</th></tr></thead><tbody>{scan.page.rows.map(row => <tr key={row.request_id} className="border-t border-[var(--border)]"><td className="max-w-64 break-all py-3 pr-4">{row.log_id ? <Link className="underline" to={`/logs/${row.log_id}/cost`}>{row.request_id}</Link> : <code>{row.request_id}</code>}<p className="mt-1 text-[var(--foreground-muted)]">{formatReportTimestamp(row.recorded_at, i18n.resolvedLanguage)}</p></td><td className="max-w-48 break-all pr-4">{row.model ?? '—'}<p>{row.node_id ?? '—'}</p></td><td className="max-w-48 pr-4">{t(`report.basis.${row.basis}`)}</td><td className="py-3"><ReportCostCell row={row} /></td></tr>)}</tbody></table></div>{!scan.page.rows.length && <p className="p-5 text-sm">{t('report.empty')}</p>}</CardStatic>
    </>}
  </div>
}
