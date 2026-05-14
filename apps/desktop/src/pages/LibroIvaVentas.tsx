/**
 * P-CONTABLE: Libro IVA Ventas.
 * Listado por período con desglose por alícuota, exportable a Excel/PDF.
 */
import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { BookOpen, FileSpreadsheet, Printer } from 'lucide-react'

import { useCompany, useVatBookSales } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency, formatDate } from '@/lib/format'
import { PERIOD_PRESETS, dayEnd, dayStart, toIso } from '@/lib/periodPresets'
import { exportVatBookSalesToExcel } from '@/lib/excelExport'
import { usePrintVatBook } from '@/lib/usePrint'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { VatBookSaleRowDTO } from '@/types/api'

function firstOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

type TipoFilter = 'all' | 'A' | 'B' | 'C' | 'X'

function sumActive(rows: VatBookSaleRowDTO[], field: keyof VatBookSaleRowDTO): string {
  let s = 0
  for (const r of rows) {
    if (r.status === 'voided') continue
    s += Number(r[field])
  }
  return s.toFixed(4)
}

export function LibroIvaVentas() {
  const canView = usePermission('view_accounting')
  const companyQuery = useCompany()

  const [fromIso, setFromIso] = useState(() => firstOfMonthIso())
  const [toIsoVal, setToIsoVal] = useState(() => toIso(new Date()))
  const [tipo, setTipo] = useState<TipoFilter>('all')
  const [applied, setApplied] = useState<{ from: number; to: number; type: TipoFilter } | null>(() => ({
    from: dayStart(firstOfMonthIso()),
    to: dayEnd(toIso(new Date())),
    type: 'all',
  }))

  const query = useVatBookSales(
    applied ? { from: applied.from, to: applied.to, type: applied.type } : { from: 0, to: 0 },
    applied != null,
  )
  const printVatBook = usePrintVatBook()

  function calcular(): void {
    setApplied({ from: dayStart(fromIso), to: dayEnd(toIsoVal), type: tipo })
  }
  function aplicarPreset(key: string): void {
    const preset = PERIOD_PRESETS.find((p) => p.key === key)
    if (!preset) return
    const range = preset.range()
    setFromIso(range.fromIso)
    setToIsoVal(range.toIso)
    setApplied({ from: dayStart(range.fromIso), to: dayEnd(range.toIso), type: tipo })
  }

  const data = query.data ?? []
  const totals = useMemo(
    () => ({
      net: sumActive(data, 'netAmount'),
      vat21: sumActive(data, 'vat21'),
      vat105: sumActive(data, 'vat105'),
      vat27: sumActive(data, 'vat27'),
      total: sumActive(data, 'total'),
      count: data.filter((r) => r.status !== 'voided').length,
    }),
    [data],
  )

  if (!canView) return <Navigate to="/" replace />

  function onExcel(): void {
    if (!applied || data.length === 0) return
    exportVatBookSalesToExcel(data, { from: applied.from, to: applied.to }, companyQuery.data?.name ?? 'Empresa')
  }

  function onPrint(): void {
    if (!applied || !companyQuery.data) return
    printVatBook({
      kind: 'sales',
      company: companyQuery.data,
      period: { from: applied.from, to: applied.to },
      salesRows: data,
      totals: { net: totals.net, vat21: totals.vat21, vat105: totals.vat105, vat27: totals.vat27, total: totals.total, count: totals.count },
    })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <BookOpen className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Libro IVA Ventas</h1>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-6">
            <div className="flex flex-col gap-1">
              <Label>Desde</Label>
              <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Hasta</Label>
              <Input type="date" value={toIsoVal} onChange={(e) => setToIsoVal(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Tipo</Label>
              <Select value={tipo} onChange={(e) => setTipo(e.target.value as TipoFilter)}>
                <option value="all">Todos</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="X">X</option>
              </Select>
            </div>
            <Button onClick={calcular}>Calcular</Button>
            <Button variant="outline" onClick={onExcel} disabled={data.length === 0}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button variant="outline" onClick={onPrint} disabled={data.length === 0}>
              <Printer className="h-4 w-4" />
              Imprimir
            </Button>
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

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead className="text-right">N°</TableHead>
                  <TableHead>Cliente</TableHead>
                  <TableHead>CUIT/DNI</TableHead>
                  <TableHead className="text-right">Neto</TableHead>
                  <TableHead className="text-right">IVA 21%</TableHead>
                  <TableHead className="text-right">IVA 10.5%</TableHead>
                  <TableHead className="text-right">IVA 27%</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">Cargando…</TableCell>
                  </TableRow>
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-muted-foreground">
                      Sin ventas en el rango seleccionado.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.map((r) => {
                    const voided = r.status === 'voided'
                    return (
                      <TableRow key={r.saleId} className={voided ? 'line-through opacity-60' : ''}>
                        <TableCell>{formatDate(r.date)}</TableCell>
                        <TableCell>{r.type}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.number}</TableCell>
                        <TableCell>{r.customerName}</TableCell>
                        <TableCell>{r.customerCuit ?? ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.netAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.vat21)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.vat105)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.vat27)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(r.total)}</TableCell>
                        <TableCell>
                          {voided ? <Badge variant="destructive">Anulada</Badge> : r.status === 'pending' ? <Badge variant="outline">Pendiente</Badge> : <Badge>OK</Badge>}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {data.length > 0 && (
            <div className="grid shrink-0 grid-cols-6 gap-2 border-t bg-muted/30 px-3 py-2 text-sm">
              <div className="col-span-1">
                <span className="text-muted-foreground">Comprobantes: </span>
                <span className="font-medium tabular-nums">{totals.count}</span>
              </div>
              <div className="text-right tabular-nums">Neto: <span className="font-semibold">{formatCurrency(totals.net)}</span></div>
              <div className="text-right tabular-nums">21%: <span className="font-semibold">{formatCurrency(totals.vat21)}</span></div>
              <div className="text-right tabular-nums">10.5%: <span className="font-semibold">{formatCurrency(totals.vat105)}</span></div>
              <div className="text-right tabular-nums">27%: <span className="font-semibold">{formatCurrency(totals.vat27)}</span></div>
              <div className="text-right tabular-nums">Total: <span className="font-semibold">{formatCurrency(totals.total)}</span></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
