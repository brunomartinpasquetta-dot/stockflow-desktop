/**
 * P-CONTABLE: pantalla principal de Contabilidad.
 * Muestra activos, ventas, CMV, resultado bruto y posición IVA en un período.
 */
import { useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Calculator, FileText, Printer } from 'lucide-react'

import { useCompany, useFinancialSummary } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { PERIOD_PRESETS, dayEnd, dayStart, toIso } from '@/lib/periodPresets'
import { usePrintAccountingSummary } from '@/lib/usePrint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function firstOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

export function Contabilidad() {
  const canView = usePermission('view_accounting')
  const companyQuery = useCompany()

  const [fromIso, setFromIso] = useState(() => firstOfMonthIso())
  const [toIsoVal, setToIsoVal] = useState(() => toIso(new Date()))
  const [applied, setApplied] = useState<{ from: number; to: number } | null>(() => ({
    from: dayStart(firstOfMonthIso()),
    to: dayEnd(toIso(new Date())),
  }))

  const summaryQuery = useFinancialSummary(applied ?? { from: 0, to: 0 }, applied != null)
  const printSummary = usePrintAccountingSummary()

  function calcular(): void {
    setApplied({ from: dayStart(fromIso), to: dayEnd(toIsoVal) })
  }

  function aplicarPreset(key: string): void {
    const preset = PERIOD_PRESETS.find((p) => p.key === key)
    if (!preset) return
    const range = preset.range()
    setFromIso(range.fromIso)
    setToIsoVal(range.toIso)
    setApplied({ from: dayStart(range.fromIso), to: dayEnd(range.toIso) })
  }

  if (!canView) return <Navigate to="/" replace />
  const data = summaryQuery.data
  const company = companyQuery.data

  const vatPositionNum = data ? Number(data.vatPosition) : 0
  const vatLabel = !data
    ? ''
    : vatPositionNum > 0.005
      ? 'Saldo a pagar'
      : vatPositionNum < -0.005
        ? 'Saldo a favor'
        : 'Sin movimiento'

  const grossNum = data ? Number(data.grossResult) : 0

  function onPrint(): void {
    if (!data || !company) return
    printSummary({ company, summary: data })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Calculator className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Contabilidad</h1>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-5">
            <div className="flex flex-col gap-1">
              <Label>Desde</Label>
              <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Hasta</Label>
              <Input type="date" value={toIsoVal} onChange={(e) => setToIsoVal(e.target.value)} />
            </div>
            <Button onClick={calcular}>Calcular</Button>
            <Button variant="outline" onClick={onPrint} disabled={!data}>
              <Printer className="h-4 w-4" />
              Imprimir
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <Link to="/contabilidad/libro-iva-ventas">
                  <FileText className="h-4 w-4" />
                  Libro IVA Ventas
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/contabilidad/libro-iva-compras">
                  <FileText className="h-4 w-4" />
                  Libro IVA Compras
                </Link>
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Atajos:</span>
            {PERIOD_PRESETS.map((p) => (
              <Button key={p.key} variant="ghost" size="sm" onClick={() => aplicarPreset(p.key)}>
                {p.label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {summaryQuery.isLoading || !data ? (
        <Card>
          <CardContent className="py-10 text-center text-muted-foreground">Cargando…</CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs uppercase text-muted-foreground">Activos</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(data.assets.total)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  <div>Artículos: {formatCurrency(data.assets.articlesValue)}</div>
                  <div>Efectivo: {formatCurrency(data.assets.cashValue)}</div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs uppercase text-muted-foreground">Ventas</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(data.sales.total)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  <div>Cantidad: {data.sales.count}</div>
                  <div>IVA débito: {formatCurrency(data.sales.vatAmount)}</div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-xs uppercase text-muted-foreground">CMV</div>
                <div className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(data.cmv.total)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Costo de Mercadería Vendida — costos actuales (no históricos).
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-center justify-between">
                  <div className="text-xs uppercase text-muted-foreground">Resultado Bruto</div>
                  {grossNum < 0 && <Badge variant="destructive">PÉRDIDA</Badge>}
                </div>
                <div className={`mt-1 text-2xl font-semibold tabular-nums ${grossNum < 0 ? 'text-destructive' : ''}`}>
                  {formatCurrency(data.grossResult)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  Margen: {data.grossMarginPct}%
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="pt-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold">Posición IVA</div>
                <Badge variant={vatPositionNum > 0.005 ? 'destructive' : 'outline'}>
                  {vatLabel}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Débito (ventas)</div>
                  <div className="text-lg font-medium tabular-nums">
                    {formatCurrency(data.sales.vatAmount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Crédito (compras)</div>
                  <div className="text-lg font-medium tabular-nums">
                    {formatCurrency(data.purchases.vatAmount)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Posición</div>
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCurrency(data.vatPosition)}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
