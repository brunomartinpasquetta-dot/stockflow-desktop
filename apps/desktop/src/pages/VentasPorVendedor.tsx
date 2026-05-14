/**
 * P-CONSULTAS: Ranking de ventas por vendedor en un rango.
 * Excluye ventas anuladas. Incluye % del total y barra visual SVG inline.
 */
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { BarChart3, FileSpreadsheet, Printer } from 'lucide-react'

import { useSalesByVendorReport, useUsers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function firstOfMonthIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

export function VentasPorVendedor() {
  const canView = usePermission('view_reports')
  const usersQuery = useUsers()

  const [fromIso, setFromIso] = useState(() => firstOfMonthIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [userId, setUserId] = useState('')
  const [applied, setApplied] = useState<{ from: number; to: number; userId?: string } | null>(null)

  const reportQuery = useSalesByVendorReport(applied ?? { from: 0, to: 0 }, applied != null)

  function calcular(): void {
    setApplied({
      from: dayStart(fromIso),
      to: dayEnd(toIso),
      userId: userId || undefined,
    })
  }

  function exportarExcel(): void {
    const data = reportQuery.data
    if (!data) return
    const rows = data.rows.map((r, idx) => ({
      '#': idx + 1,
      Vendedor: r.userName,
      'Ventas': r.salesCount,
      Total: Number(r.totalAmount),
      'Ticket promedio': Number(r.averageTicket),
      '% del total': Number(r.percentageOfTotal),
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Ventas por vendedor')
    XLSX.writeFile(wb, `ventas-por-vendedor-${todayIso()}.xlsx`)
  }

  if (!canView) return <Navigate to="/" replace />
  const data = reportQuery.data

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Ventas por vendedor</h1>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 items-end gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => setToIso(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Vendedor</Label>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todos</option>
              {(usersQuery.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </Select>
          </div>
          <Button onClick={calcular}>Calcular</Button>
          <Button variant="outline" onClick={exportarExcel} disabled={!data || data.rows.length === 0}>
            <FileSpreadsheet className="h-4 w-4" />
            Excel
          </Button>
          <Button variant="outline" onClick={() => window.print()} disabled={!data || data.rows.length === 0}>
            <Printer className="h-4 w-4" />
            Imprimir
          </Button>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Vendedor</TableHead>
                  <TableHead className="text-right">N° Ventas</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Ticket promedio</TableHead>
                  <TableHead className="text-right">% del total</TableHead>
                  <TableHead>Distribución</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!applied ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      Elegí filtros y presioná "Calcular".
                    </TableCell>
                  </TableRow>
                ) : reportQuery.isLoading || !data ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Cargando…</TableCell>
                  </TableRow>
                ) : data.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                      No hay ventas en el rango seleccionado.
                    </TableCell>
                  </TableRow>
                ) : (
                  data.rows.map((r, idx) => (
                    <TableRow key={r.userId}>
                      <TableCell className="tabular-nums">{idx + 1}</TableCell>
                      <TableCell>{r.userName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.salesCount}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(r.totalAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.averageTicket)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.percentageOfTotal}%</TableCell>
                      <TableCell>
                        <div className="relative h-3 w-32 rounded bg-muted">
                          <div
                            className="absolute inset-y-0 left-0 rounded bg-primary"
                            style={{ width: `${Math.min(100, Number(r.percentageOfTotal))}%` }}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          {data && data.rows.length > 0 && (
            <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {data.vendorCount} vendedor(es) activos · {data.totalSales} venta(s)
              </span>
              <span className="tabular-nums">
                Total general: <span className="font-semibold">{formatCurrency(data.grandTotal)}</span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
