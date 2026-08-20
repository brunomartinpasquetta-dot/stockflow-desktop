/**
 * CAJA GENERAL — pantalla propia (antes vivía dentro de Historial de Cajas).
 *
 * Saldo consolidado del negocio: recibe los depósitos de cierre de las cajas
 * diarias y los ingresos/egresos manuales. Gateada por el permiso
 * `view_cash_general` (área Caja) — así se puede bloquear sin tocar los
 * historiales de ventas/cajas (pedido de Bruno, 2026-07).
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, PlusCircle, MinusCircle, Wallet, Scale } from 'lucide-react'

import {
  useCashGeneralBalanceBreakdown,
  useCashGeneralMovements,
  useCashGeneralMutations,
} from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency, formatDateTime, parseCurrencyInput } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CurrencyInput } from '@/components/ui/currency-input'
import type { CashGeneralCategoryDTO, CashGeneralMovementDTO } from '@/types/api'
import { SinPermiso } from '@/components/SinPermiso'
import { HistorialCajas } from './HistorialCajas'

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

export function CajaGeneral() {
  const canView = usePermission('view_cash_general')
  if (!canView) return <SinPermiso area="Caja General" />
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      {/* El historial de cajas diarias va PRIMERO: es lo que el comercio abre
          esta pantalla a mirar. Los movimientos de Caja General, abajo. */}
      <HistorialCajas />
      <CajaGeneralInner />
    </div>
  )
}

const CASH_GENERAL_CATEGORIES: { value: CashGeneralCategoryDTO; label: string }[] = [
  { value: 'deposit', label: 'Depósito' },
  { value: 'withdrawal', label: 'Retiro' },
  { value: 'service', label: 'Servicios' },
  { value: 'salary', label: 'Sueldos' },
  { value: 'other', label: 'Otros' },
]

function cashGeneralCategoryLabel(c: CashGeneralCategoryDTO | null): string {
  if (!c) return '—'
  // 'close_deposit' no está en CASH_GENERAL_CATEGORIES porque no es elegible
  // a mano: la genera el flujo automático de cierre de caja.
  if (c === 'close_deposit') return 'Cierre de caja'
  return CASH_GENERAL_CATEGORIES.find((x) => x.value === c)?.label ?? c
}

function cashGeneralTypeLabel(t: CashGeneralMovementDTO['type']): string {
  if (t === 'income') return 'Ingreso'
  if (t === 'expense') return 'Egreso'
  return 'Desde caja diaria'
}

function CashGeneralMovementDialog({
  mode,
  onClose,
}: {
  mode: 'income' | 'expense'
  onClose: () => void
}) {
  const [amount, setAmount] = useState('0.00')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<CashGeneralCategoryDTO | ''>('')
  const [medio, setMedio] = useState<'cash' | 'electronic'>('cash')
  const m = useCashGeneralMutations()
  const saldoQ = useCashGeneralBalanceBreakdown()
  const saldo = saldoQ.data ?? { total: '0', cash: '0', electronic: '0' }
  const submitting = m.addIncome.isPending || m.addExpense.isPending

  async function submit(): Promise<void> {
    if (Number(amount) <= 0) {
      toast.error('El monto debe ser mayor a cero')
      return
    }
    if (!description.trim()) {
      toast.error('El concepto es obligatorio')
      return
    }
    // Un egreso mayor al saldo deja Caja General en rojo. No se bloquea (puede
    // estar cargando algo atrasado), pero se avisa antes de confirmarlo.
    if (mode === 'expense') {
      const disponible = medio === 'cash' ? Number(saldo.cash) : Number(saldo.electronic)
      if (Number(amount) > disponible + 0.005) {
        const nombre = medio === 'cash' ? 'efectivo' : 'electrónico'
        const ok = window.confirm(
          `En Caja General hay ${formatCurrency(disponible)} en ${nombre} y estás sacando ${formatCurrency(amount)}.\n\n` +
          `El saldo ${nombre} quedaría en ${formatCurrency((disponible - Number(amount)).toFixed(2))}.\n\n¿Registrar igual?`,
        )
        if (!ok) return
      }
    }
    const payload = {
      amount,
      description: description.trim(),
      category: (category || undefined) as CashGeneralCategoryDTO | undefined,
      isCash: medio === 'cash',
    }
    try {
      if (mode === 'income') await m.addIncome.mutateAsync(payload)
      else await m.addExpense.mutateAsync(payload)
      toast.success(mode === 'income' ? 'Ingreso registrado' : 'Egreso registrado')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error al registrar movimiento')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === 'income' ? 'Registrar Ingreso (Caja General)' : 'Registrar Egreso (Caja General)'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label>Monto</Label>
            <CurrencyInput value={amount} onChange={setAmount} autoFocus />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Concepto</Label>
            <textarea
              className="min-h-[72px] rounded-md border bg-background p-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descripción del movimiento"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label>Categoría</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as CashGeneralCategoryDTO | '')}>
              <option value="">(Sin categoría)</option>
              {CASH_GENERAL_CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Medio</Label>
            <Select value={medio} onChange={(e) => setMedio(e.target.value as 'cash' | 'electronic')}>
              <option value="cash">Efectivo</option>
              <option value="electronic">Electrónico (transferencia / tarjeta)</option>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Registrar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Ajuste del reparto efectivo/electrónico. El comercio declara cuánto tiene
 * realmente en la caja fuerte; el resto queda como electrónico. NO cambia el
 * saldo total ni toca ningún movimiento — sólo corrige cómo está repartido,
 * que es lo único que el sistema no puede deducir solo (historial viejo sin
 * discriminar, o pagos hechos por un medio distinto al registrado).
 */
function AjustarDesgloseDialog({
  total,
  cash,
  onClose,
}: {
  total: string
  cash: string
  onClose: () => void
}) {
  const [efectivo, setEfectivo] = useState(cash)
  const m = useCashGeneralMutations()
  const monto = parseCurrencyInput(efectivo)
  const resto = Number(total) - Number(monto)
  const excede = resto < -0.005

  async function submit(): Promise<void> {
    if (Number(monto) < 0) {
      toast.error('El efectivo no puede ser negativo')
      return
    }
    if (excede) {
      toast.error('El efectivo no puede superar el saldo total')
      return
    }
    try {
      await m.adjustBreakdown.mutateAsync(monto)
      toast.success('Desglose actualizado — el saldo total no cambió')
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'No se pudo ajustar el desglose')
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Ajustar efectivo / electrónico</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Indicá cuánto tenés realmente en <b>efectivo</b> en la caja fuerte. El resto se toma
            como electrónico. El saldo total y los movimientos no se modifican.
          </p>
          <div className="flex flex-col gap-1">
            <Label htmlFor="ajuste-efectivo">Efectivo real</Label>
            <CurrencyInput id="ajuste-efectivo" value={efectivo} onChange={setEfectivo} autoFocus />
          </div>
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            <div className="flex justify-between">
              <span>Saldo total (no cambia)</span>
              <b className="tabular-nums">{formatCurrency(total)}</b>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Quedará como electrónico</span>
              <span className={cn('tabular-nums', excede && 'text-destructive font-medium')}>
                {excede ? 'supera el total' : formatCurrency(resto.toFixed(2))}
              </span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={m.adjustBreakdown.isPending}>Cancelar</Button>
          <Button onClick={() => void submit()} disabled={m.adjustBreakdown.isPending || excede}>
            {m.adjustBreakdown.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Guardar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CajaGeneralInner() {
  const canManage = usePermission('manage_cash_general')
  const balanceQ = useCashGeneralBalanceBreakdown()
  const [openDialog, setOpenDialog] = useState<'income' | 'expense' | null>(null)
  const [ajusteOpen, setAjusteOpen] = useState(false)

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        {/* Título, botones y saldos en UNA sola fila: cada fila de encabezado
            que se ahorra es un renglón más de la grilla a la vista (pedido de
            Bruno, 20-ago-2026). */}
        <div className="flex flex-wrap items-center gap-2">
          <Wallet className="h-5 w-5 shrink-0 text-primary" />
          <h2 className="whitespace-nowrap text-base font-semibold">Caja General</h2>
          {canManage && (
            <div className="ml-2 flex flex-wrap gap-1.5">
              <Button size="sm" onClick={() => setOpenDialog('income')} className="bg-success text-success-foreground hover:bg-success/90">
                <PlusCircle className="h-4 w-4" />
                Ingreso
              </Button>
              <Button size="sm" variant="destructive" onClick={() => setOpenDialog('expense')}>
                <MinusCircle className="h-4 w-4" />
                Egreso
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAjusteOpen(true)}>
                <Scale className="h-4 w-4" />
                Ajustar efe/elec
              </Button>
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
            <span className="text-muted-foreground">
              Efectivo <b className="text-foreground">{balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.cash ?? '0')}</b>
            </span>
            <span className="text-muted-foreground">
              Electrónico <b className="text-foreground">{balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.electronic ?? '0')}</b>
            </span>
            <span className="text-muted-foreground">
              Saldo total <b className="text-base font-bold text-foreground">{balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.total ?? '0')}</b>
            </span>
          </div>
        </div>

        {ajusteOpen && (
          <AjustarDesgloseDialog
            total={balanceQ.data?.total ?? '0'}
            cash={balanceQ.data?.cash ?? '0'}
            onClose={() => setAjusteOpen(false)}
          />
        )}

        <div>
          <div className="flex items-center justify-between border-b pb-1 mb-1">
            <h3 className="text-sm font-medium">Movimientos</h3>
          </div>
          <CajaGeneralFullList />
        </div>

        {openDialog && (
          <CashGeneralMovementDialog mode={openDialog} onClose={() => setOpenDialog(null)} />
        )}
      </CardContent>
    </Card>
  )
}

function CajaGeneralFullList() {
  const [fromIso, setFromIso] = useState(() => isoDaysAgo(30))
  const [toIso, setToIso] = useState(() => todayIso())
  const [type, setType] = useState<'' | 'income' | 'expense' | 'transfer_from_daily'>('')
  /**
   * Filtro por medio. Caja General registra sus movimientos como EFECTIVO o
   * ELECTRÓNICO (los depósitos de cierre entran en bloque, sin abrir por
   * tarjeta/transferencia — ese detalle vive en la caja diaria y en el
   * Historial de Ventas). Acá el filtro honesto es ese.
   */
  const [medioFiltro, setMedioFiltro] = useState<'' | 'cash' | 'electronic'>('')
  const movementsQ = useCashGeneralMovements({
    from: dayStart(fromIso),
    to: dayEnd(toIso),
    type: (type || undefined) as 'income' | 'expense' | 'transfer_from_daily' | undefined,
  })

  // Saldo con el que ARRANCA el período: es el que dejó el último movimiento
  // anterior al rango. Sin esto no se puede saber cuánto aportó el período a
  // cada columna.
  const previoQ = useCashGeneralMovements({ to: dayStart(fromIso) - 1, limit: 1 })

  // Totales del rango filtrado. El desglose efectivo/electrónico NO se puede
  // sacar del flag `isCash`: en un depósito de cierre ese flag es sólo una
  // etiqueta de fila (dice cuál parte pesó más) y el movimiento en realidad
  // aporta a las DOS columnas. El reparto real sale de cómo se movieron los
  // saldos entre un movimiento y el siguiente.
  const totales = useMemo(() => {
    const movs = movementsQ.data ?? []
    const t = { ingresos: 0, egresos: 0 }
    for (const m of movs) {
      if (m.type === 'expense') t.egresos += Number(m.amount)
      else t.ingresos += Number(m.amount)
    }
    const ultimo = movs[0]            // la lista viene del más nuevo al más viejo
    const anterior = (previoQ.data ?? [])[0]
    const baseEfe = anterior ? Number(anterior.balanceAfterCash) : 0
    const baseEle = anterior ? Number(anterior.balanceAfterElectronic) : 0
    const finEfe = ultimo ? Number(ultimo.balanceAfterCash) : baseEfe
    const finEle = ultimo ? Number(ultimo.balanceAfterElectronic) : baseEle
    return {
      ...t,
      neto: t.ingresos - t.egresos,
      variacionEfe: finEfe - baseEfe,
      variacionEle: finEle - baseEle,
      saldoFinal: ultimo ? Number(ultimo.balanceAfter) : null,
      saldoFinalEfe: ultimo ? finEfe : null,
      saldoFinalEle: ultimo ? finEle : null,
    }
  }, [movementsQ.data, previoQ.data])

  const movsFiltrados = useMemo(() => {
    const movs = movementsQ.data ?? []
    if (!medioFiltro) return movs
    return movs.filter((m) => (medioFiltro === 'cash' ? m.isCash : !m.isCash))
  }, [movementsQ.data, medioFiltro])
  const netoFiltrado = useMemo(
    () =>
      medioFiltro
        ? movsFiltrados.reduce((a, m) => a + (m.type === 'expense' ? -Number(m.amount) : Number(m.amount)), 0)
        : null,
    [movsFiltrados, medioFiltro],
  )

  async function exportarExcel(): Promise<void> {
    const rows = movsFiltrados
    if (rows.length === 0) {
      toast.info('No hay movimientos para exportar')
      return
    }
    try {
      const XLSX = await import('xlsx')
      const data = rows.map((m) => ({
        Fecha: formatDateTime(m.createdAt),
        Tipo: cashGeneralTypeLabel(m.type),
        Concepto: m.description,
        Categoría: cashGeneralCategoryLabel(m.category),
        Medio: m.isCash ? 'Efectivo' : 'Electrónico',
        Monto: Number(m.amount),
        'Saldo efectivo': Number(m.balanceAfterCash),
        'Saldo electrónico': Number(m.balanceAfterElectronic),
        'Saldo total': Number(m.balanceAfter),
      }))
      data.push({} as (typeof data)[number])
      data.push({
        Fecha: 'TOTALES DEL PERÍODO', Tipo: '', Concepto: '', Categoría: '', Medio: '',
        Monto: 0, 'Saldo efectivo': 0, 'Saldo electrónico': 0, 'Saldo total': 0,
      } as (typeof data)[number])
      data.push({
        Fecha: 'Ingresos', Tipo: '', Concepto: '', Categoría: '', Medio: '',
        Monto: totales.ingresos, 'Saldo efectivo': 0, 'Saldo electrónico': 0, 'Saldo total': 0,
      } as (typeof data)[number])
      data.push({
        Fecha: 'Egresos', Tipo: '', Concepto: '', Categoría: '', Medio: '',
        Monto: totales.egresos, 'Saldo efectivo': 0, 'Saldo electrónico': 0, 'Saldo total': 0,
      } as (typeof data)[number])
      data.push({
        Fecha: 'Resultado del período', Tipo: '', Concepto: '', Categoría: '', Medio: '',
        Monto: totales.neto,
        'Saldo efectivo': totales.variacionEfe,
        'Saldo electrónico': totales.variacionEle,
        'Saldo total': totales.neto,
      } as (typeof data)[number])
      data.push({
        Fecha: 'Saldo al cierre del período', Tipo: '', Concepto: '', Categoría: '', Medio: '',
        Monto: totales.saldoFinal ?? 0,
        'Saldo efectivo': totales.saldoFinalEfe ?? 0,
        'Saldo electrónico': totales.saldoFinalEle ?? 0,
        'Saldo total': totales.saldoFinal ?? 0,
      } as (typeof data)[number])
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Caja General')
      XLSX.writeFile(wb, `caja-general-${fromIso}-${toIso}.xlsx`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error exportando')
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Desde</Label>
          <Input type="date" value={fromIso} onChange={(e) => setFromIso(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Hasta</Label>
          <Input type="date" value={toIso} onChange={(e) => setToIso(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Tipo</Label>
          <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="">Todos</option>
            <option value="income">Ingresos</option>
            <option value="expense">Egresos</option>
            <option value="transfer_from_daily">Desde caja diaria</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Medio</Label>
          <Select value={medioFiltro} onChange={(e) => setMedioFiltro(e.target.value as typeof medioFiltro)}>
            <option value="">Todos</option>
            <option value="cash">Efectivo</option>
            <option value="electronic">Electrónico</option>
          </Select>
        </div>
        {netoFiltrado != null && (
          <span className="self-end pb-2 text-xs tabular-nums">
            Neto {medioFiltro === 'cash' ? 'efectivo' : 'electrónico'}:{' '}
            <span className="font-semibold">{formatCurrency(String(netoFiltrado))}</span>
          </span>
        )}
        <Button variant="outline" onClick={() => void exportarExcel()}>Exportar Excel</Button>
      </div>
      <div className="max-h-[32rem] overflow-auto rounded-md border bg-background">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead>Concepto</TableHead>
              <TableHead>Categoría</TableHead>
              <TableHead>Medio</TableHead>
              <TableHead className="text-right">Monto</TableHead>
              <TableHead className="text-right">Saldo total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {movsFiltrados.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-4 text-center text-muted-foreground">Sin movimientos en el rango</TableCell></TableRow>
            ) : movsFiltrados.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatDateTime(m.createdAt)}</TableCell>
                <TableCell className="text-xs">{cashGeneralTypeLabel(m.type)}</TableCell>
                <TableCell className="text-xs">{m.description}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{cashGeneralCategoryLabel(m.category)}</TableCell>
                <TableCell className="text-xs">
                  <span className={cn(
                    'rounded px-1.5 py-0.5 text-[11px]',
                    m.isCash ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
                  )}>
                    {m.isCash ? 'Efectivo' : 'Electrónico'}
                  </span>
                </TableCell>
                <TableCell className={cn(
                  'text-right tabular-nums',
                  m.type === 'expense' ? 'text-destructive' : 'text-success',
                )}>
                  {m.type === 'expense' ? '-' : '+'}{formatCurrency(m.amount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(m.balanceAfter)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Resumen del rango en UNA fila compacta: la protagonista de la pantalla
          es la grilla, y las tarjetas grandes le comían el alto (pedido de
          Bruno, 20-ago-2026). Misma información, tamaño de renglón. */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-md border bg-muted/30 px-3 py-1.5 text-xs tabular-nums">
        <span className="text-muted-foreground">
          Ingresos <b className="text-success">{formatCurrency(totales.ingresos)}</b>
        </span>
        <span className="text-muted-foreground">
          Egresos <b className="text-destructive">{formatCurrency(totales.egresos)}</b>
        </span>
        <span className="text-muted-foreground">
          Resultado{' '}
          <b className={cn('text-foreground', totales.neto < 0 && 'text-destructive')}>
            {totales.neto >= 0 ? '+' : ''}{formatCurrency(totales.neto)}
          </b>{' '}
          (efe {totales.variacionEfe >= 0 ? '+' : ''}{formatCurrency(totales.variacionEfe)} · elec {totales.variacionEle >= 0 ? '+' : ''}{formatCurrency(totales.variacionEle)})
        </span>
        {totales.saldoFinal != null && (
          <span className="ml-auto text-muted-foreground" title="Acumulado de toda la historia al último movimiento del período, no el resultado del período">
            Saldo: efe <b className="text-foreground">{formatCurrency(totales.saldoFinalEfe ?? 0)}</b>
            {' · '}elec <b className="text-foreground">{formatCurrency(totales.saldoFinalEle ?? 0)}</b>
            {' = '}<b className="text-sm text-foreground">{formatCurrency(totales.saldoFinal)}</b>
          </span>
        )}
      </div>
    </div>
  )
}
