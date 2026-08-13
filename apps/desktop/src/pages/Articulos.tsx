/**
 * Articulos — pantalla master-detail estilo StockFacil.
 *
 * Layout:
 *  - Toolbar superior (Nuevo, Modificar, Borrar, Imprimir, PDF, Excel, Buscar).
 *  - Grilla (filtrable, sort por columna, navegación con flechas).
 *  - Panel inferior con el formulario completo del artículo (modos:
 *    idle/view/edit/create) y un selector de imagen (`ArticleImagePicker`).
 *
 * Reescrita en bloque sin usar `EntityTable`/`EntityFormDialog` (esos siguen
 * siendo usados por las otras pantallas).
 */
import * as React from 'react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  FileText,
  Pencil,
  Plus,
  Printer,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import * as XLSX from 'xlsx'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { SelectWithQuickCreate } from '@/components/SelectWithQuickCreate'
import { QuickCreateSupplierDialog } from '@/components/QuickCreateSupplierDialog'
import { QuickCreateFamilyDialog } from '@/components/QuickCreateFamilyDialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useCanWrite } from '@/contexts/LicenseContext'
import { usePermission } from '@/contexts/AuthContext'
import {
  useArticleMutations,
  useArticlePriceHistory,
  useArticles,
  useCompany,
  useFamilies,
  useSuppliers,
} from '@/lib/hooks'
import { api } from '@/lib/api'
import { formatCurrency, formatQty } from '@/lib/format'
import { articleMatches, buildSearchContext } from '@/lib/articleSearch'
import { CurrencyInput } from '@/components/ui/currency-input'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ArticleDTO, FamilyDTO, SupplierDTO, Unit } from '@/types/api'

const VAT_OPTIONS = [
  { value: '0.00', label: '0%' },
  { value: '10.50', label: '10,5%' },
  { value: '21.00', label: '21%' },
  { value: '27.00', label: '27%' },
] as const

const UNIT_OPTIONS = [
  { value: 'UN', label: 'Unidad' },
  { value: 'KG', label: 'Kilogramo' },
  { value: 'GR', label: 'Gramo' },
  { value: 'LT', label: 'Litro' },
  { value: 'ML', label: 'Mililitro' },
] as const

type Mode = 'idle' | 'view' | 'edit' | 'create'

interface FormState {
  barcode: string
  description: string
  brand: string
  familyId: string
  supplierId: string
  costPrice: string
  listPrice1: string
  listPrice2: string
  listPrice3: string
  wholesalePrice: string
  wholesaleMinQty: string
  vatRate: string
  stock: string
  minStock: string
  idealStock: string
  soldByWeight: boolean
  unit: Unit
  notes: string
}

const EMPTY_FORM: FormState = {
  barcode: '',
  description: '',
  brand: '',
  familyId: '',
  supplierId: '',
  costPrice: '0',
  listPrice1: '0',
  listPrice2: '0',
  listPrice3: '0',
  wholesalePrice: '0',
  wholesaleMinQty: '0',
  vatRate: '21.00',
  stock: '0',
  minStock: '0',
  idealStock: '0',
  soldByWeight: false,
  unit: 'UN',
  notes: '',
}

function articleToForm(a: ArticleDTO): FormState {
  return {
    barcode: a.barcode,
    description: a.description,
    brand: a.brand ?? '',
    familyId: a.familyId ?? '',
    supplierId: a.supplierId ?? '',
    costPrice: a.costPrice,
    listPrice1: a.listPrice1,
    listPrice2: a.listPrice2,
    listPrice3: a.listPrice3,
    wholesalePrice: a.wholesalePrice,
    wholesaleMinQty: a.wholesaleMinQty,
    vatRate: a.vatRate,
    stock: a.stock,
    minStock: a.minStock,
    idealStock: a.idealStock,
    soldByWeight: a.soldByWeight,
    unit: a.unit,
    notes: a.notes ?? '',
  }
}

function utilPct(precio: string, costo: string): string {
  const p = Number(precio)
  const c = Number(costo)
  if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0) return '—'
  return (((p - c) / c) * 100).toFixed(2) + '%'
}

function stockBadgeVariant(
  stock: string,
  min: string,
  ideal: string,
): 'destructive' | 'warning' | 'success' {
  const s = Number(stock)
  const m = Number(min)
  const i = Number(ideal)
  if (Number.isFinite(s) && Number.isFinite(m) && s < m) return 'destructive'
  if (Number.isFinite(i) && i > 0 && Number.isFinite(s) && s < i) return 'warning'
  return 'success'
}

type SortKey = 'barcode' | 'description' | 'familyId' | 'listPrice1' | 'stock'
type SortDir = 'asc' | 'desc'

function isTypingInForm(): boolean {
  const tag = document.activeElement?.tagName ?? ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function Articulos() {
  const canWrite = useCanWrite()
  const canManage = usePermission('manage_articles')
  const canEditArticles = canWrite && canManage

  const articles = useArticles()
  const families = useFamilies()
  const suppliers = useSuppliers()
  const company = useCompany()
  const m = useArticleMutations()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('idle')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [search, setSearch] = useState('')
  const [brandFilter, setBrandFilter] = useState<string>('')
  // Los dados de baja quedan fuera salvo que se pidan: en una base migrada son
  // 10.303 de 12.413 y tapan por completo lo que el comercio usa todos los días.
  const [verBajas, setVerBajas] = useState(false)
  // Se dibujan las primeras filas nomás. Con 12.000 artículos, pintar la grilla
  // entera congelaba la pantalla varios segundos —peor en las terminales, que
  // además reciben todo por red—. Es lo mismo que hace StockFácil con su
  // "Mostrar todo".
  const [verTodas, setVerTodas] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('description')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  // Imagen que el usuario eligió en `create` y todavía no se subió.
  const [pendingImageSource, setPendingImageSource] = useState<string | null>(null)
  // Quick-create dialogs para proveedor / familia
  const [quickCreate, setQuickCreate] = useState<'supplier' | 'family' | null>(null)

  const searchRef = useRef<HTMLInputElement | null>(null)
  const tableContainerRef = useRef<HTMLDivElement | null>(null)

  // Deep-link desde el CommandPalette: `?articleId=<id>` / `?action=new`.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const articleId = searchParams.get('articleId')
    const action = searchParams.get('action')
    if (articleId && (articles.data ?? []).some((a) => a.id === articleId)) {
      const target = (articles.data ?? []).find((a) => a.id === articleId)
      if (target) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSelectedId(target.id)
        setMode('view')
        setForm(articleToForm(target))
        setPendingImageSource(null)
      }
      const next = new URLSearchParams(searchParams)
      next.delete('articleId')
      setSearchParams(next, { replace: true })
    } else if (action === 'new' && canEditArticles) {
      setSelectedId(null)
      setMode('create')
      setForm(EMPTY_FORM)
      setPendingImageSource(null)
      const next = new URLSearchParams(searchParams)
      next.delete('action')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articles.data, searchParams])

  const familyName = useMemo(() => {
    const map = new Map<string, string>()
    for (const f of families.data ?? []) map.set(f.id, f.name)
    return map
  }, [families.data])

  const supplierName = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of suppliers.data ?? []) map.set(s.id, `${s.code} — ${s.name}`)
    return map
  }, [suppliers.data])

  const selectedArticle = useMemo<ArticleDTO | null>(
    () => (articles.data ?? []).find((a) => a.id === selectedId) ?? null,
    [articles.data, selectedId],
  )

  // Marcas distintas (para el filtro).
  const brandOptions = useMemo<string[]>(
    () => [...new Set((articles.data ?? []).map((a) => a.brand).filter((b): b is string => !!b))].sort((x, y) => x.localeCompare(y)),
    [articles.data],
  )

  const searchCtx = useMemo(() => buildSearchContext(families.data, suppliers.data), [families.data, suppliers.data])
  // Lista filtrada + ordenada. El buscador matchea CUALQUIER propiedad
  // (código, descripción, marca, familia, proveedor).
  const filtered = useMemo<ArticleDTO[]>(() => {
    const q = search.trim()
    const base = articles.data ?? []
    let filteredRows = q ? base.filter((a) => articleMatches(a, q, searchCtx)) : base
    if (!verBajas) filteredRows = filteredRows.filter((a) => a.active)
    if (brandFilter) filteredRows = filteredRows.filter((a) => a.brand === brandFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    // Valor a comparar (familyId → nombre de familia; el resto, el campo crudo).
    const getVal = (a: ArticleDTO): string =>
      sortKey === 'familyId'
        ? a.familyId
          ? (familyName.get(a.familyId) ?? '')
          : ''
        : String(a[sortKey] ?? '')
    return [...filteredRows].sort((a, b) => {
      const av = getVal(a)
      const bv = getVal(b)
      // Números guardados como string (precios, stock, mínimos, código): comparar
      // como NÚMERO si ambos son numéricos → evita el orden 1,10,11,2,...,9.
      const an = Number(av)
      const bn = Number(bv)
      const bothNum = Number.isFinite(an) && Number.isFinite(bn) && av.trim() !== '' && bv.trim() !== ''
      if (bothNum) return (an - bn) * dir
      return av.localeCompare(bv, 'es', { numeric: true, sensitivity: 'base' }) * dir
    })
  }, [articles.data, search, brandFilter, verBajas, sortKey, sortDir, familyName, searchCtx])

  /** Cuántos hay en total según el filtro de bajas (para el contador). */
  const totalActivos = useMemo(
    () => (articles.data ?? []).filter((a) => verBajas || a.active).length,
    [articles.data, verBajas],
  )

  /** Lo que realmente se dibuja (ver `verTodas`). */
  const TOPE_FILAS = 300
  const visibles = useMemo(
    () => (verTodas ? filtered : filtered.slice(0, TOPE_FILAS)),
    [filtered, verTodas],
  )

  function selectArticle(a: ArticleDTO): void {
    setSelectedId(a.id)
    setMode('view')
    setForm(articleToForm(a))
    setPendingImageSource(null)
  }

  function startCreate(): void {
    setSelectedId(null)
    setMode('create')
    setForm(EMPTY_FORM)
    setPendingImageSource(null)
  }

  function startEdit(): void {
    if (!selectedArticle) return
    setForm(articleToForm(selectedArticle))
    setMode('edit')
  }

  function cancelEdit(): void {
    if (mode === 'create') {
      setMode('idle')
      setForm(EMPTY_FORM)
      setSelectedId(null)
      setPendingImageSource(null)
      return
    }
    if (selectedArticle) {
      setForm(articleToForm(selectedArticle))
      setMode('view')
      setPendingImageSource(null)
    } else {
      setMode('idle')
    }
  }

  const isEditing = mode === 'edit' || mode === 'create'
  const inputsDisabled = !isEditing

  function setField<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function validate(): string | null {
    if (!form.barcode.trim()) return 'El código es obligatorio'
    if (form.description.trim().length < 2)
      return 'La descripción debe tener al menos 2 caracteres'
    if (!form.brand.trim()) return 'La marca es obligatoria'
    if (Number(form.costPrice) < 0) return 'El costo no puede ser negativo'
    if (Number(form.listPrice1) < 0) return 'El precio de lista 1 no puede ser negativo'
    return null
  }

  async function handleSave(): Promise<void> {
    const err = validate()
    if (err) {
      toast.error(err)
      return
    }
    if (Number(form.idealStock) > 0 && Number(form.idealStock) < Number(form.minStock)) {
      toast.warning('El stock ideal es menor al mínimo — revisalo si no fue intencional')
    }
    const payload: Record<string, unknown> = {
      barcode: form.barcode.trim(),
      description: form.description.trim(),
      brand: form.brand.trim(),
      familyId: form.familyId || null,
      supplierId: form.supplierId || null,
      costPrice: form.costPrice || '0',
      listPrice1: form.listPrice1 || '0',
      listPrice2: form.listPrice2 || '0',
      listPrice3: form.listPrice3 || '0',
      wholesalePrice: form.wholesalePrice || '0',
      wholesaleMinQty: form.wholesaleMinQty || '0',
      vatRate: form.vatRate,
      stock: form.stock || '0',
      minStock: form.minStock || '0',
      idealStock: form.idealStock || '0',
      soldByWeight: form.soldByWeight,
      unit: form.unit,
      notes: form.notes.trim() || null,
    }
    try {
      if (mode === 'create') {
        const created = await m.create.mutateAsync(payload)
        // Si había una imagen pendiente, subirla.
        if (pendingImageSource) {
          try {
            await api.articles.uploadImage(created.id, pendingImageSource)
          } catch (uploadErr) {
            toast.warning(
              uploadErr instanceof Error ? uploadErr.message : 'No se pudo subir la imagen',
            )
          }
        }
        setSelectedId(created.id)
        setMode('view')
        setForm(articleToForm(created))
        setPendingImageSource(null)
        toast.success('Artículo creado')
      } else if (mode === 'edit' && selectedArticle) {
        const updated = await m.update.mutateAsync({ id: selectedArticle.id, data: payload })
        setMode('view')
        setForm(articleToForm(updated))
        toast.success('Artículo actualizado')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo guardar el artículo')
    }
  }

  async function handleDelete(): Promise<void> {
    if (!selectedArticle) return
    const ok = window.confirm(`¿Borrar el artículo "${selectedArticle.description}"?`)
    if (!ok) return
    try {
      await m.remove.mutateAsync(selectedArticle.id)
      setSelectedId(null)
      setMode('idle')
      setForm(EMPTY_FORM)
      toast.success('Artículo borrado')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo borrar el artículo')
    }
  }

  // Navegación con flechas.
  const navigateRow = useCallback(
    (delta: 1 | -1): void => {
      if (filtered.length === 0) return
      const currentIdx = selectedId
        ? filtered.findIndex((a) => a.id === selectedId)
        : -1
      let nextIdx = currentIdx + delta
      if (nextIdx < 0) nextIdx = 0
      if (nextIdx >= filtered.length) nextIdx = filtered.length - 1
      const next = filtered[nextIdx]
      if (next) selectArticle(next)
    },
    [filtered, selectedId],
  )

  // Atajos de teclado globales.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // Esc funciona siempre (incluso en inputs).
      if (e.key === 'Escape') {
        if (isEditing) {
          e.preventDefault()
          cancelEdit()
          return
        }
        if (mode === 'view') {
          setSelectedId(null)
          setMode('idle')
        }
        return
      }
      // El resto solo si no se está tipeando.
      if (isTypingInForm()) return

      const ctrlOrMeta = e.ctrlKey || e.metaKey
      if (ctrlOrMeta && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (canEditArticles) startCreate()
        return
      }
      if (ctrlOrMeta && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        if (canEditArticles && selectedArticle && mode === 'view') startEdit()
        return
      }
      if (ctrlOrMeta && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
        return
      }
      if (e.key === 'Delete') {
        if (canEditArticles && selectedArticle && mode === 'view') {
          e.preventDefault()
          void handleDelete()
        }
        return
      }
      if (e.key === 'Enter') {
        if (canEditArticles && selectedArticle && mode === 'view') {
          e.preventDefault()
          startEdit()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        navigateRow(1)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        navigateRow(-1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEditArticles, isEditing, mode, selectedArticle, navigateRow])

  // ----------------------------------------------------- Toggle de orden
  function toggleSort(key: SortKey): void {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return null
    return sortDir === 'asc' ? (
      <ChevronUp className="ml-1 inline h-3 w-3" />
    ) : (
      <ChevronDown className="ml-1 inline h-3 w-3" />
    )
  }

  // -------------------------------------------------- Imprimir / PDF / Excel
  function handlePrint(): void {
    window.print()
  }

  function handleExportPdf(): void {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const companyName = company.data?.name ?? 'Empresa'
    const today = new Date().toLocaleDateString('es-AR')
    doc.setFontSize(14)
    doc.text(`${companyName} — Listado de artículos`, 14, 16)
    doc.setFontSize(10)
    doc.text(`Fecha: ${today}`, 14, 22)
    autoTable(doc, {
      head: [['Código', 'Descripción', 'Familia', 'P. Venta', 'Stock']],
      body: filtered.map((a) => [
        a.barcode,
        a.description,
        a.familyId ? (familyName.get(a.familyId) ?? '—') : '—',
        formatCurrency(a.listPrice1),
        formatQty(a.stock),
      ]),
      startY: 26,
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 64, 175] },
    })
    const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY
      ?? 26
    doc.setFontSize(10)
    doc.text(`Total: ${filtered.length} artículo(s)`, 14, finalY + 8)
    const iso = new Date().toISOString().slice(0, 10)
    doc.save(`articulos-${iso}.pdf`)
  }

  function handleExportExcel(): void {
    const rows = [...(articles.data ?? [])]
      .sort((a, b) => a.barcode.localeCompare(b.barcode, 'es'))
      .map((a) => ({
        'Código': a.barcode,
        'Descripción': a.description,
        'Marca': a.brand ?? '',
        'Familia': a.familyId ? (familyName.get(a.familyId) ?? '') : '',
        'Proveedor': a.supplierId ? (supplierName.get(a.supplierId) ?? '') : '',
        'P. Costo': Number(a.costPrice),
        'P. Venta': Number(a.listPrice1),
        'Lista 2': Number(a.listPrice2),
        'Lista 3': Number(a.listPrice3),
        'P. Mayor': Number(a.wholesalePrice),
        'IVA': Number(a.vatRate),
        'Stock': Number(a.stock),
        'Stock Mín': Number(a.minStock),
        'Stock Ideal': Number(a.idealStock),
        'Notas': a.notes ?? '',
      }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Artículos')
    const iso = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `articulos-${iso}.xlsx`)
  }

  // --------------------------------------------------------- Render

  return (
    <div className="flex h-full flex-col gap-2">
      {/* Toolbar */}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b bg-card px-2">
        <Button
          size="sm"
          onClick={startCreate}
          disabled={!canEditArticles || isEditing}
          title="Nuevo (Ctrl+N)"
        >
          <Plus className="mr-1 h-4 w-4" />
          Nuevo
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={startEdit}
          disabled={!canEditArticles || !selectedArticle || mode !== 'view'}
          title="Modificar (Ctrl+E)"
        >
          <Pencil className="mr-1 h-4 w-4" />
          Modificar
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleDelete}
          disabled={!canEditArticles || !selectedArticle || mode !== 'view'}
          title="Borrar (Delete)"
        >
          <Trash2 className="mr-1 h-4 w-4" />
          Borrar
        </Button>
        <div className="mx-2 h-6 w-px bg-border" />
        <Button size="sm" variant="outline" onClick={handlePrint} title="Imprimir vista actual">
          <Printer className="mr-1 h-4 w-4" />
          Imprimir
        </Button>
        <Button size="sm" variant="outline" onClick={handleExportPdf} title="Exportar a PDF">
          <FileText className="mr-1 h-4 w-4" />
          PDF
        </Button>
        <Button size="sm" variant="outline" onClick={handleExportExcel} title="Exportar a Excel">
          <FileSpreadsheet className="mr-1 h-4 w-4" />
          Excel
        </Button>
        <div className="flex-1" />
        <select
          value={brandFilter}
          onChange={(e) => { setBrandFilter(e.target.value); setVerTodas(false) }}
          title="Filtrar por marca"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">Todas las marcas</option>
          {brandOptions.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e: ChangeEvent<HTMLInputElement>) => { setSearch(e.target.value); setVerTodas(false) }}
            placeholder="Buscar (Ctrl+F)…"
            className="pl-8"
          />
        </div>
      </div>

      {/* Contador + qué se muestra. StockFácil dice "1000 resultados de 2109" y
          tiene un "Mostrar todo": la misma idea, porque es lo que el comercio
          ya sabe leer y evita el susto de "me faltan artículos". */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {visibles.length === filtered.length
            ? `${filtered.length.toLocaleString('es-AR')} artículo${filtered.length === 1 ? '' : 's'}`
            : `${visibles.length.toLocaleString('es-AR')} de ${filtered.length.toLocaleString('es-AR')} resultados`}
          {totalActivos !== filtered.length && ` · ${totalActivos.toLocaleString('es-AR')} en total`}
        </span>
        {visibles.length < filtered.length && (
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={() => setVerTodas(true)}
          >
            Mostrar todos
          </button>
        )}
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={verBajas}
            onChange={(e) => { setVerBajas(e.target.checked); setVerTodas(false) }}
          />
          Incluir dados de baja
        </label>
      </div>

      {/* Grilla */}
      <Card className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div ref={tableContainerRef} className="min-h-0 flex-1 overflow-auto">
          <Table className="table-fixed">
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead
                  className="w-[9rem] cursor-pointer select-none"
                  onClick={() => toggleSort('barcode')}
                >
                  Código{sortIcon('barcode')}
                </TableHead>
                <TableHead
                  className="cursor-pointer select-none"
                  onClick={() => toggleSort('description')}
                >
                  Detalle{sortIcon('description')}
                </TableHead>
                <TableHead className="w-[7.5rem]">Marca</TableHead>
                <TableHead
                  className="w-[9rem] cursor-pointer select-none"
                  onClick={() => toggleSort('familyId')}
                >
                  Familia{sortIcon('familyId')}
                </TableHead>
                <TableHead
                  className="w-[6.5rem] cursor-pointer select-none text-right"
                  onClick={() => toggleSort('stock')}
                >
                  Stock{sortIcon('stock')}
                </TableHead>
                <TableHead
                  className="w-[7rem] cursor-pointer select-none text-right"
                  onClick={() => toggleSort('listPrice1')}
                >
                  P. Venta{sortIcon('listPrice1')}
                </TableHead>
                <TableHead className="w-[7rem] text-right">P. Lista 2</TableHead>
                <TableHead className="w-[7rem] text-right">P. Lista 3</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {articles.isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    Cargando artículos…
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground">
                    {articles.data && articles.data.length > 0
                      ? 'Sin resultados para la búsqueda actual'
                      : 'No hay artículos cargados'}
                  </TableCell>
                </TableRow>
              ) : (
                visibles.map((a) => {
                  const isSel = a.id === selectedId
                  return (
                    <TableRow
                      key={a.id}
                      data-state={isSel ? 'selected' : undefined}
                      onClick={() => selectArticle(a)}
                      onDoubleClick={() => {
                        selectArticle(a)
                        if (canEditArticles) startEdit()
                      }}
                      className={
                        'cursor-pointer hover:bg-blue-50/50 ' +
                        (isSel ? 'bg-blue-100/60 dark:bg-blue-900/40' : '')
                      }
                    >
                      <TableCell className="truncate py-0.5 font-mono text-xs">{a.barcode}</TableCell>
                      <TableCell className="truncate py-0.5" title={a.description}>
                        {a.description}
                      </TableCell>
                      <TableCell className="truncate py-0.5">{a.brand ?? ''}</TableCell>
                      <TableCell className="truncate py-0.5">
                        {a.familyId ? (familyName.get(a.familyId) ?? '—') : '—'}
                      </TableCell>
                      <TableCell className="py-0.5 text-right">
                        <Badge
                          className="px-1.5 py-0"
                          variant={stockBadgeVariant(a.stock, a.minStock, a.idealStock)}
                        >
                          {formatQty(a.stock)}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-0.5 text-right tabular-nums">
                        {formatCurrency(a.listPrice1)}
                      </TableCell>
                      <TableCell className="py-0.5 text-right tabular-nums text-muted-foreground">
                        {Number(a.listPrice2) ? formatCurrency(a.listPrice2) : ''}
                      </TableCell>
                      <TableCell className="py-0.5 text-right tabular-nums text-muted-foreground">
                        {Number(a.listPrice3) ? formatCurrency(a.listPrice3) : ''}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Panel de detalle / formulario */}
      <Card className="flex h-[36%] min-h-[240px] flex-shrink-0 flex-col overflow-hidden border-t-2">
        {mode === 'idle' ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Seleccioná un artículo de la lista o presioná <kbd className="mx-1 rounded border bg-muted px-1">Nuevo</kbd>.
          </div>
        ) : (
          <>
            <ArticuloForm
              mode={mode}
              form={form}
              setField={setField}
              families={families.data ?? []}
              suppliers={suppliers.data ?? []}
              inputsDisabled={inputsDisabled}
              canEditArticles={canEditArticles}
              onSave={handleSave}
              onCancel={cancelEdit}
              saving={m.create.isPending || m.update.isPending}
              articleId={selectedArticle?.id ?? null}
              imagePath={selectedArticle?.imagePath ?? null}
              pendingImageSource={pendingImageSource}
              onPendingImageChange={setPendingImageSource}
              onQuickCreateSupplier={() => setQuickCreate('supplier')}
              onQuickCreateFamily={() => setQuickCreate('family')}
            />
            {mode === 'view' && selectedArticle && (
              <ArticlePriceHistorySection articleId={selectedArticle.id} />
            )}
          </>
        )}
      </Card>

      <QuickCreateSupplierDialog
        open={quickCreate === 'supplier'}
        onClose={() => setQuickCreate(null)}
        onCreated={(id) => {
          setForm((f) => ({ ...f, supplierId: id }))
          setQuickCreate(null)
        }}
      />
      <QuickCreateFamilyDialog
        open={quickCreate === 'family'}
        onClose={() => setQuickCreate(null)}
        onCreated={(id) => {
          setForm((f) => ({ ...f, familyId: id }))
          setQuickCreate(null)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Sub-componente: formulario                                          */
/* ------------------------------------------------------------------ */

interface ArticuloFormProps {
  mode: Exclude<Mode, 'idle'>
  form: FormState
  setField: <K extends keyof FormState>(key: K, value: FormState[K]) => void
  families: FamilyDTO[]
  suppliers: SupplierDTO[]
  inputsDisabled: boolean
  canEditArticles: boolean
  onSave: () => void
  onCancel: () => void
  saving: boolean
  articleId: string | null
  imagePath: string | null
  pendingImageSource: string | null
  onPendingImageChange: (path: string | null) => void
  onQuickCreateSupplier: () => void
  onQuickCreateFamily: () => void
}

function ArticuloForm(props: ArticuloFormProps): React.ReactElement {
  const {
    mode,
    form,
    setField,
    families,
    suppliers,
    inputsDisabled,
    canEditArticles,
    onSave,
    onCancel,
    saving,
    articleId,
    imagePath,
    pendingImageSource,
    onPendingImageChange,
    onQuickCreateSupplier,
    onQuickCreateFamily,
  } = props

  return (
    <div className="flex h-full flex-col p-3">
      {/* Cabecera del panel */}
      <div className="mb-2 flex shrink-0 items-center justify-between">
        <div className="text-sm font-medium">
          {mode === 'view' && 'Detalle del artículo'}
          {mode === 'edit' && 'Editando artículo'}
          {mode === 'create' && 'Nuevo artículo'}
        </div>
      </div>

      {/* Grid del formulario */}
      <div className="grid min-h-0 flex-1 grid-cols-12 gap-3 overflow-auto">
        {/* Fila 1: id */}
        <Field className="col-span-3" label="Código">
          <Input
            value={form.barcode}
            onChange={(e) => setField('barcode', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-6" label="Descripción">
          <Input
            value={form.description}
            onChange={(e) => setField('description', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="Familia">
          <SelectWithQuickCreate
            value={form.familyId || null}
            onChange={(id) => setField('familyId', id)}
            options={families.map((f) => ({ id: f.id, label: f.name }))}
            onCreate={onQuickCreateFamily}
            disabled={inputsDisabled}
          />
        </Field>

        {/* Fila 2: clasificación */}
        <Field className="col-span-3" label="Proveedor">
          <SelectWithQuickCreate
            value={form.supplierId || null}
            onChange={(id) => setField('supplierId', id)}
            options={suppliers.map((s) => ({ id: s.id, label: `${s.code} — ${s.name}` }))}
            onCreate={onQuickCreateSupplier}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="Marca *">
          <Input
            value={form.brand}
            onChange={(e) => setField('brand', e.target.value)}
            disabled={inputsDisabled}
            placeholder="Obligatoria"
          />
        </Field>
        <div className="col-span-2" />
        <Field className="col-span-2" label="IVA">
          <Select
            value={form.vatRate}
            onChange={(e) => setField('vatRate', e.target.value)}
            disabled={inputsDisabled}
          >
            {VAT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field className="col-span-2" label="Unidad">
          <Select
            value={form.unit}
            onChange={(e) => setField('unit', e.target.value as Unit)}
            disabled={inputsDisabled}
          >
            {UNIT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        {/* Fila 3: costo + Lista 1 */}
        <Field className="col-span-3" label="P. Costo">
          <CurrencyInput
            value={form.costPrice}
            onChange={(v) => setField('costPrice', v)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="P. Venta (Lista 1)">
          <CurrencyInput
            value={form.listPrice1}
            onChange={(v) => setField('listPrice1', v)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-2" label="Utilidad">
          <ReadonlyValue>{utilPct(form.listPrice1, form.costPrice)}</ReadonlyValue>
        </Field>
        <div className="col-span-4" />

        {/* Fila 4: Lista 2 + Lista 3 */}
        <Field className="col-span-3" label="P. Lista 2">
          <CurrencyInput
            value={form.listPrice2}
            onChange={(v) => setField('listPrice2', v)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-2" label="Utilidad">
          <ReadonlyValue>{utilPct(form.listPrice2, form.costPrice)}</ReadonlyValue>
        </Field>
        <Field className="col-span-3" label="P. Lista 3">
          <CurrencyInput
            value={form.listPrice3}
            onChange={(v) => setField('listPrice3', v)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-2" label="Utilidad">
          <ReadonlyValue>{utilPct(form.listPrice3, form.costPrice)}</ReadonlyValue>
        </Field>
        <div className="col-span-2" />

        {/* Fila 5: mayorista */}
        <Field className="col-span-3" label="P. Mayor">
          <CurrencyInput
            value={form.wholesalePrice}
            onChange={(v) => setField('wholesalePrice', v)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-2" label="Utilidad">
          <ReadonlyValue>{utilPct(form.wholesalePrice, form.costPrice)}</ReadonlyValue>
        </Field>
        <Field className="col-span-3" label="Cant. mín. mayorista">
          <Input
            type="number"
            step="0.001"
            value={form.wholesaleMinQty}
            onChange={(e) => setField('wholesaleMinQty', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <div className="col-span-4" />

        {/* Fila 6: stock */}
        <Field className="col-span-3" label="Stock">
          <Input
            type="number"
            step="0.001"
            value={form.stock}
            onChange={(e) => setField('stock', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="Stock Mín">
          <Input
            type="number"
            step="0.001"
            value={form.minStock}
            onChange={(e) => setField('minStock', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="Stock Ideal">
          <Input
            type="number"
            step="0.001"
            value={form.idealStock}
            onChange={(e) => setField('idealStock', e.target.value)}
            disabled={inputsDisabled}
          />
        </Field>
        <Field className="col-span-3" label="Venta por peso">
          <label className="inline-flex h-9 items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.soldByWeight}
              onChange={(e) => setField('soldByWeight', e.target.checked)}
              disabled={inputsDisabled}
            />
            <span>Se vende por peso</span>
          </label>
        </Field>

        {/* Fila 7: notas + imagen */}
        <Field className="col-span-8" label="Notas">
          <textarea
            value={form.notes}
            onChange={(e) => setField('notes', e.target.value)}
            disabled={inputsDisabled}
            rows={4}
            className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </Field>
        <div className="col-span-4">
          <Label className="mb-1 block text-xs text-muted-foreground">Imagen</Label>
          <ArticleImagePicker
            articleId={articleId}
            imagePath={imagePath}
            disabled={!canEditArticles || (mode !== 'edit' && mode !== 'create')}
            pendingSource={pendingImageSource}
            onPendingChange={onPendingImageChange}
            isCreating={mode === 'create'}
          />
        </div>
      </div>

      {(mode === 'edit' || mode === 'create') && (
        <div className="mt-3 flex shrink-0 items-center justify-start gap-2 border-t pt-3">
          <Button variant="outline" onClick={onCancel} disabled={saving}>
            <X className="mr-1 h-4 w-4" />
            Cancelar
          </Button>
          <Button onClick={onSave} disabled={saving}>
            Guardar
          </Button>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Helpers visuales                                                    */
/* ------------------------------------------------------------------ */

function Field(props: {
  className?: string
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className={props.className}>
      <Label className="mb-1 block text-xs text-muted-foreground">{props.label}</Label>
      {props.children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Historial de precios del artículo (últimos 10 cambios)              */
/* ------------------------------------------------------------------ */

const PRICE_FIELD_LABELS: Record<string, string> = {
  costPrice: 'Costo',
  listPrice1: 'Lista 1',
  listPrice2: 'Lista 2',
  listPrice3: 'Lista 3',
  wholesalePrice: 'Mayorista',
}

function ArticlePriceHistorySection({ articleId }: { articleId: string }): React.ReactElement | null {
  const history = useArticlePriceHistory(articleId, 10)
  if (history.isLoading) return null
  if (!history.data || history.data.length === 0) return null
  return (
    <div className="border-t p-3">
      <div className="mb-2 text-sm font-medium">Últimos cambios de precio</div>
      <div className="max-h-48 overflow-auto rounded border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead>Fecha</TableHead>
              <TableHead>Campo</TableHead>
              <TableHead className="text-right">Anterior</TableHead>
              <TableHead className="text-right">Nuevo</TableHead>
              <TableHead>Usuario</TableHead>
              <TableHead>Lote</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs">
                  {new Date(e.appliedAt).toLocaleString('es-AR')}
                </TableCell>
                <TableCell>{PRICE_FIELD_LABELS[e.field] ?? e.field}</TableCell>
                <TableCell className="text-right">{Number(e.oldValue).toFixed(2)}</TableCell>
                <TableCell className="text-right">{Number(e.newValue).toFixed(2)}</TableCell>
                <TableCell className="text-xs">{e.userName}</TableCell>
                <TableCell className="text-xs">
                  {e.batchDescription}
                  {e.rolledBackAt != null && <span className="ml-1 text-amber-700">(revertido)</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function ReadonlyValue({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex h-9 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Selector de imagen                                                  */
/* ------------------------------------------------------------------ */

interface ArticleImagePickerProps {
  articleId: string | null
  imagePath: string | null
  disabled: boolean
  pendingSource: string | null
  onPendingChange: (path: string | null) => void
  isCreating: boolean
}

function ArticleImagePicker(props: ArticleImagePickerProps): React.ReactElement {
  const { articleId, imagePath, disabled, pendingSource, onPendingChange, isCreating } = props
  const qc = useQueryClient()

  const imgQuery = useQuery({
    queryKey: ['articleImage', articleId],
    queryFn: async () => {
      if (!articleId) return { dataUrl: null }
      return api.articles.getImageDataUrl(articleId)
    },
    enabled: !!articleId && !!imagePath,
  })

  async function pickAndUpload(): Promise<void> {
    try {
      const { filePath } = await api.system.pickImage()
      if (!filePath) return
      if (isCreating || !articleId) {
        // Se sube después de crear el artículo.
        onPendingChange(filePath)
        toast.info('La imagen se subirá al guardar el artículo')
        return
      }
      await api.articles.uploadImage(articleId, filePath)
      await qc.invalidateQueries({ queryKey: ['articleImage', articleId] })
      await qc.invalidateQueries({ queryKey: ['articles'] })
      toast.success('Imagen actualizada')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo cargar la imagen')
    }
  }

  async function remove(): Promise<void> {
    if (!articleId) {
      onPendingChange(null)
      return
    }
    try {
      await api.articles.removeImage(articleId)
      await qc.invalidateQueries({ queryKey: ['articleImage', articleId] })
      await qc.invalidateQueries({ queryKey: ['articles'] })
      toast.success('Imagen quitada')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'No se pudo quitar la imagen')
    }
  }

  const dataUrl = imgQuery.data?.dataUrl ?? null
  const hasImage = !!imagePath || !!pendingSource

  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-md border border-dashed bg-muted text-xs text-muted-foreground">
        {pendingSource ? (
          <span className="px-2 text-center">Imagen seleccionada — se subirá al guardar</span>
        ) : dataUrl ? (
          <img src={dataUrl} alt="Artículo" className="h-full w-full object-contain" />
        ) : imagePath && imgQuery.isLoading ? (
          <span>Cargando…</span>
        ) : (
          <span className="text-center">Sin imagen</span>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={pickAndUpload}
        >
          {hasImage ? 'Cambiar' : 'Cargar imagen'}
        </Button>
        {hasImage && (
          <Button size="sm" variant="outline" disabled={disabled} onClick={remove}>
            Quitar
          </Button>
        )}
      </div>
    </div>
  )
}
