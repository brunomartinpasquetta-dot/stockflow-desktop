import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useCompany } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { CompanyDTO, PriceMode } from '@/types/api'

interface FormState {
  name: string
  address: string
  phone: string
  email: string
  cuit: string
  ingBrutos: string
  priceMode: PriceMode
  allowNegativeStock: boolean
  /** Logo para la factura, como data URL. `null` = sin logo. */
  logoDataUrl: string | null
}

function fromCompany(c: CompanyDTO): FormState {
  return {
    name: c.name,
    address: c.address ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    cuit: c.cuit ?? '',
    ingBrutos: c.ingBrutos ?? '',
    priceMode: c.priceMode,
    allowNegativeStock: c.allowNegativeStock,
    logoDataUrl: c.logoDataUrl ?? null,
  }
}

/** Máximo del logo guardado. Se reescala antes de guardar: una foto de celular
 *  de 4 MB en la base engorda cada backup y no mejora nada impresa. */
const LOGO_MAX_PX = 400

/** Lee la imagen elegida, la reescala y devuelve el data URL listo para guardar. */
async function leerLogo(file: File): Promise<string> {
  const original = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('No se pudo leer la imagen'))
    r.readAsDataURL(file)
  })
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('El archivo no es una imagen válida'))
    img.src = original
  })
  const escala = Math.min(1, LOGO_MAX_PX / Math.max(img.width, img.height))
  if (escala === 1 && original.length < 200_000) return original
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * escala)
  canvas.height = Math.round(img.height * escala)
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}

function PriceModeOption({
  checked,
  onSelect,
  title,
  subtitle,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  subtitle: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        checked ? 'border-primary bg-primary/5' : 'hover:bg-accent',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary' : 'border-input',
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{subtitle}</span>
      </span>
    </button>
  )
}

function EmpresaForm({ company }: { company: CompanyDTO }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<FormState>(() => fromCompany(company))
  const [confirmOpen, setConfirmOpen] = useState(false)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }))
  const modeChanged = form.priceMode !== company.priceMode

  const mutation = useMutation({
    mutationFn: () =>
      api.company.upsert({
        name: form.name.trim(),
        address: form.address.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        cuit: form.cuit.trim() || null,
        logoDataUrl: form.logoDataUrl,
        ingBrutos: form.ingBrutos.trim() || null,
        priceMode: form.priceMode,
        allowNegativeStock: form.allowNegativeStock,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['company'] })
      toast.success('Datos de la empresa guardados')
      setConfirmOpen(false)
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'No se pudieron guardar los datos'),
  })

  function onSave(): void {
    if (!form.name.trim()) {
      toast.error('El nombre de la empresa es obligatorio')
      return
    }
    if (modeChanged) {
      setConfirmOpen(true)
      return
    }
    mutation.mutate()
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <h1 className="text-lg font-semibold">Mi Empresa</h1>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Datos de la empresa</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="emp-name">Nombre / Razón social</Label>
            <Input id="emp-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="emp-address">Domicilio</Label>
            <Input id="emp-address" value={form.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="emp-cuit">CUIT</Label>
            <Input id="emp-cuit" value={form.cuit} onChange={(e) => set('cuit', e.target.value)} placeholder="30-12345678-3" />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="emp-iibb">Ingresos Brutos</Label>
            <Input id="emp-iibb" value={form.ingBrutos} onChange={(e) => set('ingBrutos', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="emp-phone">Teléfono</Label>
            <Input id="emp-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="emp-email">Email</Label>
            <Input id="emp-email" value={form.email} onChange={(e) => set('email', e.target.value)} />
          </div>

          {/* Logo: sale impreso arriba a la izquierda en la factura A4 y en el
              PDF que se archiva. Se guarda dentro de la base, así viaja con el
              backup y no se rompe si alguien mueve el archivo. */}
          <div className="col-span-2 flex flex-col gap-1.5">
            <Label>Logo para la factura</Label>
            <div className="flex items-center gap-3">
              <div className="flex h-20 w-40 items-center justify-center rounded-md border bg-muted/30">
                {form.logoDataUrl ? (
                  <img src={form.logoDataUrl} alt="Logo" className="max-h-[72px] max-w-[150px] object-contain" />
                ) : (
                  <span className="text-xs text-muted-foreground">Sin logo</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    e.target.value = ''
                    if (!file) return
                    void leerLogo(file)
                      .then((url) => set('logoDataUrl', url))
                      .catch((err: Error) => toast.error(err.message))
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={() => logoInputRef.current?.click()}>
                  {form.logoDataUrl ? 'Cambiar logo…' : 'Elegir logo…'}
                </Button>
                {form.logoDataUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => set('logoDataUrl', null)}>
                    Quitar
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">PNG o JPG. Se achica solo.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Configuración de precios</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Definí cómo se interpretan los precios que cargás en los artículos y cómo se calcula el IVA en los comprobantes.
          </p>
          <div className="flex flex-col gap-2">
            <PriceModeOption
              checked={form.priceMode === 'gross'}
              onSelect={() => set('priceMode', 'gross')}
              title="Precios con IVA incluido (recomendado para venta al consumidor final)"
              subtitle="Los precios que cargás en artículos YA incluyen el IVA. Es lo más común en kioscos, despensas, ferreterías minoristas."
            />
            <PriceModeOption
              checked={form.priceMode === 'net'}
              onSelect={() => set('priceMode', 'net')}
              title="Precios netos + IVA aparte (para venta entre empresas)"
              subtitle="Los precios que cargás son netos, el sistema agrega el IVA al vender. Para responsables inscriptos que facturan a otras empresas."
            />
          </div>

          <label className="flex items-start gap-2 rounded-lg border px-3 py-2.5">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.allowNegativeStock}
              onChange={(e) => set('allowNegativeStock', e.target.checked)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">Permitir vender sin stock</span>
              <span className="text-xs text-muted-foreground">
                Si está activo, podés vender aunque no haya stock suficiente (el stock queda en
                negativo, como faltante). Si lo desactivás, la venta se bloquea cuando falta stock.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={onSave} disabled={mutation.isPending}>
          {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          Guardar
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={(o) => { if (!o) setConfirmOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cambiar el modo de precios</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Vas a cambiar el modo de precios a{' '}
            <span className="font-medium text-foreground">
              {form.priceMode === 'gross' ? 'precios con IVA incluido' : 'precios netos + IVA aparte'}
            </span>
            . Esto afecta cómo se calculan los <strong>nuevos</strong> comprobantes. Los comprobantes existentes mantienen su cálculo original.
            ¿Continuar?
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={mutation.isPending}>
              Cancelar
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function Empresa() {
  const company = useCompany()
  if (company.isLoading || !company.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  return <EmpresaForm company={company.data} />
}
