import { useMemo, useState } from 'react'
import { z } from 'zod'
import { toast } from 'sonner'

import { useArticleMutations, useArticles, useCompany, useFamilies, useSuppliers } from '@/lib/hooks'
import { formatCurrency, formatNumber, parseCurrencyInput } from '@/lib/format'
import { vatBreakdown } from '@/lib/pricing'
import { EntityTable, type Column } from '@/components/EntityTable'
import { EntityFormDialog, type FieldConfig } from '@/components/EntityFormDialog'
import { Badge } from '@/components/ui/badge'
import type { ArticleDTO, PriceMode } from '@/types/api'

const VAT_OPTIONS = [
  { value: '0.00', label: '0%' },
  { value: '10.50', label: '10,5%' },
  { value: '21.00', label: '21%' },
  { value: '27.00', label: '27%' },
]
const UNIT_OPTIONS = [
  { value: 'UN', label: 'Unidad' },
  { value: 'KG', label: 'Kilogramo' },
  { value: 'GR', label: 'Gramo' },
  { value: 'LT', label: 'Litro' },
  { value: 'ML', label: 'Mililitro' },
]

const articleSchema = z.object({
  barcode: z.string().min(1, 'El código de barras es obligatorio'),
  description: z.string().min(1, 'La descripción es obligatoria').max(200, 'Máximo 200 caracteres'),
  brand: z.string(),
  familyId: z.string(),
  supplierId: z.string(),
  costPrice: z.string().min(1, 'Obligatorio'),
  listPrice1: z.string().min(1, 'Obligatorio'),
  vatRate: z.enum(['0.00', '10.50', '21.00', '27.00']),
  stock: z.string().min(1, 'Obligatorio'),
  minStock: z.string().min(1, 'Obligatorio'),
  unit: z.enum(['UN', 'KG', 'GR', 'LT', 'ML']),
  soldByWeight: z.boolean(),
})

/** Pista de desglose de IVA debajo de un campo de precio, según el modo. */
function priceHint(raw: unknown, rateRaw: unknown, mode: PriceMode): string | null {
  const amount = Number(parseCurrencyInput(typeof raw === 'string' ? raw : String(raw ?? '')))
  const rate = Number(rateRaw ?? '0')
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (rate <= 0) return mode === 'gross' ? 'IVA 0% — el importe es totalmente neto.' : 'IVA 0% — sin IVA agregado.'
  const b = vatBreakdown(amount, rate, mode)
  return mode === 'gross'
    ? `Neto: ${formatCurrency(b.net.toFixed(4))} · IVA: ${formatCurrency(b.vat.toFixed(4))}`
    : `Final con IVA: ${formatCurrency(b.gross.toFixed(4))} (IVA: ${formatCurrency(b.vat.toFixed(4))})`
}

export function Articulos() {
  const articles = useArticles()
  const families = useFamilies()
  const suppliers = useSuppliers()
  const company = useCompany()
  const m = useArticleMutations()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ArticleDTO | null>(null)

  const priceMode: PriceMode = company.data?.priceMode ?? 'gross'
  const priceSuffix = priceMode === 'gross' ? 'con IVA incluido' : 'neto'

  const familyName = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of families.data ?? []) map.set(f.id, f.name)
    return map
  }, [families.data])

  const columns: Column<ArticleDTO>[] = [
    { key: 'barcode', header: 'Código de barras' },
    { key: 'description', header: 'Descripción' },
    { key: 'brand', header: 'Marca', render: (r) => r.brand ?? '—' },
    { key: 'familyId', header: 'Familia', render: (r) => (r.familyId ? (familyName.get(r.familyId) ?? '—') : '—') },
    { key: 'stock', header: 'Stock', align: 'right', sortValue: (r) => Number(r.stock), render: (r) => formatNumber(r.stock, 3) },
    {
      key: 'listPrice1',
      header: `Precio venta (${priceSuffix})`,
      align: 'right',
      sortValue: (r) => Number(r.listPrice1),
      render: (r) => formatCurrency(r.listPrice1),
    },
  ]

  const fields: FieldConfig[] = [
    { name: 'barcode', label: 'Código de barras', type: 'text', placeholder: 'Escaneá o escribí el código' },
    { name: 'description', label: 'Descripción', type: 'text', full: true },
    { name: 'brand', label: 'Marca', type: 'text' },
    {
      name: 'familyId',
      label: 'Familia',
      type: 'select',
      allowEmpty: true,
      options: (families.data ?? []).map((f) => ({ value: f.id, label: f.name })),
    },
    {
      name: 'supplierId',
      label: 'Proveedor',
      type: 'select',
      allowEmpty: true,
      options: (suppliers.data ?? []).map((s) => ({ value: s.id, label: `${s.code} — ${s.name}` })),
    },
    { name: 'costPrice', label: `Costo (${priceSuffix})`, type: 'currency', placeholder: '0,00' },
    { name: 'listPrice1', label: `Precio de venta (${priceSuffix})`, type: 'currency', placeholder: '0,00' },
    { name: 'vatRate', label: 'IVA', type: 'select', options: VAT_OPTIONS },
    { name: 'stock', label: 'Stock actual', type: 'currency', placeholder: '0,000' },
    { name: 'minStock', label: 'Stock mínimo', type: 'currency', placeholder: '0,000' },
    { name: 'unit', label: 'Unidad', type: 'select', options: UNIT_OPTIONS },
    { name: 'soldByWeight', label: 'Se vende por peso', type: 'checkbox' },
  ]

  const defaultValues: Record<string, unknown> = editing
    ? {
        barcode: editing.barcode,
        description: editing.description,
        brand: editing.brand ?? '',
        familyId: editing.familyId ?? '',
        supplierId: editing.supplierId ?? '',
        costPrice: editing.costPrice,
        listPrice1: editing.listPrice1,
        vatRate: editing.vatRate,
        stock: editing.stock,
        minStock: editing.minStock,
        unit: editing.unit,
        soldByWeight: editing.soldByWeight,
      }
    : {
        barcode: '',
        description: '',
        brand: '',
        familyId: '',
        supplierId: '',
        costPrice: '0',
        listPrice1: '0',
        vatRate: '21.00',
        stock: '0',
        minStock: '0',
        unit: 'UN',
        soldByWeight: false,
      }

  async function handleSubmit(values: Record<string, unknown>): Promise<void> {
    const payload: Record<string, unknown> = {
      ...values,
      brand: values.brand || null,
      familyId: values.familyId || null,
      supplierId: values.supplierId || null,
    }
    if (editing) await m.update.mutateAsync({ id: editing.id, data: payload })
    else await m.create.mutateAsync(payload)
    toast.success(editing ? 'Artículo actualizado' : 'Artículo creado')
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Artículos</h1>
        <Badge variant={priceMode === 'gross' ? 'outline' : 'warning'}>
          Modo: Precios {priceMode === 'gross' ? 'CON IVA incluido' : 'NETOS (IVA aparte)'}
        </Badge>
      </div>
      <EntityTable
        columns={columns}
        data={articles.data}
        isLoading={articles.isLoading}
        searchFields={['barcode', 'description', 'brand']}
        searchPlaceholder="Buscar por código o descripción…"
        newLabel="Nuevo artículo"
        emptyMessage="No hay artículos cargados"
        onNew={() => {
          setEditing(null)
          setFormOpen(true)
        }}
        onEdit={(r) => {
          setEditing(r)
          setFormOpen(true)
        }}
        onDelete={(r) => m.remove.mutateAsync(r.id).then(() => undefined)}
        deleteTitle={(r) => r.description}
      />
      <EntityFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar artículo' : 'Nuevo artículo'}
        description={
          priceMode === 'gross'
            ? 'Modo: los precios que cargás YA incluyen el IVA. El sistema lo desglosa al facturar.'
            : 'Modo: los precios que cargás son NETOS. El sistema agrega el IVA al vender.'
        }
        fields={fields}
        schema={articleSchema}
        defaultValues={defaultValues}
        onSubmit={handleSubmit}
        liveHints={(v) => ({
          costPrice: priceHint(v.costPrice, v.vatRate, priceMode),
          listPrice1: priceHint(v.listPrice1, v.vatRate, priceMode),
        })}
      />
    </div>
  )
}
