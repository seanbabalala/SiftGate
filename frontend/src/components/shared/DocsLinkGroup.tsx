import { BookOpen, ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { CardStatic, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

const REPO_DOCS_BASE_URL = 'https://github.com/seanbabalala/SiftGate/blob/main'

export interface DocsLink {
  label: string
  href: string
}

export function repoDocsUrl(path: string) {
  return `${REPO_DOCS_BASE_URL}/${path.replace(/^\/+/, '')}`
}

export function DocsLinkGroup({
  links,
  className,
}: {
  links: DocsLink[]
  className?: string
}) {
  const { t } = useTranslation('common')

  return (
    <CardStatic className={className}>
      <CardContent className="flex flex-col gap-3 py-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--background-tertiary)] text-[var(--accent)]">
            <BookOpen className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-extrabold text-[var(--foreground)]">
              {t('docs.title')}
            </div>
            <p className="mt-1 max-w-3xl text-[12px] font-medium leading-5 text-[var(--foreground-dim)]">
              {t('docs.description')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg bg-[var(--background-secondary)] px-3 py-2 text-[11px] font-bold text-[var(--foreground-muted)] transition-all',
                'hover:-translate-y-0.5 hover:text-[var(--foreground)] hover:shadow-[0_12px_28px_rgba(5,46,36,0.08)]',
              )}
            >
              <span>{link.label}</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ))}
        </div>
      </CardContent>
    </CardStatic>
  )
}
