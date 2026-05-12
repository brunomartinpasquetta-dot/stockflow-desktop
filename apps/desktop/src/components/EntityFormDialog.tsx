import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { ZodTypeAny } from 'zod'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { ApiError } from '@/lib/api'
import { parseCurrencyInput } from '@/lib/format'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'

export interface FieldConfig {
  name: string
  label: string
  type: 'text' | 'number' | 'currency' | 'select' | 'textarea' | 'checkbox' | 'password'
  options?: { value: string; label: string }[]
  placeholder?: string
  helpText?: string
  /** Ocupa las 2 columnas del formulario. */
  full?: boolean
  /** Sólo aplica a 'select': permite opción vacía. */
  allowEmpty?: boolean
}

interface EntityFormDialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  fields: FieldConfig[]
  schema: ZodTypeAny
  defaultValues: Record<string, unknown>
  onSubmit: (values: Record<string, unknown>) => Promise<void>
  submitLabel?: string
}

type FormValues = Record<string, unknown>

export function EntityFormDialog({
  open,
  onClose,
  title,
  description,
  fields,
  schema,
  defaultValues,
  onSubmit,
  submitLabel = 'Guardar',
}: EntityFormDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues })

  useEffect(() => {
    if (open) reset(defaultValues)
    // sólo al abrir / cambiar de fila
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const currencyFields = new Set(fields.filter((f) => f.type === 'currency').map((f) => f.name))

  function handleCurrencyBlur(name: string): void {
    const raw = getValues(name)
    setValue(name, parseCurrencyInput(typeof raw === 'string' ? raw : String(raw ?? '')))
  }

  const submit = handleSubmit(async (values) => {
    setSubmitting(true)
    const out: FormValues = { ...values }
    for (const name of currencyFields) {
      out[name] = parseCurrencyInput(typeof values[name] === 'string' ? (values[name] as string) : String(values[name] ?? ''))
    }
    try {
      await onSubmit(out)
      onClose()
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message)
      else toast.error('Ocurrió un error al guardar')
    } finally {
      setSubmitting(false)
    }
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          {fields.map((f) => {
            const error = errors[f.name]
            const errMsg = typeof error?.message === 'string' ? error.message : undefined
            return (
              <div key={f.name} className={cn('flex flex-col gap-1', f.full && 'col-span-2', f.type === 'checkbox' && 'col-span-2 flex-row items-center gap-2 pt-1')}>
                {f.type === 'checkbox' ? (
                  <>
                    <input
                      id={`fld-${f.name}`}
                      type="checkbox"
                      className="h-4 w-4 rounded border-input"
                      {...register(f.name)}
                    />
                    <Label htmlFor={`fld-${f.name}`}>{f.label}</Label>
                  </>
                ) : (
                  <>
                    <Label htmlFor={`fld-${f.name}`}>{f.label}</Label>
                    {f.type === 'select' ? (
                      <Select id={`fld-${f.name}`} {...register(f.name)}>
                        {f.allowEmpty && <option value="">— (ninguno) —</option>}
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </Select>
                    ) : f.type === 'textarea' ? (
                      <textarea
                        id={`fld-${f.name}`}
                        rows={3}
                        placeholder={f.placeholder}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        {...register(f.name)}
                      />
                    ) : (
                      (() => {
                        const reg = register(f.name)
                        return (
                          <Input
                            id={`fld-${f.name}`}
                            type={f.type === 'password' ? 'password' : 'text'}
                            inputMode={f.type === 'currency' || f.type === 'number' ? 'decimal' : undefined}
                            placeholder={f.placeholder}
                            {...reg}
                            onBlur={(e) => {
                              void reg.onBlur(e)
                              if (currencyFields.has(f.name)) handleCurrencyBlur(f.name)
                            }}
                          />
                        )
                      })()
                    )}
                    {f.helpText && !errMsg && <span className="text-xs text-muted-foreground">{f.helpText}</span>}
                  </>
                )}
                {errMsg && <span className="text-xs text-destructive">{errMsg}</span>}
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" type="button" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={submitting}>
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
