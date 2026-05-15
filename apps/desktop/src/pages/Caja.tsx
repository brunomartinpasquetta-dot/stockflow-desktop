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
import type { CashMovementDTO } from '@/types/api'

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
function CajaAbierta({ registerId }: { registerId: string }) {
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
        id: '', name: 'StockFlow', address: null, phone: null, email: null, cuit: null, ingBrutos: null, priceMode: 'gross' as const, createdAt: 0, updatedAt: 0,
      }
      const reportData = {
        company,
        report: result.report,
        closedBy: currentUser?.fullName ?? '—',
      }

      // Si hay impresora térmica configurada → imprimir vía ESC/POS y dejar el
      // fallback de "Imprimir desde pantalla" para el caso de fallar.
      const printerCfg = printerConfigQuery.data ?? null
      let printedViaHardware = false
      if (printerCfg) {
        const r = result.report
        const breakdownArr = r.byPaymentMethod ?? []
        try {
          await api.hardware.printer.printCashClose({
            company: { name: company.name },
            registerNumber: r.register.number,
            openDate: r.register.openDate,
            closeDate: r.register.closeDate ?? Date.now(),
            openingAmount: r.openingAmount,
            salesCount: r.salesCount,
            salesTotal: r.salesTotal,
            paymentBreakdown: breakdownArr.map((b) => ({ method: b.name, amount: b.net })),
            incomeMovements: r.incomeTotal,
            expenseMovements: r.expenseTotal,
            expectedClosing: r.expectedCash,
            declaredClosing: amt,
            difference: diff,
          })
          printedViaHardware = true
        } catch {
          toast.warning('Impresora no disponible — usá "Imprimir reporte" para imprimir desde pantalla')
        }
      }

      toast.success(
        `Caja cerrada — esperado ${formatCurrency(result.report.expectedCash)}, contado ${formatCurrency(amt)}, diferencia ${formatCurrency(diff)}`,
        printedViaHardware
          ? undefined
          : { action: { label: 'Imprimir reporte', onClick: () => printCashClose(reportData) } },
      )
      setCloseAmount('')
      setCloseNotes('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo cerrar la caja')
    }
  }

  const closeDiff = closeAmount ? (Number(parseCurrencyInput(closeAmount)) - Number(expected)).toFixed(4) : null
  const breakdown = r?.byPaymentMethod ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Caja</h1>
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
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
              ) : !r || r.movements.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                    Sin movimientos todavía
                  </TableCell>
                </TableRow>
              ) : (
                [...r.movements]
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
  if (current.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return current.data ? <CajaAbierta registerId={current.data.id} /> : <CajaCerrada />
}
