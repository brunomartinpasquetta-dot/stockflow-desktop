import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Plus, Wallet } from 'lucide-react'

import { api } from '@/lib/api'
import { useCashMutations, useCashReport, useCurrentCash, usePaymentMethods } from '@/lib/hooks'
import { useAuth, usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePrintCashClose } from '@/lib/usePrint'
import { formatCurrency, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { CurrencyInput } from '@/components/ui/currency-input'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CashReportDTO, CashMovementDTO } from '@/types/api'

/** Datos del cierre recién confirmado, para proponer el depósito a Caja General. */
type DepositInfo = { registerId: string; report: CashReportDTO; counted: string }

function movementKind(m: CashMovementDTO): string {
  if (m.relatedSaleId) return m.type === 'income' ? 'Venta' : 'Anulación'
  if (m.relatedPurchaseId) return 'Compra'
  if (m.description.toLowerCase().startsWith('cobranza')) return 'Cobro'
  return 'Movimiento'
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: 'income' | 'expense' | 'main' }) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <span
          className={cn(
            'text-2xl font-semibold tabular-nums',
            accent === 'income' && 'text-success',
            accent === 'expense' && 'text-destructive',
          )}
        >
          {value}
        </span>
      </CardContent>
    </Card>
  )
}

// ── Estado A: caja cerrada ────────────────────────────────────────────────
function CajaCerrada() {
  const { open } = useCashMutations()
  const canWrite = useCanWrite()
  const [amount, setAmount] = useState('0')
  // Deep-link `?action=open`: marca el input para auto-foco (ya está autoFocus).
  // Solo limpia el param.
  const [searchParamsClosed, setSearchParamsClosed] = useSearchParams()
  useEffect(() => {
    if (searchParamsClosed.get('action') === 'open') {
      const next = new URLSearchParams(searchParamsClosed)
      next.delete('action')
      setSearchParamsClosed(next, { replace: true })
    }
  }, [searchParamsClosed, setSearchParamsClosed])

  async function abrir(): Promise<void> {
    try {
      await open.mutateAsync(parseCurrencyInput(amount))
      toast.success('Caja abierta')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo abrir la caja')
    }
  }

  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader className="items-center gap-2 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Wallet className="h-7 w-7" />
          </div>
          <CardTitle className="text-lg">Caja cerrada</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Para registrar ventas hay que abrir la caja. Ingresá el monto inicial en efectivo del cajón.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="apertura">Monto inicial</Label>
            <CurrencyInput
              id="apertura"
              autoFocus
              value={amount}
              onChange={setAmount}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void abrir()
              }}
            />
          </div>
          <Button
            variant="success"
            className="w-full"
            onClick={() => void abrir()}
            disabled={open.isPending || !canWrite}
            title={canWrite ? undefined : 'Suscripción suspendida — sólo lectura'}
          >
            {open.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Abrir caja
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

// ── Estado B: caja abierta ────────────────────────────────────────────────
function CajaAbierta({ registerId, onCloseComplete }: { registerId: string; onCloseComplete: (info: DepositInfo, proposed: string) => void }) {
  const report = useCashReport(registerId)
  const { close, addMovement } = useCashMutations()
  const canWrite = useCanWrite()
  const canMove = usePermission('add_cash_movement') && canWrite
  const { currentUser } = useAuth()
  const companyQuery = useQuery({ queryKey: ['company'], queryFn: api.company.get })
  const paymentMethodsQuery = usePaymentMethods()
  const printCashClose = usePrintCashClose()
  const printerConfigQuery = useQuery({
    queryKey: ['hardwarePrinterConfig'],
    queryFn: () => api.hardware.printer.getConfig(),
    staleTime: 30_000,
  })

  const activeMethods = useMemo(() => (paymentMethodsQuery.data ?? []).filter((m) => m.active), [paymentMethodsQuery.data])
  const methodNameById = useMemo(
    () => new Map((paymentMethodsQuery.data ?? []).map((m) => [m.id, m.name])),
    [paymentMethodsQuery.data],
  )
  const efectivoMethod = useMemo(
    () => activeMethods.find((m) => m.isPhysicalCash) ?? activeMethods[0],
    [activeMethods],
  )
  const pmById = useMemo(
    () => new Map((paymentMethodsQuery.data ?? []).map((m) => [m.id, m])),
    [paymentMethodsQuery.data],
  )

  /**
   * Filtro por forma de pago sobre los movimientos del día. El comercio quiere
   * mirar la caja y ver SOLO lo que entró por transferencia (o el medio que
   * sea), con su total: la tabla se filtra y el pie suma lo filtrado.
   */
  const [filtroMedio, setFiltroMedio] = useState('')
  const [movOpen, setMovOpen] = useState(false)
  const [movType, setMovType] = useState<'income' | 'expense'>('income')
  const [movDesc, setMovDesc] = useState('')
  const [movAmount, setMovAmount] = useState('0')
  const [movPaymentMethodId, setMovPaymentMethodId] = useState('')
  const movPm = movPaymentMethodId || efectivoMethod?.id || ''

  const [closeOpen, setCloseOpen] = useState(false)
  const [closeAmount, setCloseAmount] = useState('')
  const [closeNotes, setCloseNotes] = useState('')

  // Deep-link `?action=close`: abrir el dialog de cierre al cargar.
  const [searchParamsOpen, setSearchParamsOpen] = useSearchParams()
  useEffect(() => {
    if (searchParamsOpen.get('action') === 'close') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCloseOpen(true)
      const next = new URLSearchParams(searchParamsOpen)
      next.delete('action')
      setSearchParamsOpen(next, { replace: true })
    }
  }, [searchParamsOpen, setSearchParamsOpen])

  const r = report.data
  const movimientosFiltrados = useMemo(() => {
    const todos = r?.movements ?? []
    if (!filtroMedio) return todos
    // '__efectivo__' agrupa el medio Efectivo con los movimientos viejos sin
    // medio asignado, que en la práctica eran efectivo.
    return todos.filter((m) =>
      filtroMedio === '__efectivo__'
        ? m.paymentMethodId == null || pmById.get(m.paymentMethodId)?.isPhysicalCash === true
        : m.paymentMethodId === filtroMedio,
    )
  }, [r, filtroMedio, pmById])
  const totalFiltrado = useMemo(() => {
    if (!filtroMedio) return null
    return movimientosFiltrados.reduce(
      (acc, m) => (m.relatedSaleStatus === 'voided' && m.type === 'income' ? acc : acc + (m.type === 'income' ? Number(m.amount) : -Number(m.amount))),
      0,
    )
  }, [movimientosFiltrados, filtroMedio])
  const expected = r?.expectedCash ?? '0'

  function openMovDialog(): void {
    setMovDesc('')
    setMovAmount('0')
    setMovType('income')
    setMovPaymentMethodId('')
    setMovOpen(true)
  }

  async function guardarMovimiento(): Promise<void> {
    if (movDesc.trim().length < 3) {
      toast.error('La descripción debe tener al menos 3 caracteres')
      return
    }
    const amt = parseCurrencyInput(movAmount)
    if (Number(amt) <= 0) {
      toast.error('El monto debe ser mayor a cero')
      return
    }
    // Un egreso mayor al efectivo del cajón deja la caja en rojo. No se
    // bloquea (puede estar registrando algo que ya pasó), pero se avisa: si
    // no, el descuadre aparece recién al cerrar y nadie sabe de dónde salió.
    const esEfectivo = !movPm || pmById.get(movPm)?.isPhysicalCash === true
    if (movType === 'expense' && esEfectivo && Number(amt) > Number(expected) + 0.005) {
      const quedaria = (Number(expected) - Number(amt)).toFixed(2)
      const ok = window.confirm(
        `En el cajón hay ${formatCurrency(expected)} y estás sacando ${formatCurrency(amt)}.\n\n` +
        `La caja quedaría en ${formatCurrency(quedaria)}.\n\n¿Registrar igual?`,
      )
      if (!ok) return
    }
    try {
      await addMovement.mutateAsync({
        type: movType,
        description: movDesc.trim(),
        amount: amt,
        paymentMethodId: movPm || null,
      })
      toast.success('Movimiento registrado')
      setMovOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo registrar el movimiento')
    }
  }

  async function confirmarCierre(): Promise<void> {
    const amt = parseCurrencyInput(closeAmount)
    try {
      const result = await close.mutateAsync({
        registerId,
        closingAmount: amt,
        notes: closeNotes.trim() || undefined,
      })
      setCloseOpen(false)
      const diff = result.report.difference ?? '0'
      const company = companyQuery.data ?? {
        id: '', name: 'StockFlow', address: null, phone: null, email: null, cuit: null, ingBrutos: null, priceMode: 'gross' as const, allowNegativeStock: true, createdAt: 0, updatedAt: 0,
      }
      const reportData = {
        company,
        report: result.report,
        closedBy: currentUser?.fullName ?? '—',
      }

      // Impresión vía window.print() + driver del SO (patrón canónico).
      // Si hay impresora configurada, imprimimos automáticamente; si no, el
      // toast ofrece el botón "Imprimir reporte" como fallback.
      const printerCfg = printerConfigQuery.data ?? null
      let printed = false
      if (printerCfg) {
        try {
          await printCashClose(reportData)
          printed = true
        } catch {
          toast.warning('No se pudo imprimir el reporte — usá "Imprimir reporte" para reintentar')
        }
      }

      toast.success(
        `Caja cerrada — esperado ${formatCurrency(result.report.expectedCash)}, contado ${formatCurrency(amt)}, diferencia ${formatCurrency(diff)}`,
        printed
          ? undefined
          : { action: { label: 'Imprimir reporte', onClick: () => void printCashClose(reportData) } },
      )
      setCloseAmount('')
      setCloseNotes('')

      // Paso 2 del cierre: proponer el depósito a Caja General con el TOTAL del
      // día (efectivo contado + neto de los demás medios: transferencias, tarjetas).
      const nonCashNet = result.report.byPaymentMethod
        .filter((b) => !b.isPhysicalCash)
        .reduce((acc, b) => acc + Number(b.net ?? 0), 0)
      const proposed = (Number(amt) + Math.max(0, nonCashNet)).toFixed(2)
      // El dialog vive en el padre <Caja/>: al cerrarse la caja este componente
      // se desmonta (la query pasa a null) y un estado local no sobreviviría.
      onCloseComplete({ registerId, report: result.report, counted: amt }, proposed)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cerrar la caja')
    }
  }

  const closeDiff = closeAmount ? (Number(parseCurrencyInput(closeAmount)) - Number(expected)).toFixed(4) : null
  const breakdown = r?.byPaymentMethod ?? []
  // Comisión total descontada de los medios de pago (FEATURE #1). Si el backend
  // todavía no envía el campo, se infiere sumando las comisiones por medio.
  const commissionTotal =
    r?.commissionTotal ?? breakdown.reduce((acc, b) => acc + Number(b.commissionTotal ?? '0'), 0).toFixed(4)
  const hasCommission = Number(commissionTotal) > 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Caja diaria</h1>
          <p className="text-sm text-muted-foreground">
            {r ? `Caja #${r.register.number} abierta desde ${formatDateTime(r.register.openDate)}` : 'Cargando…'}
          </p>
        </div>
        <Button
          variant="destructive"
          onClick={() => setCloseOpen(true)}
          disabled={!canWrite}
          title={canWrite ? undefined : 'Suscripción suspendida — sólo lectura'}
        >
          Cerrar caja
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <SummaryCard label="Efectivo esperado en el cajón" value={formatCurrency(expected)} accent="main" />
        <SummaryCard label="Ingresos del día (todos los medios)" value={formatCurrency(r?.incomeTotal ?? '0')} accent="income" />
        <SummaryCard label="Egresos del día" value={formatCurrency(r?.expenseTotal ?? '0')} accent="expense" />
      </div>

      {breakdown.length > 0 && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Desglose por medio de pago</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Medio</TableHead>
                  <TableHead className="text-right">Ingresos</TableHead>
                  <TableHead className="text-right">Egresos</TableHead>
                  {hasCommission && <TableHead className="text-right">Comisión</TableHead>}
                  <TableHead className="text-right">Neto</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {breakdown.map((b) => (
                  <TableRow key={b.paymentMethodId ?? '__none__'}>
                    <TableCell>
                      {b.name}
                      {b.isPhysicalCash && <Badge variant="outline" className="ml-2">efectivo físico</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-success">{formatCurrency(b.incomeTotal)}</TableCell>
                    <TableCell className="text-right tabular-nums text-destructive">{formatCurrency(b.expenseTotal)}</TableCell>
                    {hasCommission && (
                      <TableCell className="text-right tabular-nums text-amber-600 dark:text-amber-400">
                        {Number(b.commissionTotal ?? '0') > 0 ? `− ${formatCurrency(b.commissionTotal ?? '0')}` : '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasCommission && (
              <div className="flex items-center justify-between border-t px-4 py-2 text-sm">
                <span className="text-muted-foreground">
                  Comisión total descontada de los medios de pago
                </span>
                <div className="flex items-center gap-6">
                  <span className="tabular-nums text-amber-600 dark:text-amber-400">
                    − {formatCurrency(commissionTotal)}
                  </span>
                  <span className="font-medium">
                    Neto:{' '}
                    <span className="tabular-nums">
                      {formatCurrency((Number(r?.salesTotal ?? '0') - Number(commissionTotal)).toFixed(4))}
                    </span>
                  </span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>
            Movimientos del día
            {r && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                · {r.salesCount} venta(s) por {formatCurrency(r.salesTotal)} · apertura {formatCurrency(r.openingAmount)}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {/* Filtrar la caja por forma de pago, con el total de lo filtrado
                al lado: "cuánto entró hoy por transferencia" sin salir de acá. */}
            <Select
              className="h-8 w-44 text-xs"
              value={filtroMedio}
              onChange={(e) => setFiltroMedio(e.target.value)}
            >
              <option value="">Todas las formas de pago</option>
              <option value="__efectivo__">Efectivo</option>
              {activeMethods.filter((m) => !m.isPhysicalCash).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
            {totalFiltrado != null && (
              <span className="whitespace-nowrap text-xs tabular-nums">
                Neto: <span className="font-semibold">{formatCurrency(String(totalFiltrado))}</span>
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canMove}
              title={canMove ? undefined : 'Requiere permiso de encargado o administrador'}
              onClick={openMovDialog}
            >
              <Plus className="h-4 w-4" />
              Nuevo movimiento
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Hora</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Medio</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right">Ingreso</TableHead>
                <TableHead className="text-right">Egreso</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.isLoading ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    Cargando…
                  </TableCell>
                </TableRow>
              ) : !r || movimientosFiltrados.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    Sin movimientos todavía
                  </TableCell>
                </TableRow>
              ) : (
                [...movimientosFiltrados]
                  .sort((a, b) => b.date - a.date)
                  .map((m) => {
                    const anulada = m.relatedSaleStatus === 'voided' && m.type === 'income'
                    return (
                      <TableRow key={m.id} className={cn(anulada && 'line-through opacity-60')}>
                        <TableCell className="text-xs text-muted-foreground">{formatDateTime(m.date)}</TableCell>
                        <TableCell>
                          <span className="flex items-center gap-1.5">
                            <Badge variant="outline">{movementKind(m)}</Badge>
                            {anulada && <Badge variant="destructive">ANULADA</Badge>}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {m.paymentMethodId ? methodNameById.get(m.paymentMethodId) ?? '—' : '—'}
                        </TableCell>
                        <TableCell>{m.description}</TableCell>
                        <TableCell className="text-right tabular-nums text-success">
                          {m.type === 'income' ? formatCurrency(m.amount) : ''}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-destructive">
                          {m.type === 'expense' ? formatCurrency(m.amount) : ''}
                        </TableCell>
                      </TableRow>
                    )
                  })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dialog: nuevo movimiento */}
      <Dialog open={movOpen} onOpenChange={(o) => { if (!o) setMovOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nuevo movimiento de caja</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex gap-4">
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="movtype" checked={movType === 'income'} onChange={() => setMovType('income')} />
                Ingreso
              </label>
              <label className="flex items-center gap-1.5 text-sm">
                <input type="radio" name="movtype" checked={movType === 'expense'} onChange={() => setMovType('expense')} />
                Egreso
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mov-method">Medio de pago</Label>
              <Select id="mov-method" value={movPm} onChange={(e) => setMovPaymentMethodId(e.target.value)}>
                {activeMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-muted-foreground">Sólo los de efectivo físico afectan el saldo del cajón.</span>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mov-desc">Descripción</Label>
              <Input id="mov-desc" value={movDesc} onChange={(e) => setMovDesc(e.target.value)} placeholder="Ej: pago de flete" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="mov-amount">Monto</Label>
              <CurrencyInput
                id="mov-amount"
                value={movAmount}
                onChange={setMovAmount}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMovOpen(false)} disabled={addMovement.isPending}>
              Cancelar
            </Button>
            <Button onClick={() => void guardarMovimiento()} disabled={addMovement.isPending || !canWrite}>
              {addMovement.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: cerrar caja */}
      <Dialog open={closeOpen} onOpenChange={(o) => { if (!o) setCloseOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cerrar caja</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="rounded-md bg-muted px-3 py-2 text-sm">
              Efectivo esperado en el cajón: <span className="font-semibold tabular-nums">{formatCurrency(expected)}</span>
            </div>
            {breakdown.length > 0 && (
              <div className="rounded-md border px-3 py-2 text-xs">
                <div className="mb-1 font-medium text-muted-foreground">Recaudación por medio (informativo)</div>
                {breakdown.map((b) => (
                  <div key={b.paymentMethodId ?? '__none__'} className="flex justify-between">
                    <span>{b.name}</span>
                    <span className="tabular-nums">{formatCurrency(b.net)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="close-amount">Efectivo real contado</Label>
              <CurrencyInput
                id="close-amount"
                autoFocus
                value={closeAmount}
                onChange={setCloseAmount}
              />
              <span className="text-xs text-muted-foreground">Sólo se compara contra el efectivo; los demás medios se concilian aparte.</span>
            </div>
            {closeDiff != null && Number(closeDiff) !== 0 && (
              <Badge variant={Number(closeDiff) < 0 ? 'destructive' : 'warning'}>
                {Number(closeDiff) < 0 ? 'Faltante' : 'Sobrante'} de {formatCurrency(Math.abs(Number(closeDiff)))}
              </Badge>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="close-notes">Observaciones (opcional)</Label>
              <textarea
                id="close-notes"
                rows={2}
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
                className="flex w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseOpen(false)} disabled={close.isPending}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={() => void confirmarCierre()} disabled={close.isPending || !closeAmount || !canWrite}>
              {close.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Confirmar cierre
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function Caja() {
  const current = useCurrentCash()
  const canWrite = useCanWrite()

  // PASO 2 del cierre — el dialog vive acá porque CajaAbierta se desmonta
  // apenas la caja queda cerrada (la query pasa a null).
  const [depositInfo, setDepositInfo] = useState<DepositInfo | null>(null)
  const [depositCash, setDepositCash] = useState('0')
  // Neto de los medios no físicos del cierre: entra siempre completo.
  const depositElectronico = useMemo(() => {
    if (!depositInfo) return '0'
    return depositInfo.report.byPaymentMethod
      .filter((b) => !b.isPhysicalCash)
      .reduce((acc, b) => acc + Math.max(0, Number(b.net ?? 0)), 0)
      .toFixed(2)
  }, [depositInfo])

  async function confirmarDeposito(): Promise<void> {
    if (!depositInfo) return
    // Ya no hay que prorratear nada: el electrónico entra completo y el
    // efectivo es lo que el usuario decidió llevar a la caja fuerte.
    const cashAmount = parseCurrencyInput(depositCash)
    const electronicAmount = depositElectronico
    const amt = (Number(cashAmount) + Number(electronicAmount)).toFixed(2)
    if (Number(cashAmount) < 0) {
      toast.error('El efectivo no puede ser negativo')
      return
    }
    if (Number(cashAmount) > Number(depositInfo.counted) + 0.005) {
      toast.error(`No podés ingresar más efectivo del que contaste (${formatCurrency(depositInfo.counted)})`)
      return
    }
    if (Number(amt) <= 0) {
      toast.error('El monto debe ser mayor a cero')
      return
    }
    try {
      await api.cashGeneral.transferFromClosed({
        cashRegisterId: depositInfo.registerId,
        amount: amt,
        cashAmount,
        electronicAmount,
      })
      toast.success(`Ingresado ${formatCurrency(amt)} a Caja General (efectivo ${formatCurrency(cashAmount)} · electrónico ${formatCurrency(electronicAmount)})`)
      setDepositInfo(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo ingresar a Caja General')
    }
  }

  if (current.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return (
    <>
      {current.data ? (
        <CajaAbierta
          registerId={current.data.id}
          onCloseComplete={(info) => {
            setDepositCash(info.counted)
            setDepositInfo(info)
          }}
        />
      ) : (
        <CajaCerrada />
      )}

      {/* PASO 2 del cierre — ingreso a Caja General.
          El importe electrónico NO es editable a propósito: esa plata ya está
          en la cuenta del comercio, no puede "quedarse en el cajón". Lo único
          ajustable es el efectivo (por si deja cambio para el día siguiente).
          Antes había un solo campo con la suma de ambos, y al cerrar se
          escribía el efectivo contado —el número que uno tiene delante— y la
          parte electrónica quedaba afuera sin que nadie lo notara. */}
      <Dialog open={depositInfo !== null} onOpenChange={(o) => { if (!o) setDepositInfo(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ingresar a Caja General</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              La caja quedó cerrada. Esto es lo que recaudó el día y pasa a Caja General.
            </p>
            {depositInfo && (
              <>
                <div className="flex flex-col gap-1 rounded-md border bg-muted/40 px-3 py-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">Cobrado con tarjeta y transferencia</span>
                    <b className="tabular-nums">{formatCurrency(depositElectronico)}</b>
                  </div>
                  {depositInfo.report.byPaymentMethod
                    .filter((b) => !b.isPhysicalCash && Number(b.net ?? 0) !== 0)
                    .map((b) => (
                      <div key={b.name} className="flex justify-between text-xs text-muted-foreground">
                        <span>{b.name}</span><span className="tabular-nums">{formatCurrency(b.net ?? '0')}</span>
                      </div>
                    ))}
                  <span className="mt-0.5 text-[11px] text-muted-foreground">
                    Ya está en tu cuenta: entra completo, no se puede modificar.
                  </span>
                </div>

                <div className="flex flex-col gap-1">
                  <Label htmlFor="deposit-cash">Efectivo que llevás a la caja fuerte</Label>
                  <CurrencyInput id="deposit-cash" value={depositCash} onChange={setDepositCash} />
                  <span className="text-xs text-muted-foreground">
                    Contaste {formatCurrency(depositInfo.counted)} en el cajón.
                    {Number(parseCurrencyInput(depositCash)) < Number(depositInfo.counted) - 0.005 && (
                      <> Quedan <b>{formatCurrency((Number(depositInfo.counted) - Number(parseCurrencyInput(depositCash))).toFixed(2))}</b> como cambio para mañana.</>
                    )}
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-md bg-primary/10 px-3 py-2">
                  <span className="text-sm font-medium">Total que ingresa</span>
                  <b className="text-lg tabular-nums">
                    {formatCurrency((Number(parseCurrencyInput(depositCash)) + Number(depositElectronico)).toFixed(2))}
                  </b>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDepositInfo(null)}>No ingresar</Button>
            <Button onClick={() => void confirmarDeposito()} disabled={!canWrite}>Confirmar ingreso</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
