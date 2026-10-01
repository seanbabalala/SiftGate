import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/select'
import type { InputHTMLAttributes } from 'react'

export function PriceField({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId()
  return <div className="min-w-0 space-y-1.5"><label className="block text-xs font-semibold text-[var(--foreground-muted)]" htmlFor={id}>{label}</label>{children(id)}{hint && <p className="text-xs leading-5 text-[var(--foreground-muted)]">{hint}</p>}</div>
}
export function PriceInput({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) { return <PriceField label={label} hint={hint}>{(id) => <Input id={id} {...props} />}</PriceField> }
export function PriceSelect({ label, value, options, onChange, disabled }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) { return <PriceField label={label}>{(id) => <NativeSelect id={id} disabled={disabled} value={value} options={options} onChange={(event) => onChange(event.target.value)} />}</PriceField> }
export function PriceTokens({ label, value, onChange, hint }: { label: string; value: string[]; onChange: (value: string[]) => void; hint?: string }) {
  const [text, setText] = useState(value.join(', '))
  const signature = JSON.stringify(value), committed = useRef(signature)
  useEffect(() => { if (committed.current !== signature) { committed.current = signature; setText(value.join(', ')) } }, [signature, value])
  return <PriceInput label={label} value={text} hint={hint} onChange={(event) => { setText(event.target.value); const next = [...new Set(event.target.value.split(',').map((item) => item.trim()).filter(Boolean))]; committed.current = JSON.stringify(next); onChange(next) }} />
}
