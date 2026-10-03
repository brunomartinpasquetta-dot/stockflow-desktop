/**
 * Diálogo "Seleccionar proveedor": buscador por código, nombre o CUIT.
 * Lo usan Compras y la revisión de Facturas escaneadas.
 */
import { useMemo, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SupplierDTO } from '@/types/api'

export function SupplierPicker({
  open,
  suppliers,
  onClose,
  onSelect,
}: {
  open: boolean
  suppliers: SupplierDTO[]
  onClose: () => void
  onSelect: (s: SupplierDTO) => void
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase()
    const base = [...suppliers].sort((a, b) => a.name.localeCompare(b.name))
    if (!term) return base.slice(0, 50)
    return base
      .filter((s) => `${s.code} ${s.name} ${s.cuit ?? ''}`.toLowerCase().includes(term))
      .slice(0, 50)
  }, [suppliers, q])
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Seleccionar proveedor</DialogTitle>
        </DialogHeader>
        <Input autoFocus placeholder="Buscar por código, nombre o CUIT…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-auto rounded-md border">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">Sin resultados</div>
          ) : (
            filtered.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s)}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent"
              >
                <span>
                  <span className="font-mono text-xs text-muted-foreground">{s.code}</span> · {s.name}
                </span>
                <span className="text-xs text-muted-foreground">{s.cuit ?? ''}</span>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
