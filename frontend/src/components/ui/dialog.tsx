import { useEffect, useRef, useCallback, type ReactNode, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { cn } from '@/lib/utils'

// ── Focus trap utilities ──

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

// ── Dialog Root ──

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  // Cleanup also runs when a conditionally rendered dialog is unmounted.
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [open])

  return createPortal(
    <AnimatePresence>
      {open && (
        <DialogContext.Provider value={{ onOpenChange }}>
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute inset-0 bg-black/60 backdrop-blur-md"
              onClick={() => onOpenChange(false)}
            />
            {children}
          </div>
        </DialogContext.Provider>
      )}
    </AnimatePresence>,
    document.body,
  )
}

// ── Context for children to close dialog ──

import { createContext, useContext } from 'react'

const DialogContext = createContext<{ onOpenChange: (open: boolean) => void }>({
  onOpenChange: () => {},
})

function useDialogContext() {
  return useContext(DialogContext)
}

// ── Dialog Content ──

interface DialogContentProps {
  children: ReactNode
  className?: string
  ariaLabel?: string
}

export function DialogContent({ children, className, ariaLabel }: DialogContentProps) {
  const contentRef = useRef<HTMLDivElement>(null)
  const { onOpenChange } = useDialogContext()

  // Focus trap
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onOpenChange(false)
        return
      }
      if (e.key !== 'Tab' || !contentRef.current) return

      const focusable = getFocusableElements(contentRef.current)
      if (focusable.length === 0) {
        e.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    },
    [onOpenChange],
  )

  // Auto-focus first focusable element
  useEffect(() => {
    if (!contentRef.current) return
    const timer = setTimeout(() => {
      const focusable = getFocusableElements(contentRef.current!)
      if (focusable.length > 0) {
        focusable[0].focus()
      }
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  return (
    <motion.div
      ref={contentRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      initial={{ opacity: 0, scale: 0.95, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: 8 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative z-10 w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--glass-border)] bg-[var(--background)] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.4)]',
        className,
      )}
    >
      {children}
    </motion.div>
  )
}

// ── Compound children ──

interface DialogHeaderProps {
  children: ReactNode
  className?: string
}

export function DialogHeader({ children, className }: DialogHeaderProps) {
  return (
    <div className={cn('mb-5 flex items-center justify-between', className)}>
      {children}
    </div>
  )
}

interface DialogTitleProps {
  children: ReactNode
  className?: string
}

export function DialogTitle({ children, className }: DialogTitleProps) {
  return (
    <h2 className={cn('text-lg font-bold tracking-tight text-[var(--foreground)]', className)}>
      {children}
    </h2>
  )
}

interface DialogFooterProps {
  children: ReactNode
  className?: string
}

export function DialogFooter({ children, className }: DialogFooterProps) {
  return (
    <div className={cn('mt-6 flex justify-end gap-3', className)}>
      {children}
    </div>
  )
}
