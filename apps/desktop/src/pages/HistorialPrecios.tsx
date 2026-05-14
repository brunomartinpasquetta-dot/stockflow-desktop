/**
 * Historial de actualizaciones masivas de precios.
 *
 * Lista los lotes aplicados, permite ver el detalle (entries) y revertir uno.
 * Sólo accesible a admin / manager (permiso `manage_prices`).
 */
import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Undo2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { api } from '@/lib/api'
import { usePriceUpdateBatchDetail, usePriceUpdateBatches } from '@/lib/hooks'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import type { PriceFieldDTO, PriceUpdateRuleDTO } from '@/types/api'

const FIELD_LABELS: Record<PriceFieldDTO, string> = {
  costPrice: 'Costo',
  listPrice1: 'Lista 1',
  listPrice2: 'Lista 2',
  listPrice3: 'Lista 3',
  wholesalePrice: 'Mayorista',
}

function summarizeRule(ruleJson: string): string {
  try {
    const rule = JSON.parse(ruleJson) as PriceUpdateRuleDTO
    const fields = rule.fields.map((f) => FIELD_LABELS[f]).join(', ')
    switch (rule.type) {
      case 'percentage':
        return `${rule.direction === 'decrease' ? '-' : '+'}${rule.value}% en ${fields}`
      case 'fixed_amount':
        return `${rule.direction === 'decrease' ? '-' : '+'}$${rule.value} en ${fields}`
      case 'set_value':
        return `Fijar $${rule.value} en ${fields}`
      case 'recalculate_from_cost':
        return `Recalcular desde costo en ${fields}`
      default:
        return ruleJson
    }
  } catch {
    return ruleJson
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('es-AR')
}

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function fromIsoDate(s: string): number {
  return new Date(s).getTime()
}

export function HistorialPrecios() {
  const today = new Date()
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000)
  const [from, setFrom] = useState(toIsoDate(monthAgo.getTime()))
  const [to, setTo] = useState(toIsoDate(today.getTime() + 86_400_000))
  const [search, setSearch] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [rollbackId, setRollbackId] = useState<string | null>(null)
  const [rolling, setRolling] = useState(false)
  const canWrite = useCanWrite()
  const canManage = usePermission('manage_prices')
  const canRollback = canWrite && canManage

  const qc = useQueryClient()
  const batches = usePriceUpdateBatches({
    from: fromIsoDate(from),
    to: fromIsoDate(to) + 86_400_000,
  })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = batches.data ?? []
    return q ? rows.filter((b) => b.description.toLowerCase().includes(q)) : rows
  }, [batches.data, search])

  async function handleRollback(): Promise<void> {
    if (!rollbackId) return
    setRolling(true)
    try {
      const res = await api.priceUpdate.rollback(rollbackId)
      toast.success(`Lote revertido (${res.entriesReverted} cambios).`)
      await qc.invalidateQueries({ queryKey: ['priceUpdateBatches'] })
      await qc.invalidateQueries({ queryKey: ['articles'] })
      setRollbackId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo revertir el lote')
    } finally {
      setRolling(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2 border-b pb-2">
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Desde</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <Label className="mb-1 block text-xs text-muted-foreground">Hasta</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="flex-1 min-w-[200px]">
          <Label className="mb-1 block text-xs text-muted-foreground">Buscar descripción</Label>
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="…" />
        </div>
      </div>

      <Card className="flex-1 overflow-hidden">
        <div className="h-full overflow-auto">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>Fecha</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Descripción</TableHead>
                <TableHead className="text-right"># artículos</TableHead>
                <TableHead>Regla</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="w-32">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {batches.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Cargando…
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Sin lotes en el rango.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>{formatDate(b.appliedAt)}</TableCell>
                    <TableCell>{b.userName}</TableCell>
                    <TableCell
                      className="cursor-pointer text-primary underline-offset-2 hover:underline"
                      onClick={() => setDetailId(b.id)}
                    >
                      {b.description}
                    </TableCell>
                    <TableCell className="text-right">{b.articlesAffected}</TableCell>
                    <TableCell className="text-xs">{summarizeRule(b.ruleJson)}</TableCell>
                    <TableCell>
                      {b.rolledBackAt != null ? (
                        <Badge variant="warning">Revertida</Badge>
                      ) : (
                        <Badge variant="success">Aplicada</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canRollback || b.rolledBackAt != null}
                        onClick={() => setRollbackId(b.id)}
                      >
                        <Undo2 className="mr-1 h-3 w-3" />
                        Revertir
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Dialog open={detailId != null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Detalle del lote</DialogTitle>
          </DialogHeader>
          {detailId && <BatchDetailView batchId={detailId} />}
        </DialogContent>
      </Dialog>

      <AlertDialog open={rollbackId != null} onOpenChange={(open) => !open && setRollbackId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Revertir el lote?</AlertDialogTitle>
            <AlertDialogDescription>
              Se restaurarán los precios anteriores en todos los artículos afectados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rolling}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleRollback} disabled={rolling}>
              {rolling ? 'Revirtiendo…' : 'Revertir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function BatchDetailView(props: { batchId: string }) {
  const detail = usePriceUpdateBatchDetail(props.batchId)
  if (detail.isLoading) return <div className="text-sm text-muted-foreground">Cargando…</div>
  if (!detail.data) return null
  const { batch, entries } = detail.data
  return (
    <div className="space-y-3">
      <div className="text-sm">
        <div>
          <span className="text-muted-foreground">Aplicado:</span> {formatDate(batch.appliedAt)}
          {' · '}
          <span className="text-muted-foreground">Por:</span> {batch.userName}
        </div>
        <div>
          <span className="text-muted-foreground">Regla:</span> {summarizeRule(batch.ruleJson)}
        </div>
        <div>
          <span className="text-muted-foreground">Artículos:</span> {batch.articlesAffected}{' '}
          ({entries.length} cambios)
        </div>
        {batch.rolledBackAt != null && (
          <div className="text-amber-700">
            Revertido el {formatDate(batch.rolledBackAt)}
          </div>
        )}
      </div>
      <div className="max-h-96 overflow-auto rounded border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Artículo</TableHead>
              <TableHead>Campo</TableHead>
              <TableHead className="text-right">Anterior</TableHead>
              <TableHead className="text-right">Nuevo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="font-mono text-xs">{e.articleId.slice(0, 8)}…</TableCell>
                <TableCell>{FIELD_LABELS[e.field]}</TableCell>
                <TableCell className="text-right">{formatCurrency(e.oldValue)}</TableCell>
                <TableCell className="text-right">{formatCurrency(e.newValue)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
