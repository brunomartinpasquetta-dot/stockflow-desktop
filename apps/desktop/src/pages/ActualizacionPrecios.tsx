/**
 * Actualización masiva de precios — pantalla única con filtros + selección
 * múltiple + regla multi-campo + vista previa (P-FIX-FASE3).
 *
 * Reemplaza el wizard anterior. Mantiene el backend (priceUpdate.service +
 * priceUpdate.repository) intacto; sólo cambia la UX a "una sola pantalla".
 *
 * Requiere permiso `manage_prices` (admin / manager) y `useCanWrite()`.
 */
import * as React from 'react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Search, Tag } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { FormShell } from '@/components/ui/form-shell'
import { api } from '@/lib/api'
import { useArticles, useFamilies, useSuppliers } from '@/lib/hooks'
import { formatCurrency } from '@/lib/format'
import { CurrencyInput } from '@/components/ui/currency-input'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePermission } from '@/contexts/AuthContext'
import type {
  ArticleDTO,
  PriceFieldDTO,
  PriceUpdateFilterDTO,
  PriceUpdatePreviewEntryDTO,
  PriceUpdateRoundingDTO,
  PriceUpdateRuleDTO,
} from '@/types/api'

const FIELD_LABELS: Record<PriceFieldDTO, string> = {
  costPrice: 'Costo',
  listPrice1: 'Venta (L1)',
  listPrice2: 'L2',
  listPrice3: 'L3',
  wholesalePrice: 'Mayor',
}

const ROUNDING_OPTIONS: Array<{ value: PriceUpdateRoundingDTO; label: string }> = [
  { value: 'none', label: 'Sin redondeo' },
  { value: 'up_to_10', label: 'Múltiplo de $10' },
  { value: 'up_to_50', label: 'Múltiplo de $50' },
  { value: 'up_to_100', label: 'Múltiplo de $100' },
  { value: 'nearest_99', label: 'Terminado en 99' },
]

type RuleMode = 'percentage' | 'fixed_amount' | 'set_value'

/** Wrapper minimalista alrededor de <input type="checkbox"> con API compatible. */
function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean | 'indeterminate'
  onCheckedChange: (checked: boolean) => void
}): React.ReactElement {
  const ref = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === 'indeterminate'
  }, [checked])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 rounded border-input"
      checked={checked === true}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  )
}

export function ActualizacionPrecios() {
  const canWrite = useCanWrite()
  const canManage = usePermission('manage_prices')
  const canApply = canWrite && canManage

  // Filtros
  const [search, setSearch] = useState('')
  const [familyIds, setFamilyIds] = useState<Set<string>>(new Set())
  const [supplierIds, setSupplierIds] = useState<Set<string>>(new Set())
  const [onlyStock, setOnlyStock] = useState(false)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')

  // Selección
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Regla
  const [fields, setFields] = useState<PriceFieldDTO[]>(['listPrice1'])
  const [mode, setMode] = useState<RuleMode>('percentage')
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase')
  const [value, setValue] = useState('10')
  const [rounding, setRounding] = useState<PriceUpdateRoundingDTO>('none')

  // Preview / aplicar
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewEntries, setPreviewEntries] = useState<PriceUpdatePreviewEntryDTO[]>([])
  const [applying, setApplying] = useState(false)

  const familiesQ = useFamilies()
  const suppliersQ = useSuppliers()
  const articlesQ = useArticles()

  const familyNameById = useMemo(
    () => new Map((familiesQ.data ?? []).map((f) => [f.id, f.name])),
    [familiesQ.data],
  )
  const filtered = useMemo<ArticleDTO[]>(() => {
    const all = articlesQ.data ?? []
    const term = search.trim().toLowerCase()
    const min = minPrice ? Number(minPrice) : null
    const max = maxPrice ? Number(maxPrice) : null
    return all.filter((a) => {
      if (!a.active) return false
      if (familyIds.size > 0 && (!a.familyId || !familyIds.has(a.familyId))) return false
      if (supplierIds.size > 0 && (!a.supplierId || !supplierIds.has(a.supplierId))) return false
      if (onlyStock && Number(a.stock) <= 0) return false
      if (min != null && Number(a.listPrice1) < min) return false
      if (max != null && Number(a.listPrice1) > max) return false
      if (term) {
        const hay = `${a.barcode} ${a.description} ${a.brand ?? ''}`.toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [articlesQ.data, search, familyIds, supplierIds, onlyStock, minPrice, maxPrice])

  const allSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id))
  const someSelected = filtered.some((a) => selected.has(a.id)) && !allSelected

  function toggleSelectAll(checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) {
        for (const a of filtered) next.add(a.id)
      } else {
        for (const a of filtered) next.delete(a.id)
      }
      return next
    })
  }

  function toggleOne(id: string, checked: boolean): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleField(field: PriceFieldDTO): void {
    setFields((prev) =>
      prev.includes(field) ? prev.filter((f) => f !== field) : [...prev, field],
    )
  }

  function toggleFamily(id: string): void {
    setFamilyIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSupplier(id: string): void {
    setSupplierIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function clearFilters(): void {
    setSearch('')
    setFamilyIds(new Set())
    setSupplierIds(new Set())
    setOnlyStock(false)
    setMinPrice('')
    setMaxPrice('')
  }

  function buildPayload(): { filter: PriceUpdateFilterDTO; rule: PriceUpdateRuleDTO; description: string } | null {
    if (selected.size === 0) {
      toast.error('Seleccioná al menos un artículo')
      return null
    }
    if (fields.length === 0) {
      toast.error('Elegí al menos un campo')
      return null
    }
    const n = Number(value)
    if (!Number.isFinite(n) || n === 0) {
      toast.error('El valor debe ser distinto de cero')
      return null
    }

    const filter: PriceUpdateFilterDTO = {
      scope: 'manual',
      articleIds: Array.from(selected),
      onlyActive: true,
    }
    const rule: PriceUpdateRuleDTO = {
      type: mode,
      value,
      fields,
      rounding,
      ...(mode !== 'set_value' ? { direction } : {}),
    }
    const fieldLabels = fields.map((f) => FIELD_LABELS[f]).join(', ')
    let modeLabel: string
    if (mode === 'percentage') modeLabel = `${direction === 'increase' ? '+' : '-'}${value}%`
    else if (mode === 'fixed_amount') modeLabel = `${direction === 'increase' ? '+' : '-'}$${value}`
    else modeLabel = `=$${value}`
    const description = `${modeLabel} en ${fieldLabels} (${selected.size} artículos)`
    return { filter, rule, description }
  }

  async function abrirPreview(): Promise<void> {
    const payload = buildPayload()
    if (!payload) return
    setPreviewLoading(true)
    setPreviewOpen(true)
    try {
      const res = await api.priceUpdate.preview(payload.filter, payload.rule)
      setPreviewEntries(res.entries)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error generando vista previa')
      setPreviewOpen(false)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function aplicar(): Promise<void> {
    const payload = buildPayload()
    if (!payload) return
    setApplying(true)
    try {
      const res = await api.priceUpdate.apply(payload.filter, payload.rule, payload.description)
      toast.success(`Aplicado: ${res.articlesAffected} artículos modificados (${res.entries} cambios)`)
      setPreviewOpen(false)
      setPreviewEntries([])
      setSelected(new Set())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al aplicar la actualización')
    } finally {
      setApplying(false)
    }
  }

  return (
    <FormShell
      title={
        <div className="flex items-center gap-2">
          <Tag className="h-5 w-5" />
          <span>Actualización de Precios</span>
        </div>
      }
      headerActions={
        <div className="flex flex-1 items-center gap-2">
          <div className="relative max-w-md flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por código, descripción o marca…"
              className="pl-8"
            />
          </div>
          <details className="relative">
            <summary className="list-none cursor-pointer rounded-md border bg-background px-3 py-2 text-sm select-none">
              Filtros{(familyIds.size + supplierIds.size + (onlyStock ? 1 : 0) + (minPrice ? 1 : 0) + (maxPrice ? 1 : 0)) > 0
                ? ` (${familyIds.size + supplierIds.size + (onlyStock ? 1 : 0) + (minPrice ? 1 : 0) + (maxPrice ? 1 : 0)})`
                : ''}
            </summary>
            <div className="absolute right-0 top-full z-30 mt-1 w-[420px] rounded-md border bg-background p-3 shadow-lg">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Familias</Label>
                  <div className="max-h-32 overflow-auto rounded border p-1 text-xs">
                    {(familiesQ.data ?? []).map((f) => (
                      <label key={f.id} className="flex items-center gap-1 py-0.5">
                        <Checkbox checked={familyIds.has(f.id)} onCheckedChange={() => toggleFamily(f.id)} />
                        <span>{f.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <Label className="text-xs">Proveedores</Label>
                  <div className="max-h-32 overflow-auto rounded border p-1 text-xs">
                    {(suppliersQ.data ?? []).map((s) => (
                      <label key={s.id} className="flex items-center gap-1 py-0.5">
                        <Checkbox checked={supplierIds.has(s.id)} onCheckedChange={() => toggleSupplier(s.id)} />
                        <span>{s.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={onlyStock} onCheckedChange={(c) => setOnlyStock(!!c)} />
                  Sólo con stock
                </label>
                <div />
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Precio min</Label>
                  <CurrencyInput value={minPrice} onChange={setMinPrice} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs">Precio max</Label>
                  <CurrencyInput value={maxPrice} onChange={setMaxPrice} />
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <Button variant="ghost" size="sm" onClick={clearFilters}>Limpiar filtros</Button>
              </div>
            </div>
          </details>
        </div>
      }
      bodyClassName="py-0"
      footer={
        selected.size > 0 && (
          <RuleFooter
            selectedCount={selected.size}
            fields={fields}
            toggleField={toggleField}
            mode={mode}
            setMode={setMode}
            direction={direction}
            setDirection={setDirection}
            value={value}
            setValue={setValue}
            rounding={rounding}
            setRounding={setRounding}
            canApply={canApply}
            onPreview={() => void abrirPreview()}
            onApply={() => void aplicar()}
            applying={applying}
          />
        )
      }
    >
      <Card className="flex h-full flex-col">
        <div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox
              checked={allSelected ? true : someSelected ? 'indeterminate' : false}
              onCheckedChange={(c) => toggleSelectAll(!!c)}
            />
            <span>Seleccionar todos los filtrados</span>
          </label>
          <span className="text-xs text-muted-foreground">
            {filtered.length} artículo(s) filtrado(s) — {selected.size} seleccionado(s)
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 bg-background">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Código</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead>Marca</TableHead>
                <TableHead>Familia</TableHead>
                <TableHead className="text-right">Costo</TableHead>
                <TableHead className="text-right">Venta (L1)</TableHead>
                <TableHead className="text-right">L2</TableHead>
                <TableHead className="text-right">L3</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {articlesQ.isLoading ? (
                <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">Cargando…</TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="py-6 text-center text-muted-foreground">No hay artículos que coincidan con los filtros.</TableCell></TableRow>
              ) : filtered.map((a) => (
                <TableRow key={a.id} className={selected.has(a.id) ? 'bg-primary/5' : undefined}>
                  <TableCell>
                    <Checkbox checked={selected.has(a.id)} onCheckedChange={(c) => toggleOne(a.id, !!c)} />
                  </TableCell>
                  <TableCell className="text-xs">{a.barcode}</TableCell>
                  <TableCell className="text-xs">{a.description}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.brand ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{a.familyId ? familyNameById.get(a.familyId) ?? '—' : '—'}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatCurrency(a.costPrice)}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatCurrency(a.listPrice1)}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatCurrency(a.listPrice2)}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{formatCurrency(a.listPrice3)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <PreviewDialog
        open={previewOpen}
        loading={previewLoading}
        entries={previewEntries}
        applying={applying}
        canApply={canApply}
        onClose={() => setPreviewOpen(false)}
        onApply={() => void aplicar()}
      />
    </FormShell>
  )
}

/* ------------------------------------------------------------------ */

function RuleFooter(props: {
  selectedCount: number
  fields: PriceFieldDTO[]
  toggleField: (f: PriceFieldDTO) => void
  mode: RuleMode
  setMode: (m: RuleMode) => void
  direction: 'increase' | 'decrease'
  setDirection: (d: 'increase' | 'decrease') => void
  value: string
  setValue: (v: string) => void
  rounding: PriceUpdateRoundingDTO
  setRounding: (r: PriceUpdateRoundingDTO) => void
  canApply: boolean
  onPreview: () => void
  onApply: () => void
  applying: boolean
}): React.ReactElement {
  const allFields: PriceFieldDTO[] = ['costPrice', 'listPrice1', 'listPrice2', 'listPrice3', 'wholesalePrice']
  const showDirection = props.mode !== 'set_value'
  const isCurrency = props.mode === 'fixed_amount' || props.mode === 'set_value'

  return (
    <div className="flex w-full flex-col gap-2 px-1 py-1">
      <div className="text-xs font-medium text-muted-foreground">
        Aplicar a {props.selectedCount} artículos seleccionados:
      </div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-2 text-sm">
        <span className="font-medium">Campo:</span>
        <div className="flex flex-wrap gap-3">
          {allFields.map((f) => (
            <label key={f} className="flex items-center gap-1">
              <Checkbox checked={props.fields.includes(f)} onCheckedChange={() => props.toggleField(f)} />
              <span>{FIELD_LABELS[f]}</span>
            </label>
          ))}
        </div>
        <span className="font-medium">Modo:</span>
        <div className="flex flex-wrap gap-3">
          {(['percentage', 'fixed_amount', 'set_value'] as RuleMode[]).map((m) => (
            <label key={m} className="flex items-center gap-1">
              <input
                type="radio"
                name="rule-mode"
                checked={props.mode === m}
                onChange={() => props.setMode(m)}
              />
              <span>
                {m === 'percentage' ? 'Porcentaje' : m === 'fixed_amount' ? 'Monto fijo' : 'Valor absoluto'}
              </span>
            </label>
          ))}
        </div>
        {showDirection && (
          <>
            <span className="font-medium">Dirección:</span>
            <div className="flex gap-3">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="rule-direction"
                  checked={props.direction === 'increase'}
                  onChange={() => props.setDirection('increase')}
                />
                <span>⬆ Subir</span>
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="rule-direction"
                  checked={props.direction === 'decrease'}
                  onChange={() => props.setDirection('decrease')}
                />
                <span>⬇ Bajar</span>
              </label>
            </div>
          </>
        )}
        <span className="font-medium">Valor:</span>
        <div className="flex items-center gap-2">
          {isCurrency ? (
            <CurrencyInput value={props.value} onChange={props.setValue} className="w-40" />
          ) : (
            <Input
              type="number"
              value={props.value}
              onChange={(e) => props.setValue(e.target.value)}
              className="w-40"
            />
          )}
          {props.mode === 'percentage' && <span className="text-sm text-muted-foreground">%</span>}
        </div>
        <span className="font-medium">Redondeo:</span>
        <Select value={props.rounding} onChange={(e) => props.setRounding(e.target.value as PriceUpdateRoundingDTO)}>
          {ROUNDING_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={props.onPreview} disabled={props.applying}>
          Vista previa
        </Button>
        <Button onClick={props.onApply} disabled={!props.canApply || props.applying}>
          {props.applying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aplicar cambios'}
        </Button>
      </div>
    </div>
  )
}

function PreviewDialog(props: {
  open: boolean
  loading: boolean
  entries: PriceUpdatePreviewEntryDTO[]
  applying: boolean
  canApply: boolean
  onClose: () => void
  onApply: () => void
}): React.ReactElement | null {
  if (!props.open) return null
  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Vista previa de cambios ({props.entries.length})</DialogTitle>
        </DialogHeader>
        {props.loading ? (
          <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></div>
        ) : (
          <div className="max-h-96 overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Campo</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Nuevo</TableHead>
                  <TableHead className="text-right">Diferencia</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.entries.map((e, i) => {
                  const oldN = Number(e.oldValue)
                  const newN = Number(e.newValue)
                  const diff = newN - oldN
                  return (
                    <TableRow key={`${e.articleId}-${e.field}-${i}`}>
                      <TableCell className="text-xs">{e.code}</TableCell>
                      <TableCell className="text-xs">{e.description}</TableCell>
                      <TableCell className="text-xs">{FIELD_LABELS[e.field]}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(e.oldValue)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-medium">{formatCurrency(e.newValue)}</TableCell>
                      <TableCell className={`text-right tabular-nums text-xs ${diff >= 0 ? 'text-success' : 'text-destructive'}`}>
                        {diff >= 0 ? '+' : ''}{formatCurrency(diff)}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={props.applying}>Volver</Button>
          <Button onClick={props.onApply} disabled={!props.canApply || props.applying || props.entries.length === 0}>
            {props.applying ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Aplicar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
