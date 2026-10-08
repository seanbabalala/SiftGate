import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { useBlocker } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface EditingState { dirty: boolean; busy: boolean }
interface GuardContext {
  register: (id: string, state: EditingState) => () => void
  release: (id: string) => void
  confirmLeave: () => boolean
}
const Context = createContext<GuardContext | null>(null)

/** One router blocker covers every pricing form, including nested dialogs and browser history. */
export function PricingNavigationGuard({ children }: { children: ReactNode }) {
  const { t } = useTranslation('pricing')
  const entries = useRef(new Map<string, EditingState>())
  const [, changed] = useReducer((value: number) => value + 1, 0)
  const state = useCallback(() => ({
    dirty: [...entries.current.values()].some((entry) => entry.dirty),
    busy: [...entries.current.values()].some((entry) => entry.busy),
  }), [])
  const release = useCallback((id: string) => { if (entries.current.delete(id)) changed() }, [])
  const register = useCallback((id: string, entry: EditingState) => {
    entries.current.set(id, entry); changed()
    return () => release(id)
  }, [release])
  const confirmLeave = useCallback(() => {
    const current = state()
    return !current.busy && (!current.dirty || window.confirm(t('discardConfirm')))
  }, [state, t])
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    const current = state()
    return (current.busy || current.dirty) && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search || currentLocation.hash !== nextLocation.hash)
  })
  useLayoutEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      const current = state()
      if (current.dirty || current.busy) { event.preventDefault(); event.returnValue = '' }
    }
    const switchWorkspace = (event: Event) => { if (!confirmLeave()) event.preventDefault() }
    window.addEventListener('beforeunload', unload)
    window.addEventListener('siftgate:before-workspace-change', switchWorkspace)
    return () => {
      window.removeEventListener('beforeunload', unload)
      window.removeEventListener('siftgate:before-workspace-change', switchWorkspace)
    }
  }, [state, confirmLeave])
  const value = useMemo(() => ({ register, release, confirmLeave }), [register, release, confirmLeave])
  const busy = state().busy
  return <Context.Provider value={value}>{children}
    {blocker.state === 'blocked' && <Dialog open onOpenChange={(open) => { if (!open) blocker.reset() }}><DialogContent ariaLabel={t('navigation.title')} className="max-w-md"><DialogHeader><DialogTitle>{t('navigation.title')}</DialogTitle></DialogHeader><p className="text-sm leading-6 text-[var(--foreground-muted)]">{t(busy ? 'navigation.busy' : 'discardConfirm')}</p><DialogFooter><Button variant="outline" onClick={() => blocker.reset()}>{t('navigation.stay')}</Button><Button disabled={busy} onClick={() => blocker.proceed()}>{t('navigation.leave')}</Button></DialogFooter></DialogContent></Dialog>}
  </Context.Provider>
}

export function usePricingNavigationState(dirty: boolean, busy: boolean) {
  const context = useContext(Context), id = useId()
  if (!context) throw new Error('Pricing forms require PricingNavigationGuard')
  const { register, release } = context
  useLayoutEffect(() => register(id, { dirty, busy }), [register, id, dirty, busy])
  // A successful write may navigate synchronously, before React runs effect cleanup.
  return useCallback(() => release(id), [release, id])
}

export function usePricingLeaveConfirmation() {
  const context = useContext(Context)
  if (!context) throw new Error('Pricing forms require PricingNavigationGuard')
  return context.confirmLeave
}
