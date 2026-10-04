import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWindowNav } from '@/lib/useWindowNav'
import { toast } from 'sonner'
import { Loader2, Printer, History } from 'lucide-react'

import {
  useHistoricalCashRegisters,
  useHistoricalCashReport,
  useCompany,
  useCurrentCash,
  useUsers,
} from '@/lib/hooks'
import { useCajaPorPc } from '@/lib/useFuncion'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { api } from '@/lib/api'
import { usePrintHistoricalCashReport, usePrintCashClose } from '@/lib/usePrint'
import { formatCurrency, formatDate, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { dayEnd, dayStart, isoDaysAgo, todayIso } from '@/lib/periodPresets'
import { cn } from '@/lib/utils'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type {
  HistoricalCashRegisterDTO,
  HistoricalCashMovementDTO,
} from '@/types/api'

/**
 * TURNO — inferido por la hora de apertura, sin campo cargado a mano.
 *
 * Pedirle al cajero que tipee el turno cada vez que abre la caja es un paso
 * más y una fuente segura de inconsistencia (cada uno lo escribe distinto,
 * o se olvida). Los cortes de abajo son un supuesto razonable para un
 * comercio de mostrador; si el negocio tiene horarios muy irregulares, el
 * turno mostrado puede no coincidir con el real — es una lectura aproximada,
 * no un dato que el cajero confirmó.
 */
type Turno = 'Mañana' | 'Tarde' | 'Noche'
function inferirTurno(openDate: number): Turno {
  const h = new Date(openDate).getHours()
  if (h >= 6 && h < 14) return 'Mañana'
  if (h >= 14 && h < 21) return 'Tarde'
  return 'Noche'
}
function horaDe(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function isoDeFecha(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** Todos los días ISO entre dos fechas (inclusive), para que el calendario
 *  muestre también los días sin ninguna caja. Tope de un año por seguridad. */
function diasEntre(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  let cur = new Date(`${fromIso}T00:00:00`)
  const fin = new Date(`${toIso}T00:00:00`)
  let guard = 0
  while (cur.getTime() <= fin.getTime() && guard < 366) {
    out.push(isoDeFecha(cur.getTime()))
    cur = new Date(cur.getTime() + 86_400_000)
    guard++
  }
  return out
}

function TurnoBadge({ turno }: { turno: Turno }) {
  const cls =
    turno === 'Mañana'
      ? 'bg-amber-100 text-amber-800'
      : turno === 'Tarde'
        ? 'bg-sky-100 text-sky-800'
        : 'bg-indigo-100 text-indigo-800'
  return <Badge variant="outline" className={cls}>{turno}</Badge>
}

/** Un día del calendario: coloreado por lo que pasó ese día, no por el monto. */
function DiaCuadro({
  iso,
  registros,
  seleccionado,
  onClick,
}: {
  iso: string
  registros: HistoricalCashRegisterDTO[]
  seleccionado: boolean
  onClick: () => void
}) {
  const dia = Number(iso.slice(8, 10))
  const esPrimeroDeMes = dia === 1
  const hayAbierta = registros.some((r) => r.status === 'open')
  const hayDiferencia = registros.some((r) => r.difference != null && Math.abs(Number(r.difference)) > 0.005)
  const tono =
    registros.length === 0
      ? 'border-dashed border-muted-foreground/30 bg-muted/20 text-muted-foreground'
      : hayAbierta
        ? 'border-blue-300 bg-blue-50'
        : hayDiferencia
          ? 'border-amber-300 bg-amber-50'
          : 'border-emerald-300 bg-emerald-50'
  return (
    <button
      type="button"
      onClick={onClick}
      title={registros.length > 0 ? `${registros.length} caja${registros.length > 1 ? 's' : ''} este día` : 'Sin cajas este día'}
      className={cn(
        'flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-md border text-xs transition-colors hover:brightness-95',
        tono,
        seleccionado && 'ring-2 ring-primary ring-offset-1',
      )}
    >
      <span className="font-semibold leading-none">{dia}</span>
      {esPrimeroDeMes && (
        <span className="text-[9px] uppercase leading-none text-muted-foreground">
          {new Date(`${iso}T00:00:00`).toLocaleDateString('es-AR', { month: 'short' })}
        </span>
      )}
      {registros.length > 0 && (
        <span className="text-[9px] leading-none text-muted-foreground">
          {registros.length === 1 ? '1 caja' : `${registros.length} cajas`}
        </span>
      )}
    </button>
  )
}

/**
 * Pestaña "Por día": la planilla de papel, en pantalla — un cuadrado por día,
 * y al tocarlo, el detalle que antes se anotaba a mano: turno, cajero, hora
 * de apertura, hora de cierre y saldo final.
 */
function PorDiaTab({
  list,
  fromIso,
  toIso,
}: {
  list: HistoricalCashRegisterDTO[]
  fromIso: string
  toIso: string
}) {
  const [diaSel, setDiaSel] = useState<string | null>(null)

  const porDia = useMemo(() => {
    const map = new Map<string, HistoricalCashRegisterDTO[]>()
    for (const r of list) {
      const k = isoDeFecha(r.openDate)
      const arr = map.get(k) ?? []
      arr.push(r)
      map.set(k, arr)
    }
    return map
  }, [list])

  const dias = useMemo(() => diasEntre(fromIso, toIso), [fromIso, toIso])
  const registrosDelDia = useMemo(
    () => (diaSel ? (porDia.get(diaSel) ?? []).slice().sort((a, b) => a.openDate - b.openDate) : []),
    [diaSel, porDia],
  )

  if (dias.length === 0) {
    return <p className="text-sm text-muted-foreground">Seleccione un rango de fechas para ver el calendario.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {dias.map((iso) => (
          <DiaCuadro
            key={iso}
            iso={iso}
            registros={porDia.get(iso) ?? []}
            seleccionado={diaSel === iso}
            onClick={() => setDiaSel((cur) => (cur === iso ? null : iso))}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-emerald-300 bg-emerald-50" /> cerrada, sin diferencia</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-amber-300 bg-amber-50" /> cerrada, con diferencia</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-blue-300 bg-blue-50" /> abierta</span>
        <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm border border-dashed border-muted-foreground/30 bg-muted/20" /> sin cajas</span>
      </div>

      {diaSel && (
        <Card>
          <CardContent className="flex flex-col gap-2 pt-4">
            <span className="text-sm font-medium">{formatDate(dayStart(diaSel))}</span>
            {registrosDelDia.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin cajas este día.</p>
            ) : (
              <div className="flex flex-col divide-y">
                {registrosDelDia.map((r) => (
                  <div key={r.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                    <TurnoBadge turno={inferirTurno(r.openDate)} />
                    <span className="min-w-32 font-medium">{r.userName}</span>
                    <span className="tabular-nums text-muted-foreground">
                      {horaDe(r.openDate)} – {r.closeDate ? horaDe(r.closeDate) : 'en curso'}
                    </span>
                    <span className="ml-auto tabular-nums">
                      {r.closingAmount ? formatCurrency(r.closingAmount) : '—'}
                    </span>
                    <StatusBadge r={r} />
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function StatusBadge({ r }: { r: HistoricalCashRegisterDTO }) {
  if (r.status === 'open') return <Badge variant="outline" className="bg-blue-100 text-blue-700">ABIERTA</Badge>
  const diff = Number(r.difference ?? '0')
  if (diff > 0.005) return <Badge variant="outline" className="bg-amber-100 text-amber-800">Sobrante {formatCurrency(diff)}</Badge>
  if (diff < -0.005) return <Badge variant="destructive">Faltante {formatCurrency(Math.abs(diff))}</Badge>
  return <Badge variant="success">Cerrada</Badge>
}

/**
 * Abre el Historial de Ventas mostrando esa venta. Usa el deep-link que esa
 * pantalla ya soporta (`?saleId=`), así funciona igual en la app y en las
 * terminales por navegador.
 */
function useAbrirVenta() {
  const abrirVentana = useWindowNav()
  return (saleId: string) => abrirVentana('historial-ventas', { params: { saleId } })
}

function movementKindLabel(m: HistoricalCashMovementDTO): string {
  if (m.relatedSaleId) {
    const n = m.saleNumber != null ? ` N° ${m.saleNumber}` : ''
    return m.type === 'income' ? `Venta${n}` : `Anulación venta${n}`
  }
  if (m.relatedPurchaseId) {
    const n = m.purchaseNumber != null ? ` N° ${m.purchaseNumber}` : ''
    return `Compra${n}`
  }
  if (m.description.toLowerCase().startsWith('cobranza')) return 'Cobro'
  return m.type === 'income' ? 'Ingreso' : 'Egreso'
}

function HistoricalCashReportDialog({
  cashRegisterId,
  closedByName,
  onClose,
}: {
  cashRegisterId: string
  closedByName: string
  onClose: () => void
}) {
  const reportQuery = useHistoricalCashReport(cashRegisterId)
  const companyQuery = useCompany()
  const printCashClose = usePrintCashClose()
  const abrirVenta = useAbrirVenta()

  const r = reportQuery.data

  /**
   * Filtro de la grilla de movimientos: por MEDIO de pago y/o SÓLO VENTAS.
   * Es la pregunta con la que se abre este detalle ("¿cuánto vendí por
   * transferencia en esta caja?"), así que se responde acá mismo, con el
   * total de lo filtrado a la vista.
   */
  const [medioFiltro, setMedioFiltro] = useState('')
  const [soloVentas, setSoloVentas] = useState(false)
  const mediosDisponibles = useMemo(() => {
    const set = new Map<string, string>()
    for (const m of r?.movementsDetail ?? []) {
      set.set(m.paymentMethodName ?? '__sin__', m.paymentMethodName ?? 'Sin medio')
    }
    return [...set.entries()].map(([key, name]) => ({ key, name }))
  }, [r?.movementsDetail])
  const movimientosFiltrados = useMemo(() => {
    let lista = r?.movementsDetail ?? []
    if (soloVentas) lista = lista.filter((m) => m.relatedSaleId != null)
    if (medioFiltro) lista = lista.filter((m) => (m.paymentMethodName ?? '__sin__') === medioFiltro)
    return lista
  }, [r?.movementsDetail, medioFiltro, soloVentas])
  const totalFiltrado = useMemo(
    () =>
      movimientosFiltrados.reduce(
        (a, m) => a + (m.type === 'income' ? Number(m.amount) : -Number(m.amount)),
        0,
      ),
    [movimientosFiltrados],
  )

  async function handlePrint(): Promise<void> {
    if (!r || !companyQuery.data) return
    try {
      await printCashClose({ company: companyQuery.data, report: r, closedBy: closedByName })
    } catch {
      toast.warning('No se pudo imprimir el reporte')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {r ? `Caja #${r.register.number} — ${formatDateTime(r.register.openDate)}` : 'Detalle de caja'}
          </DialogTitle>
        </DialogHeader>
        {reportQuery.isLoading || !r ? (
          <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/30 p-3 md:grid-cols-3">
              <div><span className="text-muted-foreground">Apertura: </span>{formatDateTime(r.register.openDate)}</div>
              <div><span className="text-muted-foreground">Cierre: </span>{r.register.closeDate ? formatDateTime(r.register.closeDate) : '—'}</div>
              <div><span className="text-muted-foreground">Cajero: </span>{closedByName}</div>
              <div><span className="text-muted-foreground">Apertura: </span><span className="tabular-nums">{formatCurrency(r.openingAmount)}</span></div>
              <div><span className="text-muted-foreground">Ingresos: </span><span className="tabular-nums">{formatCurrency(r.incomeTotal)}</span></div>
              <div><span className="text-muted-foreground">Egresos: </span><span className="tabular-nums">{formatCurrency(r.expenseTotal)}</span></div>
              <div><span className="text-muted-foreground">Esperado: </span><span className="tabular-nums">{formatCurrency(r.expectedCash)}</span></div>
              <div><span className="text-muted-foreground">Declarado: </span><span className="tabular-nums">{r.closingAmount ? formatCurrency(r.closingAmount) : '—'}</span></div>
              <div><span className="text-muted-foreground">Diferencia: </span><span className="tabular-nums">{r.difference ? formatCurrency(r.difference) : '—'}</span></div>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Desglose por medio de pago</h3>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Ingresos</TableHead>
                      <TableHead className="text-right">Egresos</TableHead>
                      <TableHead className="text-right">Neto</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.byPaymentMethod.length === 0 ? (
                      <TableRow><TableCell colSpan={4} className="py-3 text-center text-muted-foreground">Sin movimientos</TableCell></TableRow>
                    ) : r.byPaymentMethod.map((b) => (
                      <TableRow key={b.paymentMethodId ?? '__none__'}>
                        <TableCell>{b.name}{b.isPhysicalCash ? ' (efectivo)' : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(b.incomeTotal)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(b.expenseTotal)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.net)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
            <div>
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold">
                  Movimientos ({movimientosFiltrados.length}
                  {movimientosFiltrados.length !== r.movementsDetail.length ? ` de ${r.movementsDetail.length}` : ''})
                </h3>
                <Select
                  className="h-7 w-44 px-2 text-xs"
                  value={medioFiltro}
                  onChange={(e) => setMedioFiltro(e.target.value)}
                >
                  <option value="">Todos los medios</option>
                  {mediosDisponibles.map((m) => (
                    <option key={m.key} value={m.key}>{m.name}</option>
                  ))}
                </Select>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-primary"
                    checked={soloVentas}
                    onChange={(e) => setSoloVentas(e.target.checked)}
                  />
                  Sólo ventas
                </label>
                {(medioFiltro || soloVentas) && (
                  <span className="ml-auto text-xs tabular-nums">
                    Total filtrado: <span className="font-semibold">{formatCurrency(totalFiltrado)}</span>
                  </span>
                )}
              </div>
              <div className="max-h-60 overflow-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Hora</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Concepto</TableHead>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Ingreso</TableHead>
                      <TableHead className="text-right">Egreso</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {movimientosFiltrados.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="py-4 text-center text-muted-foreground">Sin movimientos con ese filtro</TableCell></TableRow>
                    ) : movimientosFiltrados.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(m.date)}</TableCell>
                        <TableCell className="text-xs">
                          {m.relatedSaleId ? (
                            // Clickeable: la pregunta natural al revisar una
                            // caja es "¿qué fue esta venta?", y antes había que
                            // anotar el número e ir a mano al Historial.
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={() => abrirVenta(m.relatedSaleId!)}
                              title="Ver el detalle de esta venta"
                            >
                              {movementKindLabel(m)}
                            </button>
                          ) : (
                            movementKindLabel(m)
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{m.description}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.paymentMethodName ?? '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.type === 'income' ? formatCurrency(m.amount) : ''}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.type === 'expense' ? formatCurrency(m.amount) : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cerrar</Button>
          <Button onClick={() => void handlePrint()} disabled={!r}>
            <Printer className="h-4 w-4" />
            Imprimir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/**
 * Recuperación de un cierre sin depósito: el diálogo de "Ingresar a Caja
 * General" aparece una sola vez tras cerrar la caja. Si se perdió (error,
 * reinicio, "No ingresar" por equivocación), desde acá se ingresa después.
 * Misma lógica de desglose efectivo/electrónico que el paso 2 del cierre.
 */
function DepositarCierreDialog({
  register,
  onClose,
}: {
  register: HistoricalCashRegisterDTO
  onClose: () => void
}) {
  const reportQuery = useHistoricalCashReport(register.id)
  const [saving, setSaving] = useState(false)

  const r = reportQuery.data
  const counted = Number(register.closingAmount ?? '0')
  const elecPart = (r?.byPaymentMethod ?? [])
    .filter((b) => !b.isPhysicalCash)
    .reduce((acc, b) => acc + Math.max(0, Number(b.net ?? 0)), 0)
  const yaIngresado = Number(register.depositedAmount ?? '0')
  // AUDITORÍA sep-2026 (A8): antes se suponía que lo ya ingresado había sido
  // primero efectivo y después electrónico; si el primer ingreso fue sólo la
  // parte electrónica, el complemento volvía a ofrecerla. Cada movimiento de
  // Caja General guarda su desglose y acá se usa el real.
  const yaEfectivo = Number(register.depositedCashAmount ?? '0')
  const yaElectronico = Number(register.depositedElectronicAmount ?? '0')

  // Mismo criterio que el paso 2 del cierre: lo cobrado con tarjeta y
  // transferencia entra completo (ya está en la cuenta), y lo único que se
  // ajusta es el efectivo. Acá además se descuenta lo que ya se ingresó.
  const elecPendiente = Math.max(0, Number((elecPart - yaElectronico).toFixed(2)))
  const efePendiente = Math.max(0, Number((counted - yaEfectivo).toFixed(2)))
  const [efectivo, setEfectivo] = useState(efePendiente.toFixed(2))
  const monto = parseCurrencyInput(efectivo)
  const totalIngresa = Number(monto) + elecPendiente
  const excede = Number(monto) > efePendiente + 0.005

  async function submit(): Promise<void> {
    if (Number(monto) < 0) {
      toast.error('El efectivo no puede ser negativo')
      return
    }
    if (excede) {
      toast.error(`Del efectivo de ese cierre quedan ${formatCurrency(efePendiente.toFixed(2))} por ingresar`)
      return
    }
    if (totalIngresa <= 0) {
      toast.error('No queda nada por ingresar de este cierre')
      return
    }
    setSaving(true)
    try {
      await api.cashGeneral.transferFromClosed({
        cashRegisterId: register.id,
        amount: totalIngresa.toFixed(2),
        cashAmount: Number(monto).toFixed(2),
        electronicAmount: elecPendiente.toFixed(2),
      })
      toast.success(`Ingresado ${formatCurrency(totalIngresa.toFixed(2))} a Caja General`)
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo ingresar a Caja General')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ingresar cierre a Caja General</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {yaIngresado > 0
              ? `Del cierre de la caja #${register.number} se ingresaron ${formatCurrency(register.depositedAmount)} de ${formatCurrency(register.depositableAmount)}.`
              : `El cierre de la caja #${register.number} (${formatDateTime(register.closeDate ?? register.openDate)}) todavía no fue ingresado a Caja General.`}
          </p>
          {reportQuery.isLoading ? (
            <div className="py-4 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <>
              {elecPendiente > 0.005 && (
                <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Cobrado con tarjeta y transferencia</span>
                    <b className="tabular-nums">{formatCurrency(elecPendiente.toFixed(2))}</b>
                  </div>
                  {(r?.byPaymentMethod ?? []).filter((b) => !b.isPhysicalCash && Number(b.net ?? 0) !== 0).map((b) => (
                    <div key={b.paymentMethodId ?? b.name} className="flex justify-between text-xs text-muted-foreground">
                      <span>{b.name}</span><span className="tabular-nums">{formatCurrency(b.net ?? '0')}</span>
                    </div>
                  ))}
                  <span className="mt-0.5 text-[11px] text-muted-foreground">Entra completo: esa plata ya está en la cuenta.</span>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <Label htmlFor="late-deposit-cash">Efectivo a ingresar</Label>
                <CurrencyInput id="late-deposit-cash" value={efectivo} onChange={setEfectivo} autoFocus />
                <span className="text-xs text-muted-foreground">
                  De ese cierre quedan {formatCurrency(efePendiente.toFixed(2))} de efectivo por ingresar.
                </span>
              </div>
              <div className="flex items-center justify-between rounded-md bg-primary/10 px-3 py-2">
                <span className="text-sm font-medium">Total que ingresa</span>
                <b className="text-lg tabular-nums">{formatCurrency(totalIngresa.toFixed(2))}</b>
              </div>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={saving || reportQuery.isLoading || excede}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar ingreso
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * CAJA POR PC: cerrar la caja que quedó abierta en OTRA PC (ver
 * electron/ipc/caja-por-pc.ts). Pasa cuando esa PC se apagó o se reinstaló,
 * cuando un navegador perdió sus datos, o cuando hay que volver a la caja
 * única. Es el mismo cierre de siempre (`cash:close`, permiso close_cash):
 * se declara el efectivo contado en ese cajón y queda el arqueo; después se
 * ingresa a Caja General desde esta misma grilla, como cualquier cierre.
 */
function CerrarCajaDeOtraPcDialog({
  register,
  onClose,
}: {
  register: HistoricalCashRegisterDTO
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [contado, setContado] = useState('')
  const [notas, setNotas] = useState('')
  const [saving, setSaving] = useState(false)

  async function submit(): Promise<void> {
    const monto = parseCurrencyInput(contado)
    if (contado.trim() === '' || Number(monto) < 0) {
      toast.error('Ingrese el efectivo contado en ese cajón')
      return
    }
    setSaving(true)
    try {
      await api.cash.close(register.id, Number(monto).toFixed(4), notas.trim() || 'Cerrada desde el Historial (caja de otra PC)')
      toast.success(`Caja #${register.number} cerrada`)
      await qc.invalidateQueries({ queryKey: ['cash'] })
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cerrar la caja')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cerrar caja de otra PC</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Caja #{register.number}
            {register.terminalName ? ` de ${register.terminalName}` : ''}, abierta el {formatDateTime(register.openDate)} por{' '}
            {register.userName}. Efectivo esperado: {register.expectedAmount ? formatCurrency(register.expectedAmount) : '—'}.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cierre-otra-pc">Efectivo contado</Label>
            <CurrencyInput id="cierre-otra-pc" value={contado} onChange={setContado} autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cierre-otra-pc-notas">Observaciones</Label>
            <Input id="cierre-otra-pc-notas" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Opcional" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Cerrar caja
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Días enteros desde que se abrió (para avisar de una caja olvidada). */
function diasAbierta(openDate: number): number {
  return Math.floor((Date.now() - openDate) / 86_400_000)
}

export function HistorialCajas() {
  const { currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'

  const [fromIso, setFromIso] = useState(() => isoDaysAgo(30))
  const [toIso, setToIso] = useState(() => todayIso())
  const [userId, setUserId] = useState('')
  const [turnoFiltro, setTurnoFiltro] = useState<Turno | ''>('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [depositRegId, setDepositRegId] = useState<string | null>(null)
  const [cerrarRegId, setCerrarRegId] = useState<string | null>(null)
  const canWrite = useCanWrite()
  // Caja por PC: las cajas abiertas de OTRAS PC se pueden cerrar desde acá.
  // Con la opción apagada (licencia común) la grilla queda como siempre.
  const cajaPorPc = useCajaPorPc()
  const puedeCerrarCajas = usePermission('close_cash')
  const cajaActual = useCurrentCash()
  const [appliedRange, setAppliedRange] = useState({
    from: dayStart(isoDaysAgo(30)),
    to: dayEnd(todayIso()),
    userId: '' as string | undefined,
  })

  const usersQuery = useUsers()
  const companyQuery = useCompany()
  const listQuery = useHistoricalCashRegisters({
    from: appliedRange.from,
    to: appliedRange.to,
    userId: appliedRange.userId || undefined,
  })
  const printRange = usePrintHistoricalCashReport()

  const userNameById = useMemo(
    () => new Map((usersQuery.data ?? []).map((u) => [u.id, u.fullName])),
    [usersQuery.data],
  )

  // El filtro de turno es SOLO de este lado (se infiere de la hora, no hay
  // nada que consultarle al servidor): se aplica sobre lo que ya trajo el
  // rango de fechas, igual que el filtro de medio de pago en el detalle.
  const list = useMemo(
    () => (listQuery.data ?? []).filter((r) => !turnoFiltro || inferirTurno(r.openDate) === turnoFiltro),
    [listQuery.data, turnoFiltro],
  )

  const totals = useMemo(() => {
    const income = list.reduce((a, r) => a + Number(r.totalIncome), 0)
    const expense = list.reduce((a, r) => a + Number(r.totalExpense), 0)
    return { income, expense, net: income - expense }
  }, [list])

  function calcular(): void {
    setAppliedRange({ from: dayStart(fromIso), to: dayEnd(toIso), userId: userId || undefined })
  }

  function imprimirRango(): void {
    if (!companyQuery.data) return
    printRange({
      company: companyQuery.data,
      from: appliedRange.from,
      to: appliedRange.to,
      userName: appliedRange.userId ? userNameById.get(appliedRange.userId) : undefined,
      registers: list,
    })
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <History className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Historial de cajas diarias</h1>
      </div>


      <Card>
        <CardContent className="grid grid-cols-2 items-end gap-3 pt-4 md:grid-cols-6">
          <div className="flex flex-col gap-1">
            <Label>Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => setToIso(e.target.value)} />
          </div>
          {isAdmin && (
            <div className="flex flex-col gap-1">
              <Label>Cajero</Label>
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                <option value="">Todos</option>
                {(usersQuery.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.fullName}</option>
                ))}
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1">
            <Label>Turno</Label>
            <Select value={turnoFiltro} onChange={(e) => setTurnoFiltro(e.target.value as Turno | '')}>
              <option value="">Todos</option>
              <option value="Mañana">Mañana</option>
              <option value="Tarde">Tarde</option>
              <option value="Noche">Noche</option>
            </Select>
          </div>
          <Button onClick={calcular}>Calcular</Button>
          <Button variant="outline" onClick={imprimirRango} disabled={list.length === 0}>
            <Printer className="h-4 w-4" />
            Imprimir rango
          </Button>
        </CardContent>
      </Card>

      <Tabs defaultValue="listado" className="flex min-h-0 flex-1 flex-col gap-2">
        <TabsList>
          <TabsTrigger value="listado">Listado</TabsTrigger>
          <TabsTrigger value="por-dia">Por día</TabsTrigger>
        </TabsList>

        <TabsContent value="listado" className="flex min-h-0 flex-1 flex-col gap-0">
      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha apertura</TableHead>
                  <TableHead>Turno</TableHead>
                  <TableHead>Cajero</TableHead>
                  <TableHead className="text-right">Apertura</TableHead>
                  <TableHead className="text-right">Ingresos</TableHead>
                  <TableHead className="text-right">Egresos</TableHead>
                  <TableHead className="text-right">Esperado</TableHead>
                  <TableHead className="text-right">Cierre</TableHead>
                  <TableHead className="text-right">Diferencia</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Caja General</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listQuery.isLoading ? (
                  <TableRow><TableCell colSpan={11} className="py-8 text-center text-muted-foreground">Cargando…</TableCell></TableRow>
                ) : list.length === 0 ? (
                  <TableRow><TableCell colSpan={11} className="py-10 text-center text-muted-foreground">No hay cajas en el rango seleccionado.</TableCell></TableRow>
                ) : (
                  list.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      title="Ver los movimientos de esta caja"
                      onClick={() => setDetailId(r.id)}
                    >
                      <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.openDate)}</TableCell>
                      <TableCell><TurnoBadge turno={inferirTurno(r.openDate)} /></TableCell>
                      <TableCell className="text-xs">{r.userName}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.openingAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums text-success">{formatCurrency(r.totalIncome)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{formatCurrency(r.totalExpense)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.expectedAmount ? formatCurrency(r.expectedAmount) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.closingAmount ? formatCurrency(r.closingAmount) : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.difference ? formatCurrency(r.difference) : '—'}</TableCell>
                      <TableCell><StatusBadge r={r} /></TableCell>
                      <TableCell>
                        {r.status !== 'closed' ? (
                          cajaPorPc && canWrite && puedeCerrarCajas && r.id !== cajaActual.data?.id ? (
                            <div className="flex items-center gap-2">
                              {diasAbierta(r.openDate) >= 1 && (
                                <span className="text-xs text-amber-700">hace {diasAbierta(r.openDate)} d</span>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                title={r.terminalName ? `Caja abierta en ${r.terminalName}` : 'Caja abierta en otra PC'}
                                onClick={(e) => { e.stopPropagation(); setCerrarRegId(r.id) }}
                              >
                                Cerrar
                              </Button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )
                        ) : r.depositedToGeneral ? (
                          <Badge variant="success">Ingresado</Badge>
                        ) : (
                          <div className="flex items-center gap-2">
                            {Number(r.depositedAmount) > 0 && (
                              <span className="text-xs text-amber-700">
                                falta {formatCurrency(
                                  (Number(r.depositableAmount) - Number(r.depositedAmount)).toFixed(2),
                                )}
                              </span>
                            )}
                            {canWrite ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={(e) => { e.stopPropagation(); setDepositRegId(r.id) }}
                              >
                                {Number(r.depositedAmount) > 0 ? 'Completar' : 'Ingresar'}
                              </Button>
                            ) : (
                              <Badge variant="outline" className="bg-amber-100 text-amber-800">
                                {Number(r.depositedAmount) > 0 ? 'Parcial' : 'Sin ingresar'}
                              </Badge>
                            )}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{list.length} caja(s)</span>
            <span className="tabular-nums">
              Ingresos: <span className="font-medium text-success">{formatCurrency(totals.income)}</span>
              {' · '}Egresos: <span className="font-medium text-destructive">{formatCurrency(totals.expense)}</span>
              {' · '}Saldo neto: <span className="font-semibold">{formatCurrency(totals.net)}</span>
            </span>
          </div>
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="por-dia" className="min-h-0 flex-1 overflow-auto">
          <PorDiaTab list={list} fromIso={isoDeFecha(appliedRange.from)} toIso={isoDeFecha(appliedRange.to)} />
        </TabsContent>
      </Tabs>

      {/* SIN panel de detalle en la página: el detalle por movimiento vive en
          el diálogo (doble clic sobre la caja), con su propio filtro por medio
          de pago. Pedido de Bruno (20-ago-2026): la página es la grilla. */}
      {depositRegId && (() => {
        const reg = list.find((r) => r.id === depositRegId)
        return reg ? (
          <DepositarCierreDialog register={reg} onClose={() => setDepositRegId(null)} />
        ) : null
      })()}

      {cerrarRegId && (() => {
        const reg = list.find((r) => r.id === cerrarRegId)
        return reg ? <CerrarCajaDeOtraPcDialog register={reg} onClose={() => setCerrarRegId(null)} /> : null
      })()}

      {detailId && (
        <HistoricalCashReportDialog
          cashRegisterId={detailId}
          closedByName={list.find((r) => r.id === detailId)?.userName ?? '—'}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  )
}
