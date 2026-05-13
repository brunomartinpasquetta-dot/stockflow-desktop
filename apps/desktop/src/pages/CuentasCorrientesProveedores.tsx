import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeft, Loader2, Truck } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useSupplierBalances } from '@/lib/hooks'
import { usePaymentMethods } from '@/lib/hooks'
import { usePaymentSplit } from '@/lib/usePaymentSplit'
import { usePermission } from '@/contexts/AuthContext'
import { useCanWrite } from '@/contexts/LicenseContext'
import { formatCurrency, formatDate, parseCurrencyInput } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PaymentSplitInput } from '@/components/PaymentSplitInput'
import type { SupplierAccountPayableDTO } from '@/types/api'

function PagoDialog({
  account,
  supplierId,
  onClose,
}: {
  account: SupplierAccountPayableDTO
  supplierId: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const methodsQuery = usePaymentMethods()
  const activeMethods = useMemo(() => (methodsQuery.data ?? []).filter((m) => m.active), [methodsQuery.data])
  const [monto, setMonto] = useState<string>(account.balance)
  const montoNum = monto ? Number(parseCurrencyInput(monto)) : 0
  const balanceNum = Number(account.balance)
  const split = usePaymentSplit(activeMethods, montoNum)

  const overBalance = montoNum > balanceNum + 0.005
  const canConfirm = montoNum > 0 && !overBalance && split.isComplete && activeMethods.length > 0

  const mutation = useMutation({
    mutationFn: () =>
      api.supplierAccounts.payInvoice({
        accountId: account.id,
        payments: split.payments,
        expectedAmount: montoNum.toFixed(4),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['supplierBalances'] })
      void qc.invalidateQueries({ queryKey: ['supplierStatement', supplierId] })
      void qc.invalidateQueries({ queryKey: ['supplierOpen', supplierId] })
      void qc.invalidateQueries({ queryKey: ['cash'] })
      toast.success(`Pago registrado — ${formatCurrency(montoNum)}`)
      onClose()
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudo registrar el pago'),
  })

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="rounded-md bg-muted px-3 py-2 text-sm">
            Saldo del comprobante: <span className="font-semibold tabular-nums">{formatCurrency(account.balance)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="pago-monto">Monto a pagar</Label>
            <Input
              id="pago-monto"
              autoFocus
              inputMode="decimal"
              value={monto}
              onChange={(e) => setMonto(e.target.value)}
              onBlur={() => monto && setMonto(parseCurrencyInput(monto))}
            />
            {overBalance && <span className="text-xs text-destructive">No puede superar el saldo del comprobante.</span>}
          </div>
          <div className="border-t pt-2">
            <p className="mb-1 text-xs font-medium text-muted-foreground">Composición del pago</p>
            <PaymentSplitInput methods={activeMethods} split={split} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Cancelar
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canConfirm || mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirmar pago
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SupplierDetail({ supplierId, onBack }: { supplierId: string; onBack: () => void }) {
  const canWrite = useCanWrite()
  const canPagar = usePermission('manage_supplier_accounts') && canWrite
  const statementQuery = useQuery({
    queryKey: ['supplierStatement', supplierId],
    queryFn: () => api.supplierAccounts.getStatement(supplierId),
  })
  const openQuery = useQuery({
    queryKey: ['supplierOpen', supplierId],
    queryFn: () => api.supplierAccounts.listOpenBySupplier(supplierId),
  })
  const [pagando, setPagando] = useState<SupplierAccountPayableDTO | null>(null)

  const supplier = statementQuery.data?.supplier
  const name = supplier ? `${supplier.code} — ${supplier.name}` : '…'
  const balance = statementQuery.data?.currentBalance ?? '0'

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-lg font-semibold">{name}</h1>
            {supplier?.cuit && (
              <p className="text-xs text-muted-foreground">CUIT: {supplier.cuit}</p>
            )}
          </div>
        </div>
        <Card>
          <CardContent className="px-4 py-2 text-sm">
            Saldo: <span className="text-lg font-bold tabular-nums">{formatCurrency(balance)}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <span className="text-sm font-medium">Comprobantes con saldo</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {openQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (openQuery.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Sin comprobantes pendientes</TableCell>
                </TableRow>
              ) : (
                (openQuery.data ?? []).map((ap) => (
                  <TableRow key={ap.id}>
                    <TableCell className="text-sm">{formatDate(ap.createdAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(ap.total)}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(ap.balance)}</TableCell>
                    <TableCell>
                      <Badge variant={ap.status === 'partial' ? 'warning' : 'outline'}>{ap.status === 'partial' ? 'Parcial' : 'Abierto'}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canPagar}
                        title={canPagar ? undefined : 'Requiere permiso para pagar'}
                        onClick={() => setPagando(ap)}
                      >
                        Pagar
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="border-b px-4 py-2 text-sm font-medium">Movimientos</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Detalle</TableHead>
                <TableHead className="text-right">Debe</TableHead>
                <TableHead className="text-right">Haber</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {statementQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (statementQuery.data?.entries ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Sin movimientos</TableCell>
                </TableRow>
              ) : (
                (statementQuery.data?.entries ?? []).map((e, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{formatDate(e.date)}</TableCell>
                    <TableCell>{e.reference}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(e.debit) > 0 ? formatCurrency(e.debit) : ''}</TableCell>
                    <TableCell className="text-right tabular-nums text-success">{Number(e.credit) > 0 ? formatCurrency(e.credit) : ''}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(e.runningBalance)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {pagando && <PagoDialog account={pagando} supplierId={supplierId} onClose={() => setPagando(null)} />}
    </div>
  )
}

export function CuentasCorrientesProveedores() {
  const balances = useSupplierBalances()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (selectedId) {
    return <SupplierDetail supplierId={selectedId} onBack={() => setSelectedId(null)} />
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold">Cuentas corrientes de proveedores</h1>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Proveedor</TableHead>
                <TableHead className="text-right">Comprobantes</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead className="text-right" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {balances.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">Cargando…</TableCell>
                </TableRow>
              ) : (balances.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                    <Truck className="mx-auto mb-2 h-7 w-7 opacity-40" />
                    No hay proveedores con saldo pendiente.
                  </TableCell>
                </TableRow>
              ) : (
                (balances.data ?? []).map((b) => (
                  <TableRow key={b.supplierId} className="cursor-pointer" onClick={() => setSelectedId(b.supplierId)}>
                    <TableCell className="font-medium">{b.supplierName}</TableCell>
                    <TableCell className="text-right tabular-nums">{b.openInvoicesCount}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatCurrency(b.totalDebt)}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedId(b.supplierId) }}>
                        Ver
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
