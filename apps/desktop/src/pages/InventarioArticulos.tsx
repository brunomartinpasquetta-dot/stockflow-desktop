/**
 * P-CONSULTAS: Reporte de inventario agrupado por proveedor → familia.
 * Valuación al costo y a precio de venta + margen bruto teórico.
 */
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { Boxes, FileSpreadsheet, Printer } from 'lucide-react'

import { useFamilies, useInventoryReport, useSuppliers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function InventarioArticulos() {
  const canView = usePermission('view_reports')
  const suppliersQuery = useSuppliers()
  const familiesQuery = useFamilies()

  const [supplierId, setSupplierId] = useState('')
  const [familyId, setFamilyId] = useState('')
  const [includeZero, setIncludeZero] = useState(false)
  const [applied, setApplied] = useState<{
    supplierId?: string
    familyId?: string
    includeZeroStock?: boolean
  } | null>(null)

  const reportQuery = useInventoryReport(applied ?? {}, applied != null)

  function calcular(): void {
    setApplied({
      supplierId: supplierId || undefined,
      familyId: familyId || undefined,
      includeZeroStock: includeZero,
    })
  }

  function exportarExcel(): void {
    const data = reportQuery.data
    if (!data) return
    const rows: Array<Record<string, string | number>> = []
    for (const g of data.groups) {
      for (const f of g.families) {
        for (const a of f.articles) {
          rows.push({
            Proveedor: g.supplierName,
            Familia: f.familyName,
            Código: a.barcode,
            Descripción: a.description,
            Stock: Number(a.stock),
            Costo: Number(a.costPrice),
            'Precio venta': Number(a.listPrice1),
            'Valor al costo': Number(a.costValue),
            'Valor a venta': Number(a.saleValue),
          })
        }
      }
    }
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario')
    XLSX.writeFile(wb, `inventario-${todayIso()}.xlsx`)
  }

  if (!canView) return <Navigate to="/" replace />
  const data = reportQuery.data

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Boxes className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Inventario de artículos</h1>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 items-end gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Proveedor</Label>
            <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Todos</option>
              {(suppliersQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Familia</Label>
            <Select value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
              <option value="">Todas</option>
              {(familiesQuery.data ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
            Incluir artículos sin stock
          </label>
          <Button onClick={calcular}>Calcular</Button>
          <Button variant="outline" onClick={exportarExcel} disabled={!data || data.groups.length === 0}>
            <FileSpreadsheet className="h-4 w-4" />
            Excel
          </Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!data || data.groups.length === 0}>
            <Printer className="h-4 w-4" />
            Imprimir
          </Button>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {!applied ? (
              <div className="py-10 text-center text-muted-foreground">
                Elegí filtros y presioná "Calcular" para ver el inventario valuado.
              </div>
            ) : reportQuery.isLoading || !data ? (
              <div className="py-10 text-center text-muted-foreground">Cargando…</div>
            ) : data.groups.length === 0 ? (
              <div className="py-10 text-center text-muted-foreground">No hay artículos para mostrar.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {data.groups.map((g) => (
                  <details key={g.supplierId ?? '__none__'} className="rounded-md border bg-card">
                    <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-medium">
                      <span>{g.supplierName}</span>
                      <span className="flex gap-4 text-xs tabular-nums text-muted-foreground">
                        <span>{g.totals.articles} art.</span>
                        <span>Costo: <span className="font-medium text-foreground">{formatCurrency(g.totals.costValue)}</span></span>
                        <span>Venta: <span className="font-medium text-foreground">{formatCurrency(g.totals.saleValue)}</span></span>
                      </span>
                    </summary>
                    <div className="border-t">
                      {g.families.map((f) => (
                        <details key={f.familyId ?? '__none__'} className="border-b last:border-b-0">
                          <summary className="flex cursor-pointer items-center justify-between gap-3 bg-muted/30 px-4 py-1.5 text-sm">
                            <span>{f.familyName}</span>
                            <span className="flex gap-4 text-xs tabular-nums text-muted-foreground">
                              <span>{f.totals.articles} art.</span>
                              <span>Costo: {formatCurrency(f.totals.costValue)}</span>
                              <span>Venta: {formatCurrency(f.totals.saleValue)}</span>
                            </span>
                          </summary>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Código</TableHead>
                                <TableHead>Descripción</TableHead>
                                <TableHead className="text-right">Stock</TableHead>
                                <TableHead className="text-right">Costo</TableHead>
                                <TableHead className="text-right">Precio venta</TableHead>
                                <TableHead className="text-right">Valor costo</TableHead>
                                <TableHead className="text-right">Valor venta</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {f.articles.map((a) => (
                                <TableRow key={a.articleId}>
                                  <TableCell className="font-mono text-xs">{a.barcode}</TableCell>
                                  <TableCell>{a.description}</TableCell>
                                  <TableCell className="text-right tabular-nums">{Number(a.stock).toFixed(2)}</TableCell>
                                  <TableCell className="text-right tabular-nums">{formatCurrency(a.costPrice)}</TableCell>
                                  <TableCell className="text-right tabular-nums">{formatCurrency(a.listPrice1)}</TableCell>
                                  <TableCell className="text-right tabular-nums">{formatCurrency(a.costValue)}</TableCell>
                                  <TableCell className="text-right tabular-nums">{formatCurrency(a.saleValue)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
          {data && data.groups.length > 0 && (
            <div className="grid shrink-0 grid-cols-2 gap-2 border-t bg-muted/30 px-3 py-2 text-sm md:grid-cols-5">
              <div>
                <span className="text-muted-foreground">Artículos: </span>
                <span className="font-medium tabular-nums">{data.grandTotal.articles}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total al costo: </span>
                <span className="font-semibold tabular-nums">{formatCurrency(data.grandTotal.costValue)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total a venta: </span>
                <span className="font-semibold tabular-nums">{formatCurrency(data.grandTotal.saleValue)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">Margen bruto: </span>
                <span className="font-semibold tabular-nums">{formatCurrency(data.grandTotal.marginAmount)}</span>
              </div>
              <div>
                <span className="text-muted-foreground">% margen: </span>
                <span className="font-semibold tabular-nums">{data.grandTotal.marginPct}%</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
