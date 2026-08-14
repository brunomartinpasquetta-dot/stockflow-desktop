/**
 * ARTÍCULO RÁPIDO — cobrar algo que no está en el catálogo.
 *
 * Un flete, una changa, un artículo que entró hoy y todavía no se dio de alta.
 * El cajero escribe qué es y cuánto sale, y sigue vendiendo.
 *
 * NO crea un artículo. StockFácil sí lo hace —uno nuevo por cada venta— y en la
 * base de Leo Citzia eso dejó 10.323 artículos fantasma sobre 12.432: el 83% del
 * catálogo era basura de un solo uso, cada uno con stock en negativo. Acá la
 * línea guarda su propia descripción y no toca el inventario.
 */
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CurrencyInput } from '@/components/ui/currency-input'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { parseCurrencyInput } from '@/lib/format'

const VAT_OPTIONS = [
  { value: '0.00', label: '0%' },
  { value: '10.50', label: '10,5%' },
  { value: '21.00', label: '21%' },
  { value: '27.00', label: '27%' },
] as const

export interface ArticuloRapido {
  description: string
  quantity: string
  unitPrice: string
  vatRate: string
}

export function ArticuloRapidoDialog({
  onAdd,
  onClose,
}: {
  onAdd: (linea: ArticuloRapido) => void
  onClose: () => void
}) {
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [unitPrice, setUnitPrice] = useState('')
  const [vatRate, setVatRate] = useState('21.00')

  const precioNum = Number(parseCurrencyInput(unitPrice)) || 0
  const cantidadNum = Number(quantity.replace(',', '.')) || 0
  const puedeAgregar = description.trim().length > 0 && precioNum > 0 && cantidadNum > 0

  function agregar(): void {
    if (!puedeAgregar) return
    onAdd({
      description: description.trim(),
      quantity: quantity.replace(',', '.'),
      unitPrice: parseCurrencyInput(unitPrice),
      vatRate,
    })
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Artículo rápido</DialogTitle>
        </DialogHeader>

        <div
          className="flex flex-col gap-3"
          // Enter agrega y cierra: es una pantalla de mostrador, con el cliente
          // esperando. No hace falta llegar al botón con el mouse.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && puedeAgregar) {
              e.preventDefault()
              agregar()
            }
          }}
        >
          <div className="flex flex-col gap-1">
            <Label>¿Qué se cobra?</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ej: Flete, Fotocopias, Anillado"
              maxLength={120}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div className="flex flex-col gap-1">
              <Label>Cantidad</Label>
              <Input
                className="text-right tabular-nums"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>Precio unitario</Label>
              <CurrencyInput value={unitPrice} onChange={setUnitPrice} />
            </div>
            <div className="flex flex-col gap-1">
              <Label>IVA</Label>
              <Select value={vatRate} onChange={(e) => setVatRate(e.target.value)}>
                {VAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            No se da de alta ningún artículo ni se mueve stock: sale sólo en esta venta.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={!puedeAgregar} onClick={agregar}>
            Agregar a la venta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
