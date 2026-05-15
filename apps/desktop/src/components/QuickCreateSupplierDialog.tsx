/**
 * Diálogo de alta rápida de proveedor. Crea con código autogenerado si no se
 * especifica (P-NNN). Devuelve el id creado vía onCreated.
 */
import { useState } from 'react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
import { useSuppliers } from '@/lib/hooks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}

function suggestCode(existing: string[]): string {
  // Busca el primer P-NNN libre.
  const taken = new Set(existing.map((c) => c.toUpperCase()))
  for (let i = 1; i < 10000; i++) {
    const c = `P-${String(i).padStart(3, '0')}`
    if (!taken.has(c)) return c
  }
  return `P-${Date.now()}`
}

export function QuickCreateSupplierDialog({ open, onClose, onCreated }: Props) {
  const qc = useQueryClient()
  const suppliers = useSuppliers()
  const [name, setName] = useState('')
  const [cuit, setCuit] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave(): Promise<void> {
    if (!name.trim()) {
      toast.error('Ingresá la razón social')
      return
    }
    setSaving(true)
    try {
      const code = suggestCode((suppliers.data ?? []).map((s) => s.code))
      const created = await api.suppliers.create({
        code,
        name: name.trim(),
        address: null,
        city: null,
        cuit: cuit.trim() || null,
        ingBrutos: null,
        phone: null,
        mobile: null,
      })
      await qc.invalidateQueries({ queryKey: ['suppliers'] })
      toast.success(`Proveedor "${created.name}" creado`)
      onCreated(created.id)
      setName('')
      setCuit('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo crear el proveedor')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName('')
          setCuit('')
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nuevo proveedor</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="qc-supplier-name">Razón social</Label>
            <Input
              id="qc-supplier-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) void handleSave()
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="qc-supplier-cuit">CUIT (opcional)</Label>
            <Input
              id="qc-supplier-cuit"
              value={cuit}
              onChange={(e) => setCuit(e.target.value)}
              placeholder="30-12345678-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) void handleSave()
              }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving}>
            Crear proveedor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
