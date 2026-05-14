/**
 * P-CONSULTAS: Generador de órdenes de compra a partir de artículos bajo
 * stock mínimo o ideal. Permite editar la cantidad a pedir por artículo,
 * exportar a Excel, imprimir y "deep-link" a F5 Compras con las líneas
 * pre-cargadas.
 */
import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'

import { useWindowNav } from '@/lib/useWindowNav'
import * as XLSX from 'xlsx'
import { FileSpreadsheet, PackagePlus, Printer, ShoppingCart } from 'lucide-react'

import { useFamilies, useLowStockReport, useSuppliers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

type Criterio = 'min' | 'ideal'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function GeneradorCompras() {
  const canView = usePermission('view_reports')
  const openInWindow = useWindowNav()
  const suppliersQuery = useSuppliers()
  const familiesQuery = useFamilies()

  const [criterio, setCriterio] = useState<Criterio>('min')
  const [supplierId, setSupplierId] = useState('')
  const [familyId, setFamilyId] = useState('')
  const [applied, setApplied] = useState<{ supplierId?: string; familyId?: string; criteria: Criterio }>({
    criteria: 'min',
  })
  const [enabled, setEnabled] = useState(false)
  const [qtyOverrides, setQtyOverrides] = useState<Map<string, string>>(new Map())

  const reportQuery = useLowStockReport(applied, enabled)
  const rows = useMemo(() => reportQuery.data ?? [], [reportQuery.data])

  function calcular(): void {
    setApplied({
      supplierId: supplierId || undefined,
      familyId: familyId || undefined,
      criteria: criterio,
    })
    setEnabled(true)
  }

  function getQty(articleId: string, suggested: string): string {
    return qtyOverrides.get(articleId) ?? suggested
  }
  function setQty(articleId: string, value: string): void {
    setQtyOverrides((prev) => {
      const next = new Map(prev)
      next.set(articleId, value)
      return next
    })
  }

  const computed = useMemo(() => {
    return rows.map((r) => {
      const qty = Number(qtyOverrides.get(r.articleId) ?? r.suggestedQty) || 0
      const subtotal = qty * Number(r.lastCost)
      return { row: r, qty, subtotal }
    })
  }, [rows, qtyOverrides])

  const totalEstimado = useMemo(
    () => computed.reduce((acc, c) => acc + c.subtotal, 0),
    [computed],
  )

  function generarOrden(): void {
    const lines = computed
      .filter((c) => c.qty > 0)
      .map((c) => ({
        articleId: c.row.articleId,
        quantity: c.qty.toFixed(3),
        unitPrice: c.row.lastCost,
      }))
    if (lines.length === 0) return
    openInWindow('compras', { extras: { prefilledLines: lines, from: 'lowStock' } })
  }

  function exportarExcel(): void {
    const rowsXlsx = computed.map((c) => ({
      Código: c.row.barcode,
      Descripción: c.row.description,
      Familia: c.row.familyName ?? 'Sin familia',
      Proveedor: c.row.supplierName ?? 'Sin proveedor',
      Stock: Number(c.row.currentStock),
      Umbral: Number(c.row.threshold),
      'A pedir': c.qty,
      Costo: Number(c.row.lastCost),
      Subtotal: c.subtotal,
    }))
    const ws = XLSX.utils.json_to_sheet(rowsXlsx)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Generador compras')
    XLSX.writeFile(wb, `generador-compras-${todayIso()}.xlsx`)
  }

  if (!canView) return <Navigate to="/" replace />

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <PackagePlus className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Generador de compras</h1>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 items-end gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1 md:col-span-2">
            <Label>Criterio</Label>
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="criterio"
                  checked={criterio === 'min'}
                  onChange={() => setCriterio('min')}
                />
                Stock mínimo
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="criterio"
                  checked={criterio === 'ideal'}
                  onChange={() => setCriterio('ideal')}
                />
                Stock ideal
              </label>
            </div>
          </div>
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
          <Button onClick={calcular}>Calcular</Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportarExcel} disabled={rows.length === 0}>
              <FileSpreadsheet className="h-4 w-4" />
              Excel
            </Button>
            <Button variant="outline" onClick={() => window.print()} disabled={rows.length === 0}>
              <Printer className="h-4 w-4" />
              Imprimir
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Código</TableHead>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Familia</TableHead>
                  <TableHead>Proveedor</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="text-right">Umbral</TableHead>
                  <TableHead className="text-right">A pedir</TableHead>
                  <TableHead className="text-right">Costo</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reportQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">Cargando…</TableCell>
                  </TableRow>
                ) : !enabled ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                      Elegí filtros y presioná "Calcular" para listar los artículos a reponer.
                    </TableCell>
                  </TableRow>
                ) : computed.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                      No hay artículos por debajo del {applied.criteria === 'min' ? 'stock mínimo' : 'stock ideal'} con los filtros aplicados.
                    </TableCell>
                  </TableRow>
                ) : (
                  computed.map((c) => (
                    <TableRow key={c.row.articleId}>
                      <TableCell className="font-mono text-xs">{c.row.barcode}</TableCell>
                      <TableCell>{c.row.description}</TableCell>
                      <TableCell>{c.row.familyName ?? 'Sin familia'}</TableCell>
                      <TableCell>{c.row.supplierName ?? 'Sin proveedor'}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(c.row.currentStock).toFixed(2)}</TableCell>
                      <TableCell className="text-right tabular-nums">{Number(c.row.threshold).toFixed(2)}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          type="number"
                          step="1"
                          className="h-8 w-24 text-right tabular-nums"
                          value={getQty(c.row.articleId, c.row.suggestedQty)}
                          onChange={(e) => setQty(c.row.articleId, e.target.value)}
                        />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(c.row.lastCost)}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(c.subtotal)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{computed.length} artículo(s)</span>
            <span className="tabular-nums">
              Total estimado: <span className="font-semibold">{formatCurrency(totalEstimado)}</span>
            </span>
            <Button onClick={generarOrden} disabled={computed.length === 0}>
              <ShoppingCart className="h-4 w-4" />
              Generar orden de compra
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
