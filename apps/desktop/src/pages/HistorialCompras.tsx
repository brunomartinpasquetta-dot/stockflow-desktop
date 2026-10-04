import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'

import { api } from '@/lib/api'
import { useSuppliers } from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { dayEnd, dayStart, todayIso } from '@/lib/periodPresets'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { PurchaseDetailDialog } from '@/components/PurchaseDetailDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { PurchaseDTO, VoucherType } from '@/types/api'

const PAGE_SIZE = 50

export function HistorialCompras() {
  const canWrite = useCanWrite()
  const canVoid = usePermission('manage_purchases') && canWrite
  const suppliersQuery = useSuppliers()

  const [fromIso, setFromIso] = useState(() => todayIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [supplierId, setSupplierId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [searchNumber, setSearchNumber] = useState('')
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)

  // Deep-link: `?purchaseId=<id>` abre el detalle.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('purchaseId')
    if (!id) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailId(id)
    const next = new URLSearchParams(searchParams)
    next.delete('purchaseId')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const purchasesQuery = useQuery({
    queryKey: ['purchasesHistory', fromIso, toIso],
    queryFn: () => api.purchases.listByDateRange(dayStart(fromIso), dayEnd(toIso)),
  })

  const supplierName = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of suppliersQuery.data ?? []) map.set(s.id, `${s.code} — ${s.name}`)
    return map
  }, [suppliersQuery.data])

  const filtered = useMemo(() => {
    const term = searchNumber.trim()
    let rows = (purchasesQuery.data ?? []) as PurchaseDTO[]
    if (supplierId) rows = rows.filter((p) => p.supplierId === supplierId)
    if (typeFilter !== 'all') rows = rows.filter((p) => p.type === typeFilter)
    if (statusFilter !== 'all') rows = rows.filter((p) => p.status === statusFilter)
    if (term) rows = rows.filter((p) => String(p.number).includes(term))
    return [...rows].sort((a, b) => b.date - a.date)
  }, [purchasesQuery.data, supplierId, typeFilter, statusFilter, searchNumber])

  const totalAmount = useMemo(
    () => filtered.filter((p) => p.status === 'completed').reduce((acc, p) => acc + Number(p.total), 0),
    [filtered],
  )
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))

  function resetPage(fn: () => void): void {
    fn()
    setPage(0)
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Historial de Compras</h1>

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => resetPage(() => setFromIso(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => resetPage(() => setToIso(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Proveedor</Label>
            <Select value={supplierId} onChange={(e) => resetPage(() => setSupplierId(e.target.value))}>
              <option value="">Todos</option>
              {(suppliersQuery.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Comprobante</Label>
            <Select value={typeFilter} onChange={(e) => resetPage(() => setTypeFilter(e.target.value as 'all' | VoucherType))}>
              <option value="all">Todos</option>
              <option value="A">Factura A</option>
              <option value="B">Factura B</option>
              <option value="C">Factura C</option>
              <option value="X">Comprobante X</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Estado</Label>
            <Select value={statusFilter} onChange={(e) => resetPage(() => setStatusFilter(e.target.value as 'all' | 'completed' | 'voided'))}>
              <option value="all">Todos</option>
              <option value="completed">Completadas</option>
              <option value="voided">Anuladas</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Buscar N°</Label>
            <Input value={searchNumber} onChange={(e) => resetPage(() => setSearchNumber(e.target.value))} placeholder="N° de comprobante" inputMode="numeric" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">N°</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Proveedor</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {purchasesQuery.isLoading ? (
                <TableRow><TableCell colSpan={7} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell></TableRow>
              ) : pageRows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">No hay compras en el rango seleccionado.</TableCell></TableRow>
              ) : (
                pageRows.map((p) => {
                  const voided = p.status === 'voided'
                  return (
                    <TableRow
                      key={p.id}
                      className={cn('cursor-pointer', voided && 'line-through opacity-60')}
                      onDoubleClick={() => setDetailId(p.id)}
                    >
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(p.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.number}</TableCell>
                      <TableCell><Badge variant="outline">{p.type}</Badge></TableCell>
                      <TableCell>{supplierName.get(p.supplierId) ?? '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{p.paymentType === 'credit' ? 'Cuenta cte.' : 'Contado'}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(p.total)}</TableCell>
                      <TableCell>
                        {voided ? <Badge variant="destructive">Anulada</Badge> : <Badge variant="success">Completada</Badge>}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{filtered.length} compra(s) — total completadas: <span className="font-medium tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalAmount)))}</span></span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <span>Página {page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        )}
      </div>

      {detailId && (
        <PurchaseDetailDialog
          purchaseId={detailId}
          supplierName={supplierName.get((purchasesQuery.data ?? []).find((p) => p.id === detailId)?.supplierId ?? '') ?? '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
