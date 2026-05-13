import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Upload, ChevronRight, ChevronLeft } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import type { ImportMappingDTO, ImportOptionsDTO, ImportValidationResultDTO } from '@/types/api'

type Step = 'pick' | 'map' | 'validate' | 'execute'

interface ParsedFile {
  filePath: string
  sheets: string[]
  preview: Array<Record<string, unknown>>
  headers: string[]
  totalRows: number
}

const REQUIRED_FIELDS: Array<keyof ImportMappingDTO> = ['barcode', 'description', 'listPrice1', 'stock']
const OPTIONAL_FIELDS: Array<keyof ImportMappingDTO> = ['brand', 'familyName', 'supplierName', 'costPrice', 'vatRate', 'minStock']

const FIELD_LABELS: Record<keyof ImportMappingDTO, string> = {
  barcode: 'Código de barras',
  description: 'Descripción',
  listPrice1: 'Precio de lista 1',
  stock: 'Stock inicial',
  brand: 'Marca',
  familyName: 'Familia (nombre)',
  supplierName: 'Proveedor (nombre)',
  costPrice: 'Precio de costo',
  vatRate: 'Alícuota IVA',
  minStock: 'Stock mínimo',
}

export function ImportarStock() {
  const [step, setStep] = useState<Step>('pick')
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [parseLoading, setParseLoading] = useState(false)
  const [mapping, setMapping] = useState<Partial<Record<keyof ImportMappingDTO, string>>>({})
  const [options, setOptions] = useState<ImportOptionsDTO>({
    createMissingFamilies: true,
    createMissingSuppliers: true,
    skipRowsWithErrors: true,
  })
  const [validation, setValidation] = useState<ImportValidationResultDTO | null>(null)
  const [validating, setValidating] = useState(false)
  const [executing, setExecuting] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<{ created: number; skipped: number; familiesCreated: number; suppliersCreated: number } | null>(null)

  async function onPickFile(): Promise<void> {
    setParseLoading(true)
    try {
      const picked = await api.system.pickFile([{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }])
      if (!picked.filePath) {
        setParseLoading(false)
        return
      }
      const data = await api.import.parseFile(picked.filePath)
      setParsed({ filePath: picked.filePath, ...data })
      // Auto-mapping heurístico por nombres comunes
      const initial: Partial<Record<keyof ImportMappingDTO, string>> = {}
      for (const h of data.headers) {
        const lower = h.toLowerCase()
        if (/cod|barra|sku|ean/.test(lower) && !initial.barcode) initial.barcode = h
        else if (/desc|nombre|articulo|producto/.test(lower) && !initial.description) initial.description = h
        else if (/precio.*venta|pvp|lista|precio$/.test(lower) && !initial.listPrice1) initial.listPrice1 = h
        else if (/stock|cantidad|existencia/.test(lower) && !initial.stock) initial.stock = h
        else if (/marca/.test(lower) && !initial.brand) initial.brand = h
        else if (/familia|rubro|categor/.test(lower) && !initial.familyName) initial.familyName = h
        else if (/proveedor/.test(lower) && !initial.supplierName) initial.supplierName = h
        else if (/costo/.test(lower) && !initial.costPrice) initial.costPrice = h
        else if (/iva|alic/.test(lower) && !initial.vatRate) initial.vatRate = h
        else if (/min|reposic/.test(lower) && !initial.minStock) initial.minStock = h
      }
      setMapping(initial)
      setStep('map')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo leer el archivo')
    } finally {
      setParseLoading(false)
    }
  }

  async function onValidate(): Promise<void> {
    if (!parsed) return
    for (const f of REQUIRED_FIELDS) {
      if (!mapping[f]) {
        toast.error(`Tenés que mapear el campo "${FIELD_LABELS[f]}"`)
        return
      }
    }
    setValidating(true)
    setValidation(null)
    try {
      const fullMapping: ImportMappingDTO = {
        barcode: mapping.barcode!,
        description: mapping.description!,
        listPrice1: mapping.listPrice1!,
        stock: mapping.stock!,
        brand: mapping.brand ?? null,
        familyName: mapping.familyName ?? null,
        supplierName: mapping.supplierName ?? null,
        costPrice: mapping.costPrice ?? null,
        vatRate: mapping.vatRate ?? null,
        minStock: mapping.minStock ?? null,
      }
      const r = await api.import.validate(parsed.filePath, fullMapping)
      setValidation(r)
      setStep('validate')
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Error de validación')
    } finally {
      setValidating(false)
    }
  }

  async function onExecute(): Promise<void> {
    if (!parsed) return
    setExecuting(true)
    setStep('execute')
    setProgress({ done: 0, total: validation?.valid ?? 0 })
    const unsub = window.stockflow.import.onProgress((p) => setProgress(p))
    try {
      const fullMapping: ImportMappingDTO = {
        barcode: mapping.barcode!,
        description: mapping.description!,
        listPrice1: mapping.listPrice1!,
        stock: mapping.stock!,
        brand: mapping.brand ?? null,
        familyName: mapping.familyName ?? null,
        supplierName: mapping.supplierName ?? null,
        costPrice: mapping.costPrice ?? null,
        vatRate: mapping.vatRate ?? null,
        minStock: mapping.minStock ?? null,
      }
      const r = await api.import.execute(parsed.filePath, fullMapping, options)
      setResult(r)
      toast.success(`Importación finalizada: ${r.created} artículos creados`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'La importación falló')
    } finally {
      unsub()
      setExecuting(false)
    }
  }

  function reset(): void {
    setStep('pick')
    setParsed(null)
    setMapping({})
    setValidation(null)
    setResult(null)
    setProgress({ done: 0, total: 0 })
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-3">
      <h1 className="text-lg font-semibold">Importar stock desde Excel</h1>

      <div className="flex items-center gap-2 text-xs">
        {(['pick', 'map', 'validate', 'execute'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${
                step === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={step === s ? 'font-medium' : 'text-muted-foreground'}>
              {s === 'pick' && 'Subir'}
              {s === 'map' && 'Mapear'}
              {s === 'validate' && 'Validar'}
              {s === 'execute' && 'Confirmar'}
            </span>
            {i < 3 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
          </div>
        ))}
      </div>

      {step === 'pick' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">1. Subir archivo</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-3 py-6">
            <Upload className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Formatos soportados: .xlsx, .xls, .csv</p>
            <Button onClick={() => void onPickFile()} disabled={parseLoading}>
              {parseLoading && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
              Seleccionar archivo
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 'map' && parsed && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">2. Mapear columnas</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Indicá qué columna del Excel corresponde a cada campo del sistema. Total de filas detectadas:{' '}
              <span className="font-medium text-foreground">{parsed.totalRows}</span>.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {[...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].map((f) => (
                <div key={f} className="flex flex-col gap-1">
                  <Label>
                    {FIELD_LABELS[f]}
                    {REQUIRED_FIELDS.includes(f) && <span className="text-destructive"> *</span>}
                  </Label>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={mapping[f] ?? ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [f]: e.target.value }))}
                  >
                    <option value="">— sin mapear —</option>
                    {parsed.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="rounded-md border">
              <Label className="block p-2 text-xs uppercase tracking-wide text-muted-foreground">
                Vista previa (primeras {parsed.preview.length} filas)
              </Label>
              <div className="max-h-60 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr>
                      {parsed.headers.map((h) => (
                        <th key={h} className="border-b px-2 py-1 text-left font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.preview.map((row, i) => (
                      <tr key={i} className="border-t">
                        {parsed.headers.map((h) => (
                          <td key={h} className="px-2 py-1">
                            {String(row[h] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.createMissingFamilies}
                  onChange={(e) => setOptions((o) => ({ ...o, createMissingFamilies: e.target.checked }))}
                />
                Crear familias faltantes
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.createMissingSuppliers}
                  onChange={(e) => setOptions((o) => ({ ...o, createMissingSuppliers: e.target.checked }))}
                />
                Crear proveedores faltantes
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={options.skipRowsWithErrors}
                  onChange={(e) => setOptions((o) => ({ ...o, skipRowsWithErrors: e.target.checked }))}
                />
                Saltear filas con errores
              </label>
            </div>

            <div className="flex justify-between">
              <Button variant="outline" onClick={reset}>
                <ChevronLeft className="mr-1 h-3 w-3" /> Cambiar archivo
              </Button>
              <Button onClick={() => void onValidate()} disabled={validating}>
                {validating && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Validar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'validate' && validation && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">3. Revisión de validación</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Filas válidas</div>
                <div className="text-2xl font-semibold text-emerald-600">{validation.valid}</div>
              </div>
              <div className="rounded-md border p-3">
                <div className="text-xs text-muted-foreground">Errores detectados</div>
                <div className="text-2xl font-semibold text-destructive">{validation.errors.length}</div>
              </div>
            </div>

            {validation.errors.length > 0 && (
              <div className="max-h-60 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40">
                    <tr>
                      <th className="px-2 py-1 text-left">Fila</th>
                      <th className="px-2 py-1 text-left">Campo</th>
                      <th className="px-2 py-1 text-left">Mensaje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {validation.errors.slice(0, 200).map((e, i) => (
                      <tr key={i} className="border-t">
                        <td className="px-2 py-1">{e.row}</td>
                        <td className="px-2 py-1">{e.field}</td>
                        <td className="px-2 py-1 text-destructive">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {validation.errors.length > 200 && (
                  <p className="border-t bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
                    Mostrando primeros 200 de {validation.errors.length} errores
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-between">
              <Button variant="outline" onClick={() => setStep('map')}>
                <ChevronLeft className="mr-1 h-3 w-3" /> Volver al mapeo
              </Button>
              <Button onClick={() => void onExecute()} disabled={validation.valid === 0 || executing}>
                {executing && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                Importar {validation.valid} fila(s)
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 'execute' && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">4. Importación</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {executing && (
              <div className="flex flex-col gap-1">
                <div className="text-sm">
                  Procesando {progress.done} de {progress.total}…
                </div>
                <div className="h-2 w-full rounded bg-muted">
                  <div
                    className="h-full rounded bg-primary transition-all"
                    style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}
            {result && (
              <div className="flex flex-col gap-2 text-sm">
                <div>Artículos creados: <span className="font-semibold text-emerald-600">{result.created}</span></div>
                <div>Saltados: {result.skipped}</div>
                <div>Familias creadas: {result.familiesCreated}</div>
                <div>Proveedores creados: {result.suppliersCreated}</div>
                <div className="pt-2">
                  <Button onClick={reset}>Importar otro archivo</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
