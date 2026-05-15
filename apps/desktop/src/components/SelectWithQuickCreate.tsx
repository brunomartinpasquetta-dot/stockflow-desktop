/**
 * <SelectWithQuickCreate>
 *
 * Combo + botón "+" para abrir un diálogo de alta rápida. Usado en formularios
 * donde hay que asignar una entidad relacionada (proveedor, familia, etc.)
 * sin salir del flujo principal.
 */
import { Plus } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface SelectWithQuickCreateProps {
  value: string | null
  onChange: (id: string) => void
  options: { id: string; label: string }[]
  onCreate: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

export function SelectWithQuickCreate({
  value,
  onChange,
  options,
  onCreate,
  placeholder = '—',
  disabled,
  className,
}: SelectWithQuickCreateProps) {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Select
        className="flex-1"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        size="icon"
        variant="outline"
        className="h-9 w-9 shrink-0"
        onClick={onCreate}
        disabled={disabled}
        title="Crear nuevo"
      >
        <Plus className="h-4 w-4" />
      </Button>
    </div>
  )
}
