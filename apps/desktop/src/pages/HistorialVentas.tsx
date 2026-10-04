import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2, Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useCustomers } from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { dayEnd, dayStart, todayIso } from '@/lib/periodPresets'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { SaleDetailDialog } from '@/components/SaleDetailDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PorCajaToggle, usePorCaja } from '@/components/PorCajaToggle'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SaleDTO, VoucherType } from '@/types/api'

const PAGE_SIZE = 50

/**
 * ANULAR TODAS LAS VENTAS DE HOY.
 *
 * Existe para la puesta en marcha de un local: se hacen decenas de ventas de
 * prueba con las terminales y anularlas una por una es media hora de clicks.
 *
 * Es la acción más destructiva de la pantalla, así que:
 *  - muestra ANTES qué va a tocar (cuántas ventas, cuánta plata, cuántas con CAE),
 *  - obliga a escribir ANULAR (no alcanza con un botón: se aprieta sin leer),
 *  - avisa aparte de las que tienen CAE, porque anularlas acá NO las da de baja
 *    en ARCA —eso se hace con una nota de crédito— y esa confusión sale cara.
 *
 * No borra nada: cada venta se anula como si se anulara a mano, revirtiendo
 * stock y caja, y queda en el historial marcada como anulada.
 */
function AnularVentasDeHoyDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [confirmacion, setConfirmacion] = useState('')

  const hoy = todayIso()
  const ventasDeHoyQuery = useQuery({
    queryKey: ['salesHistory', hoy, hoy],
    queryFn: () => api.sales.listByDateRange(dayStart(hoy), dayEnd(hoy)),
  })

  const aAnular = useMemo(
    () => (ventasDeHoyQuery.data ?? []).filter((s) => s.status !== 'voided'),
    [ventasDeHoyQuery.data],
  )
  const totalAAnular = aAnular.reduce((acc, s) => acc + Number(s.total), 0)
  const conCAE = aAnular.filter((s) => s.afipCAE).length

  const anularMut = useMutation({
    mutationFn: () => api.sales.voidRange(dayStart(hoy), dayEnd(hoy)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['salesHistory'] })
      void qc.invalidateQueries({ queryKey: ['articles'] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      void qc.invalidateQueries({ queryKey: ['accounts'] })
      if (r.omitidas.length > 0) {
        toast.warning(
          `Se anularon ${r.anuladas} venta(s). No se pudieron anular ${r.omitidas.length}: ` +
            r.omitidas.map((o) => `N° ${o.number} (${o.motivo})`).join(' · '),
          { duration: 15000 },
        )
      } else {
        toast.success(`Se anularon ${r.anuladas} venta(s) de hoy`)
      }
      if (r.conCAE > 0) {
        toast.warning(
          `${r.conCAE} de esas ventas tenían CAE. En ARCA siguen emitidas: para darlas de baja hay que hacer una nota de crédito.`,
          { duration: 20000 },
        )
      }
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudieron anular'),
  })

  const puedeConfirmar = confirmacion.trim().toUpperCase() === 'ANULAR' && aAnular.length > 0

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-destructive">Anular todas las ventas de hoy</DialogTitle>
        </DialogHeader>

        {ventasDeHoyQuery.isPending ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando las ventas de hoy…
          </div>
        ) : aAnular.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            Hoy no hay ventas para anular.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              Se van a anular <strong>{aAnular.length} venta(s)</strong> de hoy, por un total de{' '}
              <strong>{formatCurrency(String(totalAAnular))}</strong>.
              <br />
              Se devuelve el stock y se revierten los movimientos de caja. Quedan en el historial
              como anuladas.
            </div>

            {conCAE > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                <strong>{conCAE} tienen CAE de ARCA.</strong> Anularlas acá no las da de baja en
                ARCA: siguen emitidas y hay que hacerles una <strong>nota de crédito</strong>.
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label>Para confirmar, escriba ANULAR</Label>
              <Input
                value={confirmacion}
                onChange={(e) => setConfirmacion(e.target.value)}
                placeholder="ANULAR"
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!puedeConfirmar || anularMut.isPending}
            onClick={() => anularMut.mutate()}
          >
            {anularMut.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Anular {aAnular.length > 0 ? `${aAnular.length} venta(s)` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function HistorialVentas() {
  const { currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'
  const canWrite = useCanWrite()
  const canVoid = usePermission('void_sale') && canWrite
  const customersQuery = useCustomers()
  const usersQuery = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: isAdmin })

  const [fromIso, setFromIso] = useState(() => todayIso())
  const [toIso, setToIso] = useState(() => todayIso())
  const [customerId, setCustomerId] = useState('')
  const [sellerId, setSellerId] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | VoucherType>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'voided'>('all')
  const [searchNumber, setSearchNumber] = useState('')
  /** Filtro por forma de pago: "cuánto vendí por transferencia" en el día. */
  const [payMethod, setPayMethod] = useState('')
  const [page, setPage] = useState(0)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [anulandoHoy, setAnulandoHoy] = useState(false)

  // Deep-link: `?saleId=<id>` abre el detalle. Si la venta no está en el rango
  // actual, ampliamos el rango y resolvemos el cliente con get().
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('saleId')
    if (!id) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetailId(id)
    const next = new URLSearchParams(searchParams)
    next.delete('saleId')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const [porCaja, setPorCaja] = usePorCaja()
  const salesQuery = useQuery({
    queryKey: ['salesHistory', fromIso, toIso, porCaja],
    queryFn: () => api.sales.listByDateRange(dayStart(fromIso), dayEnd(toIso), porCaja),
  })

  const customerName = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of customersQuery.data ?? []) map.set(c.id, c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName)
    return map
  }, [customersQuery.data])
  const sellerName = useMemo(() => {
    const map = new Map<string, string>()
    for (const u of usersQuery.data ?? []) map.set(u.id, u.fullName)
    return map
  }, [usersQuery.data])

  const filtered = useMemo(() => {
    const term = searchNumber.trim()
    let rows = (salesQuery.data ?? []) as SaleDTO[]
    if (customerId) rows = rows.filter((s) => s.customerId === customerId)
    if (sellerId) rows = rows.filter((s) => s.sellerId === sellerId)
    if (typeFilter !== 'all') rows = rows.filter((s) => s.type === typeFilter)
    if (statusFilter !== 'all') rows = rows.filter((s) => s.status === statusFilter)
    if (term) rows = rows.filter((s) => String(s.number).includes(term))
    if (payMethod) rows = rows.filter((s) => (s.payments ?? []).some((p) => p.paymentMethodId === payMethod))
    return [...rows].sort((a, b) => b.date - a.date)
  }, [salesQuery.data, customerId, sellerId, typeFilter, statusFilter, searchNumber, payMethod])

  /** Formas de pago presentes en el rango, para poblar el desplegable. */
  const mediosEnRango = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of salesQuery.data ?? []) {
      for (const p of v.payments ?? []) m.set(p.paymentMethodId, p.name)
    }
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [salesQuery.data])

  /**
   * Total cobrado POR ESE MEDIO en lo filtrado. No es el total de las ventas:
   * en un pago mixto sólo cuenta la parte que entró por ese medio, que es lo
   * que el comercio quiere saber.
   */
  const totalDelMedio = useMemo(() => {
    if (!payMethod) return null
    return filtered
      .filter((s) => s.status === 'completed')
      .reduce(
        (acc, s) =>
          acc + (s.payments ?? []).filter((p) => p.paymentMethodId === payMethod).reduce((a, p) => a + Number(p.amount), 0),
        0,
      )
  }, [filtered, payMethod])

  const totalAmount = useMemo(
    () => filtered.filter((s) => s.status === 'completed').reduce((acc, s) => acc + Number(s.total), 0),
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
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Historial de Ventas</h1>
        {/* Sólo el administrador, y sólo si puede anular. Es para la puesta en
            marcha de un local: limpiar las ventas de prueba del día. */}
        {isAdmin && canVoid && (
          <Button variant="outline" size="sm" onClick={() => setAnulandoHoy(true)}>
            <Undo2 className="h-4 w-4" />
            Anular ventas de hoy
          </Button>
        )}
      </div>

      {anulandoHoy && <AnularVentasDeHoyDialog onClose={() => setAnulandoHoy(false)} />}

      <Card>
        <CardContent className="grid grid-cols-2 gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => resetPage(() => setFromIso(e.target.value))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => resetPage(() => setToIso(e.target.value))} />
            <PorCajaToggle value={porCaja} onChange={(v) => resetPage(() => setPorCaja(v))} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Cliente</Label>
            <Select value={customerId} onChange={(e) => resetPage(() => setCustomerId(e.target.value))}>
              <option value="">Todos</option>
              {(customersQuery.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.firstName ? `${c.lastName}, ${c.firstName}` : c.lastName}</option>
              ))}
            </Select>
          </div>
          {isAdmin && (
            <div className="flex flex-col gap-1">
              <Label>Vendedor</Label>
              <Select value={sellerId} onChange={(e) => resetPage(() => setSellerId(e.target.value))}>
                <option value="">Todos</option>
                {(usersQuery.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
              </Select>
            </div>
          )}
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
            <Label>Forma de pago</Label>
            <Select value={payMethod} onChange={(e) => resetPage(() => setPayMethod(e.target.value))}>
              <option value="">Todas</option>
              {mediosEnRango.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
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
                <TableHead>Cliente</TableHead>
                <TableHead>Vendedor</TableHead>
                <TableHead>Pago</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {salesQuery.isLoading ? (
                <TableRow><TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell></TableRow>
              ) : pageRows.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">No hay ventas en el rango seleccionado.</TableCell></TableRow>
              ) : (
                pageRows.map((s) => {
                  const voided = s.status === 'voided'
                  return (
                    <TableRow
                      key={s.id}
                      className={cn('cursor-pointer', voided && 'line-through opacity-60')}
                      onDoubleClick={() => setDetailId(s.id)}
                    >
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(s.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.number}</TableCell>
                      <TableCell><Badge variant="outline">{s.type}</Badge></TableCell>
                      <TableCell>{customerName.get(s.customerId) ?? '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{sellerName.get(s.sellerId) ?? (isAdmin ? '—' : '')}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.isAccountSale ? 'Cuenta cte.' : 'Contado'}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">{formatCurrency(s.total)}</TableCell>
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
        <span>
          {filtered.length} venta(s) — total completadas: <span className="font-medium tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalAmount)))}</span>
          {/* Con un medio filtrado, lo que importa es cuánto entró POR ESE medio:
              en un pago mixto solo cuenta esa parte, no el total de la venta. */}
          {totalDelMedio != null && (
            <>
              {' · '}cobrado por {mediosEnRango.find((m) => m.id === payMethod)?.name ?? 'ese medio'}:{' '}
              <span className="font-semibold tabular-nums text-foreground">{formatCurrency(parseCurrencyInput(String(totalDelMedio)))}</span>
            </>
          )}
        </span>
        {pageCount > 1 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Anterior</Button>
            <span>Página {page + 1} / {pageCount}</span>
            <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => setPage((p) => p + 1)}>Siguiente</Button>
          </div>
        )}
      </div>

      {detailId && (
        <SaleDetailDialog
          // Estado propio por venta: el documento tipeado para una no puede
          // quedar pegado a la siguiente.
          key={detailId}
          saleId={detailId}
          customerName={customerName.get((salesQuery.data ?? []).find((s) => s.id === detailId)?.customerId ?? '') ?? '—'}
          canVoid={canVoid}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
