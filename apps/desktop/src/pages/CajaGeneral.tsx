/**
 * CAJA GENERAL — pantalla propia (antes vivía dentro de Historial de Cajas).
 *
 * Saldo consolidado del negocio: recibe los depósitos de cierre de las cajas
 * diarias y los ingresos/egresos manuales. Gateada por el permiso
 * `view_cash_general` (área Caja) — así se puede bloquear sin tocar los
 * historiales de ventas/cajas (pedido de Bruno, 2026-07).
 */
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, PlusCircle, MinusCircle, Wallet } from 'lucide-react'

import {
  useCashGeneralBalanceBreakdown,
  useCashGeneralMovements,
  useCashGeneralMutations,
} from '@/lib/hooks'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency, formatDateTime } from '@/lib/format'
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
  if (!canView) return <Navigate to="/" replace />
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
      <CajaGeneralInner />
      <HistorialCajas />
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

function CajaGeneralInner() {
  const canManage = usePermission('manage_cash_general')
  const balanceQ = useCashGeneralBalanceBreakdown()
  const [openDialog, setOpenDialog] = useState<'income' | 'expense' | null>(null)

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold">Caja General</h2>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="rounded-md border bg-muted/40 px-3 py-1.5 text-right">
              <div className="text-[11px] text-muted-foreground">Efectivo</div>
              <div className="text-lg font-semibold tabular-nums">
                {balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.cash ?? '0')}
              </div>
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-1.5 text-right">
              <div className="text-[11px] text-muted-foreground">Electrónico</div>
              <div className="text-lg font-semibold tabular-nums">
                {balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.electronic ?? '0')}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground">Saldo total</div>
              <div className="text-2xl font-bold tabular-nums">
                {balanceQ.isLoading ? '…' : formatCurrency(balanceQ.data?.total ?? '0')}
              </div>
            </div>
          </div>
        </div>

        {canManage && (
          <div className="flex gap-2">
            <Button onClick={() => setOpenDialog('income')} className="bg-success text-success-foreground hover:bg-success/90">
              <PlusCircle className="h-4 w-4" />
              Registrar Ingreso
            </Button>
            <Button variant="destructive" onClick={() => setOpenDialog('expense')}>
              <MinusCircle className="h-4 w-4" />
              Registrar Egreso
            </Button>
          </div>
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
  const movementsQ = useCashGeneralMovements({
    from: dayStart(fromIso),
    to: dayEnd(toIso),
    type: (type || undefined) as 'income' | 'expense' | 'transfer_from_daily' | undefined,
  })

  async function exportarExcel(): Promise<void> {
    const rows = movementsQ.data ?? []
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
        <Button variant="outline" onClick={() => void exportarExcel()}>Exportar Excel</Button>
      </div>
      <div className="max-h-72 overflow-auto rounded-md border bg-background">
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
            {(movementsQ.data ?? []).length === 0 ? (
              <TableRow><TableCell colSpan={7} className="py-4 text-center text-muted-foreground">Sin movimientos en el rango</TableCell></TableRow>
            ) : (movementsQ.data ?? []).map((m) => (
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
    </div>
  )
}
