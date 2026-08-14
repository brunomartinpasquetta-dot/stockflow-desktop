/**
 * AUDITORÍA — bitácora de todas las operaciones de escritura del sistema.
 *
 * Muestra quién hizo qué y cuándo (ventas, anulaciones, devoluciones, cambios
 * de artículos/clientes, aperturas/cierres de caja, pagos, etc.). Solo lectura
 * y solo para administradores (el backend además lo exige). Se llena
 * automáticamente desde la capa IPC (withAudit), no requiere acción del usuario.
 */
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ScrollText } from 'lucide-react'

import { useAuditLog, useAuditAreas, useUsers } from '@/lib/hooks'
import { useAuth } from '@/contexts/AuthContext'
import { formatDateTime } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SinPermiso } from '@/components/SinPermiso'

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

export function Auditoria() {
  const { currentUser } = useAuth()
  const isAdmin = currentUser?.role === 'admin'

  const [fromIso, setFromIso] = useState(() => isoDaysAgo(7))
  const [toIso, setToIso] = useState(() => todayIso())
  const [userId, setUserId] = useState('')
  const [area, setArea] = useState('')
  const [q, setQ] = useState('')
  const [applied, setApplied] = useState({
    from: dayStart(isoDaysAgo(7)),
    to: dayEnd(todayIso()),
    userId: '' as string | undefined,
    area: '' as string | undefined,
    q: '' as string | undefined,
  })

  const usersQuery = useUsers()
  const areasQuery = useAuditAreas()
  const logQuery = useAuditLog(applied)

  const userNameById = useMemo(
    () => new Map((usersQuery.data ?? []).map((u) => [u.id, u.fullName])),
    [usersQuery.data],
  )

  function buscar(): void {
    setApplied({
      from: dayStart(fromIso),
      to: dayEnd(toIso),
      userId: userId || undefined,
      area: area || undefined,
      q: q.trim() || undefined,
    })
  }

  async function exportarExcel(): Promise<void> {
    const rows = logQuery.data ?? []
    if (rows.length === 0) {
      toast.info('No hay registros para exportar')
      return
    }
    try {
      const XLSX = await import('xlsx')
      const data = rows.map((r) => ({
        Fecha: formatDateTime(r.createdAt),
        Usuario: r.username,
        Área: r.area,
        Operación: r.description,
        Canal: r.channel,
      }))
      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Auditoría')
      XLSX.writeFile(wb, `auditoria-${fromIso}-${toIso}.xlsx`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error exportando')
    }
  }

  if (!isAdmin) return <SinPermiso area="Auditoría" />

  const rows = logQuery.data ?? []

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <ScrollText className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Auditoría del sistema</h1>
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
          <div className="flex flex-col gap-1">
            <Label>Usuario</Label>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Todos</option>
              {(usersQuery.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Área</Label>
            <Select value={area} onChange={(e) => setArea(e.target.value)}>
              <option value="">Todas</option>
              {(areasQuery.data ?? []).map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>Buscar</Label>
            <Input placeholder="Texto en la operación…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') buscar() }} />
          </div>
          <div className="flex gap-2">
            <Button onClick={buscar}>Buscar</Button>
            <Button variant="outline" onClick={() => void exportarExcel()} disabled={rows.length === 0}>Excel</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">Fecha y hora</TableHead>
                  <TableHead className="w-40">Usuario</TableHead>
                  <TableHead className="w-36">Área</TableHead>
                  <TableHead>Operación</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logQuery.isLoading ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">Cargando…</TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">Sin operaciones en el período seleccionado.</TableCell></TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTime(r.createdAt)}</TableCell>
                      <TableCell className="text-xs font-medium">{r.username || userNameById.get(r.userId ?? '') || '—'}</TableCell>
                      <TableCell className="text-xs">{r.area}</TableCell>
                      <TableCell className="text-sm">{r.description}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex shrink-0 items-center justify-between border-t bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <span>{rows.length} operación(es)</span>
            <span>Se registran automáticamente todas las operaciones de escritura.</span>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
