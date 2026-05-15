/**
 * Diálogo de alta rápida de familia. Sólo pide nombre; queda como raíz.
 */
import { useState } from 'react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { useQueryClient } from '@tanstack/react-query'
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

export function QuickCreateFamilyDialog({ open, onClose, onCreated }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSave(): Promise<void> {
    if (!name.trim()) {
      toast.error('Ingresá el nombre de la familia')
      return
    }
    setSaving(true)
    try {
      const created = await api.families.create({ name: name.trim(), parentId: null })
      await qc.invalidateQueries({ queryKey: ['families'] })
      toast.success(`Familia "${created.name}" creada`)
      onCreated(created.id)
      setName('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo crear la familia')
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
          onClose()
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Nueva familia</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="qc-family-name">Nombre</Label>
            <Input
              id="qc-family-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
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
            Crear familia
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
