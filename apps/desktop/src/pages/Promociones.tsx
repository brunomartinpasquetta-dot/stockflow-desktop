/**
 * ABM de PROMOCIONES (combos).
 *
 * Una promo agrupa artículos con sus cantidades y se vende como UN artículo
 * (código PROMO-N, marca PROMO) al precio elegido. El formulario muestra en
 * vivo el COSTO REAL (Σ cantidad × costo de cada componente) y el margen.
 * Al venderse, el stock se descuenta de los componentes; al anular, vuelve.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BadgePercent, Plus, Search, Trash2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { usePromotions, useArticles } from '@/lib/hooks'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePermission } from '@/contexts/AuthContext'
import { formatCurrency } from '@/lib/format'
import { parseCurrencyInput } from '@/lib/format'
import { EntityTable, type Column } from '@/components/EntityTable'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ArticleDTO, PromotionDTO } from '@/types/api'

interface FormItem {
  articleId: string
  description: string
  barcode: string
  costPrice: string
  stock: string
  quantity: string
}

const money = (v: string | number): string => formatCurrency(v)

export function Promociones() {
  const canWrite = useCanWrite()
  const canManage = usePermission('manage_promotions')
  const qc = useQueryClient()
  const promosQuery = usePromotions()
  const articlesQuery = useArticles()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PromotionDTO | null>(null)

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['promotions'] })
    void qc.invalidateQueries({ queryKey: ['articles'] })
  }

  const toggleActive = useMutation({
    mutationFn: (p: PromotionDTO) => api.promotions.setActive(p.id, !p.active),
    onSuccess: (p) => {
      invalidate()
      toast.success(p.active ? `Promo "${p.name}" activada` : `Promo "${p.name}" desactivada`)
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo cambiar el estado'),
  })

  const removePromo = useMutation({
    mutationFn: (id: string) => api.promotions.delete(id),
    onSuccess: () => {
      invalidate()
      toast.success('Promoción eliminada')
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo eliminar'),
  })

  const columns: Column<PromotionDTO>[] = [
    { key: 'code', header: 'Código', render: (p) => <span className="font-mono text-xs">{p.code}</span> },
    { key: 'name', header: 'Promoción', sortValue: (p) => p.name },
    {
      key: 'items',
      header: 'Incluye',
      render: (p) => (
        <span className="text-xs text-muted-foreground">
          {p.items.map((i) => `${Number(i.quantity)}× ${i.description}`).join(' + ')}
        </span>
      ),
    },
    { key: 'cost', header: 'Costo real', align: 'right', render: (p) => <span className="tabular-nums">{money(p.cost)}</span> },
    { key: 'price', header: 'Precio', align: 'right', render: (p) => <b className="tabular-nums">{money(p.price)}</b> },
    {
      key: 'margin',
      header: 'Margen',
      align: 'right',
      render: (p) => {
        const m = Number(p.price) - Number(p.cost)
        const pct = Number(p.cost) > 0 ? (m / Number(p.cost)) * 100 : 0
        return (
          <span className={`tabular-nums ${m < 0 ? 'text-destructive font-semibold' : 'text-green-700'}`}>
            {money(m)} ({pct.toFixed(1)}%)
          </span>
        )
      },
    },
    {
      key: 'active',
      header: 'Estado',
      render: (p) => (
        <button
          type="button"
          disabled={!canWrite || !canManage || toggleActive.isPending}
          onClick={(e) => {
            e.stopPropagation()
            toggleActive.mutate(p)
          }}
          title={p.active ? 'Clic para desactivar (deja de venderse)' : 'Clic para activar'}
        >
          <Badge variant={p.active ? 'primary' : 'outline'}>{p.active ? 'Activa' : 'Inactiva'}</Badge>
        </button>
      ),
    },
  ]

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <EntityTable<PromotionDTO>
        columns={columns}
        data={promosQuery.data}
        isLoading={promosQuery.isLoading}
        searchFields={['name', 'code']}
        readOnly={!canWrite || !canManage}
        newLabel="Nueva promo"
        searchPlaceholder="Buscar promo…"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(p) => {
          setEditing(p)
          setFormOpen(true)
        }}
        onDelete={(p) => removePromo.mutate(p.id)}
        deleteTitle={(p) => `¿Eliminar la promo "${p.name}"? Si ya tuvo ventas no se puede: en ese caso desactivala.`}
        emptyMessage="Todavía no hay promociones. Creá la primera con el botón Nueva promo."
      />
      <PromoFormDialog
        key={editing?.id ?? 'new'}
        open={formOpen}
        editing={editing}
        articles={articlesQuery.data ?? []}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          setFormOpen(false)
          invalidate()
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Formulario alta/edición                                             */
/* ------------------------------------------------------------------ */

function PromoFormDialog(props: {
  open: boolean
  editing: PromotionDTO | null
  articles: ArticleDTO[]
  onClose: () => void
  onSaved: () => void
}) {
  const { open, editing, articles, onClose, onSaved } = props
  const [name, setName] = useState(editing?.name ?? '')
  const [price, setPrice] = useState(editing ? String(Number(editing.price)) : '')
  const [items, setItems] = useState<FormItem[]>(
    editing?.items.map((i) => ({
      articleId: i.articleId,
      description: i.description,
      barcode: i.barcode,
      costPrice: i.costPrice,
      stock: i.stock,
      quantity: String(Number(i.quantity)),
    })) ?? [],
  )
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  // Candidatos: activos, que no sean promos (el back igual lo valida) y no agregados.
  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q.length < 2) return []
    const chosen = new Set(items.map((i) => i.articleId))
    return articles
      .filter(
        (a) =>
          a.active &&
          a.brand !== 'PROMO' &&
          !chosen.has(a.id) &&
          (a.description.toLowerCase().includes(q) || a.barcode.toLowerCase().includes(q) || (a.brand ?? '').toLowerCase().includes(q)),
      )
      .slice(0, 50)
  }, [articles, search, items])

  const cost = items.reduce((acc, i) => acc + Number(i.quantity || '0') * Number(i.costPrice), 0)
  const priceNum = Number(parseCurrencyInput(price || '0'))
  const margin = priceNum - cost
  const marginPct = cost > 0 ? (margin / cost) * 100 : 0

  function addItem(a: ArticleDTO): void {
    setItems((prev) => [
      ...prev,
      { articleId: a.id, description: a.description, barcode: a.barcode, costPrice: a.costPrice, stock: a.stock, quantity: '1' },
    ])
    setSearch('')
  }

  async function save(): Promise<void> {
    const nameTrim = name.trim()
    if (nameTrim.length < 2) {
      toast.error('Poné un nombre para la promo (mínimo 2 letras)')
      return
    }
    if (items.length === 0) {
      toast.error('Agregá al menos un artículo a la promo')
      return
    }
    if (!(priceNum > 0)) {
      toast.error('Poné el precio de venta de la promo')
      return
    }
    const badQty = items.find((i) => !(Number(i.quantity) > 0))
    if (badQty) {
      toast.error(`Revisá la cantidad de "${badQty.description}"`)
      return
    }
    setSaving(true)
    try {
      const payload = {
        name: nameTrim,
        price: priceNum.toFixed(4),
        items: items.map((i) => ({ articleId: i.articleId, quantity: Number(i.quantity).toFixed(3) })),
      }
      if (editing) {
        await api.promotions.update(editing.id, payload)
        toast.success(`Promo "${nameTrim}" actualizada`)
      } else {
        const created = await api.promotions.create(payload)
        toast.success(`Promo "${created.name}" creada (código ${created.code})`)
      }
      onSaved()
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'No se pudo guardar la promoción')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgePercent className="h-5 w-5 text-primary" />
            {editing ? `Modificar promo — ${editing.code}` : 'Nueva promoción'}
          </DialogTitle>
        </DialogHeader>

        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="promo-name">Nombre de la promo</Label>
              <Input id="promo-name" autoFocus placeholder="Ej: Promo Asado" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="promo-price">Precio de venta</Label>
              <Input id="promo-price" inputMode="decimal" placeholder="Ej: 12000" value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
          </div>

          {/* Buscador de componentes */}
          <div className="flex flex-col gap-1">
            <Label htmlFor="promo-search">Agregar artículos que incluye</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="promo-search"
                className="pl-8"
                placeholder="Buscá por nombre, código o marca…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {candidates.length > 0 && (
              <div className="rounded-md border bg-popover p-1 shadow-sm">
                {candidates.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => addItem(a)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Plus className="h-3.5 w-3.5 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{a.description}</span>
                    {a.brand && <Badge variant="outline" className="text-[10px]">{a.brand}</Badge>}
                    <span className="font-mono text-xs text-muted-foreground">costo {money(a.costPrice)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Componentes elegidos */}
          {items.length > 0 && (
            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1.5 text-left">Artículo</th>
                    <th className="w-24 px-2 py-1.5 text-center">Cantidad</th>
                    <th className="px-2 py-1.5 text-right">Costo unit.</th>
                    <th className="px-2 py-1.5 text-right">Costo total</th>
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i, idx) => (
                    <tr key={i.articleId} className="border-t">
                      <td className="px-2 py-1.5">
                        {i.description}
                        <span className="ml-2 font-mono text-[10px] text-muted-foreground">{i.barcode}</span>
                      </td>
                      <td className="px-2 py-1">
                        <Input
                          className="h-7 text-center"
                          inputMode="decimal"
                          value={i.quantity}
                          onChange={(e) =>
                            setItems((prev) => prev.map((it, k) => (k === idx ? { ...it, quantity: e.target.value } : it)))
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{money(i.costPrice)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        {money(Number(i.quantity || '0') * Number(i.costPrice))}
                      </td>
                      <td className="px-1 py-1 text-center">
                        <button
                          type="button"
                          title="Quitar de la promo"
                          onClick={() => setItems((prev) => prev.filter((_, k) => k !== idx))}
                          className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Costo real y margen en vivo */}
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm">
            <span>
              Costo real: <b className="tabular-nums">{money(cost)}</b>
            </span>
            <span>
              Precio: <b className="tabular-nums">{money(priceNum)}</b>
            </span>
            <span className={margin < 0 ? 'text-destructive font-semibold' : 'text-green-700 font-semibold'}>
              Margen: {money(margin)} ({cost > 0 ? marginPct.toFixed(1) : '—'}%)
            </span>
          </div>
          {margin < 0 && priceNum > 0 && (
            <p className="text-xs text-destructive">⚠ El precio está por DEBAJO del costo: vas a perder plata con cada promo vendida.</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {editing ? 'Guardar cambios' : 'Crear promoción'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
