import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BookOpen, Plus, RefreshCw, ShieldCheck, Upload } from 'lucide-react'
import { PageHeader } from '@/components/shared/PageHeader'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CardStatic } from '@/components/ui/card'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { SkeletonCard } from '@/components/ui/skeleton'
import { hasWorkspaceRole, useWorkspaces } from '@/hooks/use-workspaces'
import { pricingClient } from '@/lib/pricing-client'
import { newPriceBook } from '@/lib/pricing-model'
import { priceFamilyForOperation, pricingTargetContext } from '@/lib/model-pricing-status'
import type { ModelPricingTarget } from '@/types/pricing'
import { PriceParentPicker } from '@/components/pricing/price-parent-picker'
import { PriceInheritanceFacts } from '@/components/pricing/price-inheritance-facts'
import type { PriceCopy } from '@/lib/price-inheritance-form'
import { verifyInheritancePreview, type InheritancePreview } from '@/lib/price-inheritance-evidence'
import { PriceInput, PriceSelect } from '@/components/pricing/pricing-fields'
import { PriceGovernancePanel } from '@/components/pricing/price-governance-panel'
import { PriceBookEditor } from '@/components/pricing/price-book-editor'
import { PriceBookManagementPanel } from '@/components/pricing/price-book-management-panel'
import { PricingNavigationGuard, usePricingLeaveConfirmation, usePricingNavigationState } from '@/components/pricing/pricing-navigation-guard'
import { PricingDiagnostics, pricingErrorKey } from '@/components/pricing/price-simulator'
import type { PriceBookContent, PriceBookDetail, PricingBookRow, PricingDraft, PricingHead, PriceValidation, PricingInheritanceView } from '@/types/pricing'

export function PricingPage() {
  const { t } = useTranslation('pricing')
  const { data: workspaces, isLoading, error, refresh } = useWorkspaces()
  if (error) return <CardStatic className="p-6"><p role="alert" className="text-sm text-[var(--destructive)]">{t('error.request')}</p><Button variant="outline" onClick={() => void refresh().catch(() => undefined)}>{t('refresh')}</Button></CardStatic>
  return isLoading || !workspaces ? <SkeletonCard /> : <PricingNavigationGuard><PricingWorkspace key={workspaces.active_workspace.id} workspace={workspaces.active_workspace.id} canManage={hasWorkspaceRole(workspaces.access, 'admin')} canInspect={hasWorkspaceRole(workspaces.access, 'operator')} isDefault={workspaces.active_workspace.is_default} /></PricingNavigationGuard>
}
function PricingWorkspace({ workspace, canManage, canInspect, isDefault }: { workspace: string; canManage: boolean; canInspect: boolean; isDefault: boolean }) {
  const { t, i18n } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [params, setParams] = useSearchParams(), queryClient = useQueryClient()
  const [offset, setOffset] = useState(0), [newDialog, setNewDialog] = useState<{ content?: PriceBookContent; name?: string; inheritance?: PricingInheritanceView } | null>(null)
  const guard = usePricingLeaveConfirmation()
  const selected = params.get('book') ?? '', targetContext = pricingTargetContext(params)
  const status = useQuery({ queryKey: ['pricing', workspace, 'status'], queryFn: ({ signal }) => request<{ state: string; version: string; issues: string[]; limits?: { max_published_rules: number; max_request_body_bytes: number; request_size_basis: 'parsed_json_utf8' } }>('/status', undefined, 'GET', signal) })
  const books = useQuery({ queryKey: ['pricing', workspace, 'books', offset], queryFn: ({ signal }) => request<{ books: PricingBookRow[]; head: PricingHead }>(`/books?limit=50&offset=${offset}`, undefined, 'GET', signal), enabled: status.data?.state === 'applied' })
  const book = useQuery({ queryKey: ['pricing', workspace, 'book', selected], queryFn: ({ signal }) => request<PriceBookDetail>(`/books/${encodeURIComponent(selected)}`, undefined, 'GET', signal), enabled: Boolean(selected) && status.data?.state === 'applied' })
  const refresh = useCallback(() => { void queryClient.invalidateQueries({ queryKey: ['pricing', workspace] }) }, [queryClient, workspace])
  const choose = (id: string) => { setParams((old) => { const next = new URLSearchParams(old); next.set('book', id); next.delete('version'); return next }) }
  const canEdit = canManage && (book.data?.book.workspace_id !== null || isDefault)
  const error = status.error ?? books.error ?? book.error
  return <div className="space-y-5">
    <PageHeader title={t('title')} description={t('description')} icon={BookOpen} badge={<Badge variant="zinc">{t('scope.workspace')}</Badge>}><><Link to="/pricing/cost-report" className={buttonVariants({variant:'outline'})}>{t('report.title')}</Link><Link to="/pricing/admission-preview" className={buttonVariants({variant:'outline'})}>{t('admissionPreview.title')}</Link>{canInspect && <Link to="/pricing/media" className={buttonVariants({variant:'outline'})}>{t('mediaOps.title')}</Link>}{canInspect && <Link to="/pricing/group-outcomes" className={buttonVariants({ variant: 'outline' })}>{t('groupDisposition.title')}</Link>}{canInspect && <Link to="/pricing/outcomes" className={buttonVariants({ variant: 'outline' })}>{t('disposition.title')}</Link>}{canInspect && <Link to="/pricing/recovery" className={buttonVariants({ variant: 'outline' })}>{t('recovery.title')}</Link>}</><Button variant="outline" onClick={refresh}><RefreshCw className="h-4 w-4" />{t('refresh')}</Button><Button disabled={!canManage || status.data?.state !== 'applied'} onClick={() => setNewDialog({})}><Plus className="h-4 w-4" />{t('newBook')}</Button></PageHeader>
    {targetContext && <section className="flex flex-wrap items-center justify-between gap-3 border-y border-[var(--border)] py-4"><div className="min-w-0 space-y-1 text-sm"><h2 className="font-semibold">{t('modelStatus.context')}</h2><p className="break-all font-mono text-xs text-[var(--foreground-muted)]">{targetContext.node_id} · {targetContext.model} · {targetContext.operation}</p><p className="text-xs text-[var(--foreground-muted)]">{t('modelStatus.contextHelp')}</p></div><Button variant="outline" disabled={!canManage || status.data?.state !== 'applied'} onClick={() => setNewDialog({})}>{t('modelStatus.newForTarget')}</Button></section>}
    {status.isLoading ? <SkeletonCard /> : status.data?.state !== 'applied' ? <CardStatic className="space-y-3 p-6"><ShieldCheck className="h-7 w-7 text-[var(--accent)]" /><h2 className="text-lg font-semibold">{t('schema.title')}</h2><p className="max-w-3xl text-sm leading-6 text-[var(--foreground-muted)]">{t('schema.help')}</p><code className="block break-all text-xs">{status.data?.version ?? '—'}</code>{status.isError && <p role="alert" className="text-sm text-[var(--destructive)]">{t(pricingErrorKey(status.error))}</p>}</CardStatic> : <>
      <PriceGovernancePanel workspace={workspace} canManage={canManage} isDefault={isDefault} />
      {status.data.limits ? <section aria-label={t('limits.title')} className="space-y-3 border-y border-[var(--border)] py-4">
        <h2 className="text-sm font-semibold">{t('limits.title')}</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-xs text-[var(--foreground-muted)]">{t('limits.rules')}</dt><dd className="mt-1 font-mono">{status.data.limits.max_published_rules.toLocaleString(i18n.resolvedLanguage)}</dd></div><div><dt className="text-xs text-[var(--foreground-muted)]">{t('limits.requestBytes')}</dt><dd className="mt-1 font-mono">{t('limits.bytes', { value: status.data.limits.max_request_body_bytes.toLocaleString(i18n.resolvedLanguage) })}</dd></div></dl>
        <p className="max-w-4xl text-xs leading-5 text-[var(--foreground-muted)]">{t('limits.help')}</p>
      </section> : null}
      {!canManage && <p className="text-sm text-[var(--foreground-muted)]">{t('viewer')}</p>}
      {error && <p role="alert" className="rounded-lg border border-amber-500/30 p-4 text-sm">{t(pricingErrorKey(error))}</p>}
      <div className="grid items-start gap-5 xl:grid-cols-[270px_minmax(0,1fr)]">
        <CardStatic className="overflow-hidden"><div className="border-b border-[var(--border)] px-4 py-4"><h2 className="text-sm font-semibold">{t('books')}</h2><p className="mt-1 text-xs text-[var(--foreground-muted)]">{t('catalogRevision', { revision: books.data?.head.revision ?? '—' })}</p></div>
          {books.isLoading ? <div className="p-4"><SkeletonCard /></div> : !books.data?.books.length ? <p className="px-4 py-8 text-sm leading-6 text-[var(--foreground-muted)]">{t('empty')}</p> : <ul>{books.data.books.map((item) => <li key={item.id}><button type="button" aria-current={item.id === selected ? 'true' : undefined} onClick={() => choose(item.id)} className={`w-full border-b border-[var(--border)] px-4 py-4 text-left transition-colors ${item.id === selected ? 'bg-[var(--accent-muted)] shadow-[inset_3px_0_var(--accent)]' : 'hover:bg-[var(--background-tertiary)]'}`}><span className="block break-words text-sm font-semibold">{item.name}</span><span className="mt-1 block text-xs text-[var(--foreground-muted)]">{t(item.workspace_id ? 'scope.workspace' : 'scope.global')}</span></button></li>)}</ul>}
          <div className="flex justify-between p-3"><Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset((old) => Math.max(0, old - 50))}>{t('previous')}</Button><Button variant="ghost" size="sm" disabled={(books.data?.books.length ?? 0) < 50} onClick={() => setOffset((old) => old + 50)}>{t('next')}</Button></div>
        </CardStatic>
        <CardStatic className="min-w-0 p-5 sm:p-6">{book.isLoading ? <SkeletonCard /> : book.data ? <BookDocuments key={`${book.data.book.id}:${params.get('version')??''}:${params.get('node')??''}:${params.get('model')??''}:${params.get('operation')??''}`} initialVersion={params.get('version')??undefined} workspace={workspace} detail={book.data} canEdit={canEdit} initialNode={params.get('node') ?? undefined} initialModel={params.get('model') ?? undefined} initialOperation={targetContext?.operation} onRefresh={refresh} guard={guard} onCopy={canManage ? (copy) => setNewDialog({ ...copy, name: t('copyName', { name: book.data.book.name }) }) : undefined} /> : <EmptyState icon={BookOpen} title={t('selectBook')} description={t('selectHelp')} />}</CardStatic>
      </div>
    </>}
    {newDialog && <NewBookDialog workspace={workspace} initial={newDialog} target={targetContext} allowGlobal={isDefault} onClose={() => setNewDialog(null)} onCreated={(id) => { setNewDialog(null); refresh(); choose(id) }} />}
  </div>
}
function BookDocuments({ workspace, detail, canEdit, onRefresh, guard, onCopy, initialNode, initialModel, initialOperation, initialVersion }: { workspace: string; detail: PriceBookDetail; canEdit: boolean; onRefresh: () => void; guard: () => boolean; onCopy?: (copy:PriceCopy) => void; initialNode?: string; initialModel?: string; initialOperation?: string; initialVersion?: string }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const [choice, setChoice] = useState(() => initialVersion ? `version:${initialVersion}` : detail.drafts[0] ? `draft:${detail.drafts[0].id}` : detail.versions[0] ? `version:${detail.versions[0].version_id}` : '')
  const document = useQuery({ queryKey: ['pricing', workspace, 'document', detail.book.id, choice], queryFn: ({ signal }) => request<PricingDraft & { version_id?: string }>(choice.startsWith('draft:') ? `/drafts/${encodeURIComponent(choice.slice(6))}` : `/books/${encodeURIComponent(detail.book.id)}/versions/${encodeURIComponent(choice.slice(8))}`, undefined, 'GET', signal), enabled: Boolean(choice), staleTime: 0 })
  const choices = [...detail.drafts.map((draft) => ({ value: `draft:${draft.id}`, label: `${t('draft')} · ${draft.id.slice(0, 8)} · ${draft.revision}` })), ...detail.versions.map((version) => ({ value: `version:${version.version_id}`, label: `${t('published')} · ${version.version_id.slice(0, 8)}` }))]
  if (choice && !choices.some((item) => item.value === choice)) choices.push({ value: choice, label: choice.slice(choice.indexOf(':') + 1, choice.indexOf(':') + 9) })
  const choose = (value: string, completed = false) => { if (completed || guard()) setChoice(value) }
  return <div className="space-y-5"><PriceBookManagementPanel workspace={workspace} bookId={detail.book.id} canEdit={canEdit} /><div className="flex flex-wrap items-end gap-3"><div className="min-w-48 flex-1"><PriceSelect label={t('document')} value={choice} options={choices} onChange={choose} /></div></div>
    {document.isLoading ? <SkeletonCard /> : document.isError ? <p role="alert" className="text-sm text-[var(--destructive)]">{t(pricingErrorKey(document.error))}</p> : document.data ? <PriceBookEditor key={choice} workspace={workspace} detail={detail} initial={choice.startsWith('draft:') ? document.data : { content: document.data.content, version_id: choice.slice(8), inheritance:document.data.inheritance }} choice={choice} canEdit={canEdit} onChoice={choose} onRefresh={onRefresh} initialNode={initialNode} initialModel={initialModel} initialOperation={initialOperation} onCopy={onCopy} /> : null}
  </div>
}
function NewBookDialog({ workspace, initial, target, allowGlobal, onClose, onCreated }: { workspace: string; initial: { content?: PriceBookContent; name?: string; inheritance?: PricingInheritanceView }; target?: ModelPricingTarget; allowGlobal: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const { t } = useTranslation('pricing'), request = useMemo(() => pricingClient(workspace), [workspace])
  const initialName = initial.name ?? target?.model ?? '', initialFamily = priceFamilyForOperation(target?.operation)
  const [name, setName] = useState(initialName), [family, setFamily] = useState(initialFamily), [scope, setScope] = useState('workspace'), [currency, setCurrency] = useState(initial.content?.currency ?? 'USD')
  const [imported, setImported] = useState<PriceValidation | null>(initial.content ? { valid: true, content: initial.content, warnings: [], content_hash: '', inheritance:initial.inheritance } : null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = name !== initialName || family !== initialFamily || scope !== 'workspace' || currency !== (initial.content?.currency ?? 'USD') || JSON.stringify({content:imported?.content,inheritance:imported?.inheritance}) !== JSON.stringify({content:initial.content,inheritance:initial.inheritance})
  const releaseGuard = usePricingNavigationState(dirty, busy)
  const close = () => { if (!busy && (!dirty || window.confirm(t('discardConfirm')))) onClose() }
  const file = async (input: File | undefined) => { if (!input) return; if (input.size > 1048576) { setError(t('importTooLarge')); return } setBusy(true); setError(''); try { const body: unknown = JSON.parse(await input.text()); const value=await request<PriceValidation>('/import/validate', body);if(value.inheritance)await verifyInheritancePreview(value as PriceValidation&InheritancePreview,value.inheritance.definition);setImported(value) } catch (failure) { setError(t(failure instanceof SyntaxError ? 'error.validation' : pricingErrorKey(failure))) } finally { setBusy(false) } }
  return <Dialog open onOpenChange={(open) => { if (!open) close() }}><DialogContent className="max-w-xl" ariaLabel={t('newBook')}><DialogHeader><DialogTitle>{t('newBook')}</DialogTitle></DialogHeader><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { if(imported?.inheritance)await verifyInheritancePreview(await request<InheritancePreview>('/inheritance/preview',{scope,definition:imported.inheritance.definition}),imported.inheritance.definition,imported.content); const result = await request<{ book: PricingBookRow }>(imported?.inheritance?'/inherited-books':'/books', imported?.inheritance?{name:name.trim(),scope,definition:imported.inheritance.definition}:{ name: name.trim(), scope, content: imported?.content ?? newPriceBook(family, currency) }); releaseGuard(); onCreated(result.book.id) } catch (failure) { setError(t(pricingErrorKey(failure))) } finally { setBusy(false) } }} className="space-y-4"><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t('newHelp')}</p>{target && <p className="break-all font-mono text-xs text-[var(--foreground-muted)]">{target.node_id} · {target.model} · {target.operation}</p>}<PriceInput label={t('name')} value={name} required maxLength={128} disabled={busy} onChange={(e) => setName(e.target.value)} /><div className="grid gap-3 sm:grid-cols-2"><PriceSelect label={t('family')} value={family} disabled={busy || Boolean(imported)} options={['token', 'image', 'audio', 'video', 'rerank'].map((value) => ({ value, label: t(`family.${value}`) }))} onChange={setFamily} /><PriceInput label={t('currency')} value={currency} maxLength={3} disabled={busy || Boolean(imported)} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></div><PriceSelect label={t('scope')} value={scope} disabled={busy} options={[{ value: 'workspace', label: t('scope.workspace') }, ...(allowGlobal ? [{ value: 'global', label: t('scope.global') }] : [])]} onChange={setScope} />
      <PriceParentPicker key={scope} workspace={workspace} scope={scope as 'workspace'|'global'} disabled={busy} onBusy={setBusy} onStage={preview=>setImported({...preview,valid:true})}/>
      {imported?.inheritance&&<PriceInheritanceFacts view={imported.inheritance}/>}
      <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-[var(--border-hover)] p-4 text-sm"><Upload className="h-4 w-4" />{t('import')}<input type="file" accept="application/json,.json" className="sr-only" onChange={(event) => void file(event.target.files?.[0])} disabled={busy} /></label>
      {imported && <div className="space-y-2"><p className="text-xs text-[var(--accent)]">{t('importValidated')}</p><PricingDiagnostics diagnostics={imported.warnings} /><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {if(!imported?.inheritance||window.confirm(t('inheritance.clearImport')))setImported(null)}}>{t('remove')}</Button></div>}
      {error && <p role="alert" className="text-sm text-[var(--destructive)]">{error}</p>}<DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={close}>{t('cancel')}</Button><Button type="submit" disabled={busy}>{t(busy ? 'working' : 'createDraft')}</Button></DialogFooter></form></DialogContent></Dialog>
}
