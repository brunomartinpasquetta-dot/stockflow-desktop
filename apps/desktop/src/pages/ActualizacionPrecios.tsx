/**
 * Actualización masiva de precios — wizard de 3 pasos.
 *
 *   Paso 1: filtros (alcance + filtros adicionales)
 *   Paso 2: regla (tipo + campos + redondeo + descripción)
 *   Paso 3: vista previa + confirmar
 *
 * Requiere permiso `manage_prices` (admin / manager) y `useCanWrite()`.
 */
import { useMemo, useState } from 'react'
import { useWindowNav } from '@/lib/useWindowNav'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { useArticles, useFamilies, useSuppliers } from '@/lib/hooks'
import { formatCurrency } from '@/lib/format'
import { CurrencyInput } from '@/components/ui/currency-input'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePermission } from '@/contexts/AuthContext'
import type {
  PriceFieldDTO,
  PriceUpdateFilterDTO,
  PriceUpdateRoundingDTO,
  PriceUpdateRuleDTO,
  PriceUpdateRuleTypeDTO,
} from '@/types/api'

type Step = 'filter' | 'rule' | 'preview'

const FIELD_LABELS: Record<PriceFieldDTO, string> = {
  costPrice: 'Costo',
  listPrice1: 'Lista 1',
  listPrice2: 'Lista 2',
  listPrice3: 'Lista 3',
  wholesalePrice: 'Mayorista',
}

const ROUNDING_OPTIONS: Array<{ value: PriceUpdateRoundingDTO; label: string }> = [
  { value: 'none', label: 'Sin redondeo' },
  { value: 'up_to_10', label: 'Múltiplo de $10' },
  { value: 'up_to_50', label: 'Múltiplo de $50' },
  { value: 'up_to_100', label: 'Múltiplo de $100' },
  { value: 'nearest_99', label: 'Terminado en 99' },
]

export function ActualizacionPrecios() {
  const openInWindow = useWindowNav()
  const canWrite = useCanWrite()
  const canManage = usePermission('manage_prices')
  const canApply = canWrite && canManage

  const [step, setStep] = useState<Step>('filter')

  // Filtro
  const [filter, setFilter] = useState<PriceUpdateFilterDTO>({
    scope: 'all',
    onlyActive: true,
  })
  const [manualSearch, setManualSearch] = useState('')
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set())

  // Regla
  const [ruleType, setRuleType] = useState<PriceUpdateRuleTypeDTO>('percentage')
  const [ruleValue, setRuleValue] = useState('10')
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase')
  const [fields, setFields] = useState<PriceFieldDTO[]>(['listPrice1'])
  const [keepUtility, setKeepUtility] = useState(false)
  const [rounding, setRounding] = useState<PriceUpdateRoundingDTO>('none')
  const [description, setDescription] = useState('')

  // Preview
  const [previewPage, setPreviewPage] = useState(0)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)

  const families = useFamilies()
  const suppliers = useSuppliers()
  const articles = useArticles()

  const effectiveFilter = useMemo<PriceUpdateFilterDTO>(() => {
    if (filter.scope === 'manual') {
      return { ...filter, articleIds: Array.from(manualSelected) }
    }
    return filter
  }, [filter, manualSelected])

  // Contador en vivo: usa preview con regla mínima.
  const countQuery = useQuery({
    queryKey: [
      'priceUpdateCount',
      JSON.stringify(effectiveFilter),
    ],
    queryFn: () =>
      api.priceUpdate.preview(effectiveFilter, {
        type: 'percentage',
        value: '0',
        direction: 'increase',
        fields: ['listPrice1'],
      }),
    enabled:
      filter.scope !== 'manual' || manualSelected.size > 0,
    staleTime: 200,
  })

  const rule: PriceUpdateRuleDTO = useMemo(
    () => ({
      type: ruleType,
      value: ruleValue || '0',
      direction,
      fields,
      keepUtility,
      rounding,
    }),
    [ruleType, ruleValue, direction, fields, keepUtility, rounding],
  )

  const previewQuery = useQuery({
    queryKey: ['priceUpdatePreview', JSON.stringify(effectiveFilter), JSON.stringify(rule)],
    queryFn: () => api.priceUpdate.preview(effectiveFilter, rule),
    enabled: step === 'preview',
  })

  const articlesFiltered = useMemo(() => {
    const q = manualSearch.trim().toLowerCase()
    const base = articles.data ?? []
    const filtered = q
      ? base.filter(
          (a) =>
            a.barcode.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        )
      : base
    return filtered.slice(0, 50)
  }, [articles.data, manualSearch])

  function toggleField(f: PriceFieldDTO): void {
    setFields((prev) => (prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f]))
  }

  function toggleManual(id: string): void {
    setManualSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function canContinueFromFilter(): boolean {
    const cnt = countQuery.data?.articlesAffected ?? 0
    return cnt > 0
  }

  function canContinueFromRule(): boolean {
    if (fields.length === 0) return false
    if (!description.trim()) return false
    if (ruleType !== 'recalculate_from_cost') {
      const n = Number(ruleValue)
      if (!Number.isFinite(n)) return false
      if (ruleType === 'set_value' && n < 0) return false
    }
    return true
  }

  async function handleApply(): Promise<void> {
    setApplying(true)
    try {
      const result = await api.priceUpdate.apply(effectiveFilter, rule, description.trim())
      toast.success(
        `Actualizados ${result.articlesAffected} artículos (${result.entries} cambios).`,
        {
          action: {
            label: 'Ver historial',
            onClick: () => openInWindow('precios-historial'),
          },
        },
      )
      // Reset
      setStep('filter')
      setManualSelected(new Set())
      setDescription('')
      setConfirmOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo aplicar la actualización')
    } finally {
      setApplying(false)
    }
  }

  // ---------- Render por paso ----------
  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <StepDot label="1. Filtros" active={step === 'filter'} done={step !== 'filter'} />
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <StepDot label="2. Regla" active={step === 'rule'} done={step === 'preview'} />
        <ChevronRight className="h-4 w-4 text-muted-foreground" />
        <StepDot label="3. Vista previa" active={step === 'preview'} done={false} />
      </div>

      {step === 'filter' && (
        <Card className="flex-1 overflow-auto p-4">
          <div className="mb-3 text-base font-medium">Filtros — ¿a qué artículos aplica?</div>
          <div className="space-y-3">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Alcance</Label>
              <div className="flex flex-wrap gap-2">
                {(['all', 'family', 'supplier', 'manual'] as const).map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={filter.scope === s ? 'default' : 'outline'}
                    onClick={() => setFilter({ ...filter, scope: s })}
                  >
                    {s === 'all'
                      ? 'Todos'
                      : s === 'family'
                        ? 'Por familia'
                        : s === 'supplier'
                          ? 'Por proveedor'
                          : 'Manual'}
                  </Button>
                ))}
              </div>
            </div>

            {filter.scope === 'family' && (
              <div className="max-w-md">
                <Label className="mb-1 block text-xs text-muted-foreground">Familia</Label>
                <Select
                  value={filter.familyId ?? ''}
                  onChange={(e) => setFilter({ ...filter, familyId: e.target.value || undefined })}
                >
                  <option value="">— Elegí una —</option>
                  {(families.data ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {filter.scope === 'supplier' && (
              <div className="max-w-md">
                <Label className="mb-1 block text-xs text-muted-foreground">Proveedor</Label>
                <Select
                  value={filter.supplierId ?? ''}
                  onChange={(e) => setFilter({ ...filter, supplierId: e.target.value || undefined })}
                >
                  <option value="">— Elegí uno —</option>
                  {(suppliers.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {filter.scope === 'manual' && (
              <div className="rounded border p-2">
                <Input
                  placeholder="Buscar artículo por código o descripción…"
                  value={manualSearch}
                  onChange={(e) => setManualSearch(e.target.value)}
                  className="mb-2"
                />
                <div className="max-h-56 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead>Código</TableHead>
                        <TableHead>Descripción</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {articlesFiltered.map((a) => (
                        <TableRow key={a.id} onClick={() => toggleManual(a.id)} className="cursor-pointer">
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={manualSelected.has(a.id)}
                              onChange={() => toggleManual(a.id)}
                            />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{a.barcode}</TableCell>
                          <TableCell>{a.description}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Seleccionados: {manualSelected.size}
                </div>
              </div>
            )}

            <details className="rounded border p-2">
              <summary className="cursor-pointer text-sm">Filtros adicionales</summary>
              <div className="mt-2 grid grid-cols-3 gap-3">
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground">Precio mínimo (Lista 1)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={filter.minPrice ?? ''}
                    onChange={(e) => setFilter({ ...filter, minPrice: e.target.value || undefined })}
                  />
                </div>
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground">Precio máximo (Lista 1)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={filter.maxPrice ?? ''}
                    onChange={(e) => setFilter({ ...filter, maxPrice: e.target.value || undefined })}
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={!!filter.hasStock}
                      onChange={(e) => setFilter({ ...filter, hasStock: e.target.checked })}
                    />
                    Sólo con stock
                  </label>
                </div>
              </div>
            </details>

            <div className="rounded bg-muted/40 p-2 text-sm">
              <span className="font-medium">{countQuery.data?.articlesAffected ?? 0}</span>{' '}
              artículo(s) coinciden con el filtro.
            </div>
          </div>
        </Card>
      )}

      {step === 'rule' && (
        <Card className="flex-1 overflow-auto p-4">
          <div className="mb-3 text-base font-medium">Regla — ¿cómo se actualizan los precios?</div>
          <div className="space-y-3">
            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Tipo de regla</Label>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ['percentage', 'Porcentaje'],
                    ['fixed_amount', 'Monto fijo'],
                    ['set_value', 'Valor absoluto'],
                    ['recalculate_from_cost', 'Recalcular según costo'],
                  ] as Array<[PriceUpdateRuleTypeDTO, string]>
                ).map(([v, l]) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={ruleType === v ? 'default' : 'outline'}
                    onClick={() => setRuleType(v)}
                  >
                    {l}
                  </Button>
                ))}
              </div>
            </div>

            {(ruleType === 'percentage' || ruleType === 'fixed_amount') && (
              <div className="flex gap-3">
                <div>
                  <Label className="mb-1 block text-xs text-muted-foreground">Dirección</Label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={direction === 'increase' ? 'default' : 'outline'}
                      onClick={() => setDirection('increase')}
                    >
                      Aumentar
                    </Button>
                    <Button
                      size="sm"
                      variant={direction === 'decrease' ? 'default' : 'outline'}
                      onClick={() => setDirection('decrease')}
                    >
                      Bajar
                    </Button>
                  </div>
                </div>
                <div className="flex-1 max-w-xs">
                  <Label className="mb-1 block text-xs text-muted-foreground">
                    {ruleType === 'percentage' ? 'Porcentaje (%)' : 'Monto ($)'}
                  </Label>
                  {ruleType === 'fixed_amount' ? (
                    <CurrencyInput value={ruleValue} onChange={setRuleValue} />
                  ) : (
                    <Input
                      type="number"
                      step="0.01"
                      value={ruleValue}
                      onChange={(e) => setRuleValue(e.target.value)}
                    />
                  )}
                </div>
              </div>
            )}

            {ruleType === 'set_value' && (
              <div className="max-w-xs">
                <Label className="mb-1 block text-xs text-muted-foreground">Nuevo valor ($)</Label>
                <CurrencyInput value={ruleValue} onChange={setRuleValue} />
              </div>
            )}

            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">Campos a actualizar</Label>
              <div className="flex flex-wrap gap-3">
                {(Object.keys(FIELD_LABELS) as PriceFieldDTO[]).map((f) => (
                  <label key={f} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={fields.includes(f)}
                      onChange={() => toggleField(f)}
                    />
                    {FIELD_LABELS[f]}
                  </label>
                ))}
              </div>
            </div>

            {fields.includes('costPrice') && fields.some((f) => f !== 'costPrice') && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={keepUtility}
                  onChange={(e) => setKeepUtility(e.target.checked)}
                />
                Mantener % de utilidad al cambiar el costo (recalcula las listas)
              </label>
            )}

            <div className="max-w-xs">
              <Label className="mb-1 block text-xs text-muted-foreground">Redondeo</Label>
              <Select
                value={rounding}
                onChange={(e) => setRounding(e.target.value as PriceUpdateRoundingDTO)}
              >
                {ROUNDING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>

            <div>
              <Label className="mb-1 block text-xs text-muted-foreground">
                Descripción (obligatoria)
              </Label>
              <textarea
                rows={2}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={`Ej.: Aumento general ${new Date().toLocaleDateString('es-AR')}`}
              />
            </div>
          </div>
        </Card>
      )}

      {step === 'preview' && (
        <PreviewStep
          previewQuery={previewQuery}
          page={previewPage}
          setPage={setPreviewPage}
          onConfirm={() => setConfirmOpen(true)}
        />
      )}

      {/* Navegación */}
      <div className="flex items-center justify-between border-t pt-2">
        <Button
          variant="outline"
          onClick={() => {
            if (step === 'preview') setStep('rule')
            else if (step === 'rule') setStep('filter')
          }}
          disabled={step === 'filter'}
        >
          <ChevronLeft className="mr-1 h-4 w-4" />
          Volver
        </Button>
        <div className="flex gap-2">
          {step !== 'preview' && (
            <Button
              onClick={() => {
                if (step === 'filter') {
                  if (!canContinueFromFilter()) {
                    toast.warning('Ningún artículo coincide con el filtro')
                    return
                  }
                  setStep('rule')
                } else {
                  if (!canContinueFromRule()) {
                    toast.warning('Completá los datos de la regla (campos + descripción)')
                    return
                  }
                  setStep('preview')
                }
              }}
            >
              Continuar
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Aplicar la actualización?</AlertDialogTitle>
            <AlertDialogDescription>
              Se actualizarán {previewQuery.data?.articlesAffected ?? 0} artículo(s) y{' '}
              {previewQuery.data?.entries.length ?? 0} campo(s). Podés revertirla desde el
              historial.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={applying}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleApply} disabled={applying || !canApply}>
              {applying ? 'Aplicando…' : 'Confirmar'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StepDot(props: { label: string; active: boolean; done: boolean }) {
  return (
    <div
      className={`rounded px-2 py-1 text-xs ${
        props.active
          ? 'bg-primary text-primary-foreground font-medium'
          : props.done
            ? 'bg-muted text-muted-foreground'
            : 'text-muted-foreground'
      }`}
    >
      {props.label}
    </div>
  )
}

const PAGE_SIZE = 50

function PreviewStep(props: {
  previewQuery: ReturnType<typeof useQuery<import('@/types/api').PriceUpdatePreviewResultDTO>>
  page: number
  setPage: (p: number) => void
  onConfirm: () => void
}) {
  const { previewQuery, page, setPage, onConfirm } = props
  if (previewQuery.isLoading)
    return <Card className="flex-1 p-4 text-sm text-muted-foreground">Calculando…</Card>
  if (previewQuery.error || !previewQuery.data)
    return <Card className="flex-1 p-4 text-sm text-destructive">
      {previewQuery.error instanceof Error ? previewQuery.error.message : 'Error al calcular la vista previa'}
    </Card>
  const { entries, articlesAffected, averageDeltaPct } = previewQuery.data
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const slice = entries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  return (
    <Card className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b p-3 text-sm">
        Se actualizarán <span className="font-medium">{articlesAffected}</span> artículo(s) en{' '}
        <span className="font-medium">{entries.length}</span> campo(s). Δ promedio:{' '}
        <span className={averageDeltaPct >= 0 ? 'text-emerald-700' : 'text-red-700'}>
          {averageDeltaPct.toFixed(2)}%
        </span>
      </div>
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Código</TableHead>
              <TableHead>Descripción</TableHead>
              <TableHead>Campo</TableHead>
              <TableHead className="text-right">Anterior</TableHead>
              <TableHead className="text-right">Nuevo</TableHead>
              <TableHead className="text-right">Δ</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {slice.map((e) => {
              const oldN = Number(e.oldValue)
              const newN = Number(e.newValue)
              const delta = newN - oldN
              return (
                <TableRow key={`${e.articleId}-${e.field}`}>
                  <TableCell className="font-mono text-xs">{e.code}</TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell>{FIELD_LABELS[e.field]}</TableCell>
                  <TableCell className="text-right">{formatCurrency(e.oldValue)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(e.newValue)}</TableCell>
                  <TableCell
                    className={`text-right ${delta >= 0 ? 'text-emerald-700' : 'text-red-700'}`}
                  >
                    {delta >= 0 ? '+' : ''}
                    {formatCurrency(String(delta))}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-between border-t p-2 text-xs">
        <div>
          Página {safePage + 1} de {totalPages}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>
            Anterior
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            Siguiente
          </Button>
          <Button size="sm" onClick={onConfirm} className="ml-3">
            Confirmar actualización
          </Button>
        </div>
      </div>
    </Card>
  )
}
