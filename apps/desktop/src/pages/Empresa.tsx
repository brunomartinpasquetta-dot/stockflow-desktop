import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Link2, Loader2, RefreshCw, Search, UploadCloud } from 'lucide-react'

import { api, ApiError } from '@/lib/api'
import { useCompany } from '@/lib/hooks'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ArticleDTO, CompanyDTO, PriceMode } from '@/types/api'

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
  /** Integración con el catálogo web (vacío = sin catálogo). */
  catalogoUrl: string
  catalogoToken: string
  /** Dirección pública de la tienda, si no es la misma que la del catálogo. */
  catalogoWebUrl: string
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
    catalogoUrl: c.catalogoUrl ?? '',
    catalogoToken: c.catalogoToken ?? '',
    catalogoWebUrl: c.catalogoWebUrl ?? '',
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
        catalogoUrl: form.catalogoUrl.trim() || null,
        catalogoToken: form.catalogoToken.trim() || null,
        catalogoWebUrl: form.catalogoWebUrl.trim() || null,
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
          <div className="col-span-2 mt-2 flex flex-col gap-2 border-t pt-3">
            <div className="text-sm font-medium">Catálogo web (integración)</div>
            <p className="text-xs text-muted-foreground">
              Si el comercio tiene su catálogo web de StockFlow, al cargar estos datos la pantalla de
              Estadísticas incorpora la pestaña con las visitas, los productos más vistos y las búsquedas.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="emp-cat-url">Dirección del catálogo</Label>
                <Input id="emp-cat-url" placeholder="https://catalogo.sucomercio.com.ar" value={form.catalogoUrl} onChange={(e) => set('catalogoUrl', e.target.value)} />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="emp-cat-token">Clave de acceso</Label>
                <Input id="emp-cat-token" value={form.catalogoToken} onChange={(e) => set('catalogoToken', e.target.value)} />
              </div>
              <div className="col-span-2 flex flex-col gap-1">
                <Label htmlFor="emp-cat-web">Dirección pública de la tienda (sólo si es distinta)</Label>
                <Input
                  id="emp-cat-web"
                  placeholder="Vacío = la misma dirección del catálogo"
                  value={form.catalogoWebUrl}
                  onChange={(e) => set('catalogoWebUrl', e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Es la que se muestra en Catálogo web → Ver catálogo, tal como la ve el cliente.
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              La publicación de los artículos se maneja en Configuración → Catálogo web.
            </p>
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
            Define cómo se interpretan los precios cargados en los artículos y cómo se calcula el IVA en los comprobantes.
          </p>
          <div className="flex flex-col gap-2">
            <PriceModeOption
              checked={form.priceMode === 'gross'}
              onSelect={() => set('priceMode', 'gross')}
              title="Precios con IVA incluido (recomendado para venta al consumidor final)"
              subtitle="Los precios cargados en artículos YA incluyen el IVA. Es lo más común en kioscos, despensas, ferreterías minoristas."
            />
            <PriceModeOption
              checked={form.priceMode === 'net'}
              onSelect={() => set('priceMode', 'net')}
              title="Precios netos + IVA aparte (para venta entre empresas)"
              subtitle="Los precios cargados son netos; el sistema agrega el IVA al vender. Para responsables inscriptos que facturan a otras empresas."
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
                Si está activo, se puede vender aunque no haya stock suficiente (el stock queda en
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
            Se va a cambiar el modo de precios a{' '}
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

/**
 * ESPEJO DEL CATÁLOGO: el sistema publica sus artículos en el catálogo web.
 *
 * Se muestra acá, debajo de la dirección y la clave, porque sin esos datos no
 * hay nada que hacer. El estado se refresca solo: el que empuja es un reloj del
 * proceso principal, no esta pantalla.
 */
export function EspejoCatalogo(): React.ReactElement {
  const qc = useQueryClient()
  const estado = useQuery({
    queryKey: ['catalogo', 'syncEstado'],
    queryFn: () => api.catalogo.syncEstado(),
    refetchInterval: 10_000,
  })

  const activar = useMutation({
    mutationFn: (activo: boolean) => api.catalogo.syncActivar(activo),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['catalogo', 'syncEstado'] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo cambiar'),
  })

  const configurar = useMutation({
    mutationFn: (crearFaltantes: boolean) => api.catalogo.syncConfigurar(crearFaltantes),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['catalogo', 'syncEstado'] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo cambiar'),
  })

  const publicar = useMutation({
    mutationFn: (todo: boolean) => api.catalogo.syncAhora(todo),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['catalogo', 'syncEstado'] })
      if (!r.ok) toast.error(`No se pudo publicar: ${r.motivo ?? 'error desconocido'}`, { duration: 10_000 })
      else if (r.publicados === 0) toast.info('No había cambios para publicar')
      else toast.success(`Se publicaron ${r.publicados} artículos${r.pendientes > 0 ? `, quedan ${r.pendientes}` : ''}`)
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo publicar'),
  })

  const e = estado.data
  const trabajando = publicar.isPending || activar.isPending || configurar.isPending

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-md border p-3">
      <label className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={e?.activo ?? false}
          disabled={trabajando}
          onChange={(ev) => activar.mutate(ev.target.checked)}
        />
        <span className="font-medium">Publicar los artículos en el catálogo</span>
      </label>
      <p className="text-xs text-muted-foreground">
        El sistema mantiene actualizados en el catálogo el código, el nombre, el precio y el stock.
        Las fotos, las categorías y las descripciones se siguen manejando desde el catálogo.
      </p>

      {e?.activo && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={e.crearFaltantes}
            disabled={trabajando}
            onChange={(ev) => configurar.mutate(ev.target.checked)}
          />
          <span>
            Crear en el catálogo los artículos activos que todavía no existen allá
            <span className="block text-xs text-muted-foreground">
              Quedan ocultos hasta que se completen en el panel del catálogo. Los artículos dados de baja nunca se crean.
            </span>
          </span>
        </label>
      )}

      {e?.activo && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className={e.pendientes > 0 ? 'text-amber-600' : 'text-muted-foreground'}>
            {e.pendientes > 0 ? `${e.pendientes} artículos por publicar` : 'Todo publicado'}
          </span>
          {e.ultimoExito != null && (
            <span className="text-muted-foreground">
              Última publicación: {formatDateTime(e.ultimoExito)}
            </span>
          )}
          {e.publicadosTotal > 0 && (
            <span className="text-muted-foreground">{e.publicadosTotal} enviados en total</span>
          )}
        </div>
      )}

      {e?.ultimoError && (
        <p className="text-xs text-destructive">Último error: {e.ultimoError}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={trabajando} onClick={() => publicar.mutate(false)}>
          {publicar.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
          Publicar ahora
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={trabajando}
          title="Vuelve a mandar TODOS los artículos, no solo los que cambiaron"
          onClick={() => {
            if (window.confirm('¿Volver a publicar todos los artículos en el catálogo?')) publicar.mutate(true)
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Republicar todo
        </Button>
        <VincularArticulosDialog />
      </div>
    </div>
  )
}

/**
 * VINCULACIÓN — el `codigo_sistema` es lo único que une un producto del
 * catálogo con un artículo del sistema. Sin vincular, el producto NO recibe
 * stock ni precio del espejo, y un pedido de ese producto no descuenta nada.
 *
 * El apareo automático es SOLO por nombre idéntico y SOLO cuando coincide con
 * un único artículo — un nombre ambiguo (coincide con más de uno, o con
 * ninguno) queda para resolver a mano, nunca se adivina.
 */
function VincularArticulosDialog(): React.ReactElement {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busquedaManual, setBusquedaManual] = useState<Record<string, string>>({})

  const sugerencia = useQuery({
    queryKey: ['catalogo', 'sugerirVinculacion'],
    queryFn: () => api.catalogo.sugerirVinculacion(),
    enabled: open,
  })

  const vincularAuto = useMutation({
    mutationFn: () =>
      api.catalogo.vincularLote(
        (sugerencia.data?.sugeridos ?? []).map((s) => ({ sku: s.sku, codigoSistema: s.codigo })),
      ),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(`No se pudo vincular: ${r.motivo ?? 'error desconocido'}`, { duration: 10_000 })
        return
      }
      toast.success(`Se vincularon ${r.vinculados} artículos por nombre`)
      if (r.errores.length > 0) {
        toast.warning(`${r.errores.length} no se pudieron vincular (código ya usado por otro producto)`, { duration: 10_000 })
      }
      void qc.invalidateQueries({ queryKey: ['catalogo', 'sugerirVinculacion'] })
      void qc.invalidateQueries({ queryKey: ['catalogo', 'syncEstado'] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo vincular'),
  })

  const vincularUno = useMutation({
    mutationFn: (v: { sku: string; codigoSistema: string }) => api.catalogo.vincularLote([v]),
    onSuccess: (r, v) => {
      if (!r.ok || r.errores.length > 0) {
        toast.error(r.errores[0]?.motivo ?? r.motivo ?? 'No se pudo vincular ese artículo')
        return
      }
      toast.success('Artículo vinculado')
      setBusquedaManual((prev) => {
        const next = { ...prev }
        delete next[v.sku]
        return next
      })
      void qc.invalidateQueries({ queryKey: ['catalogo', 'sugerirVinculacion'] })
      void qc.invalidateQueries({ queryKey: ['catalogo', 'syncEstado'] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'No se pudo vincular'),
  })

  const s = sugerencia.data

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Link2 className="h-4 w-4" />
        Vincular artículos
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Vincular artículos del catálogo</DialogTitle>
          </DialogHeader>

          {sugerencia.isLoading && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Comparando el catálogo con los artículos del sistema…
            </p>
          )}

          {sugerencia.isError && (
            <p className="py-4 text-sm text-destructive">
              No se pudo consultar el catálogo. Verifique la dirección y la clave, o que esté en línea.
            </p>
          )}

          {s && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                El catálogo tiene {s.totalCatalogo} productos; {s.totalSinVincular} todavía sin vincular a un
                artículo del sistema. Vinculado un producto, el espejo le mantiene el precio y el stock
                actualizados — el nombre, la foto y la categoría siguen siendo del catálogo.
              </p>

              {s.sugeridos.length > 0 && (
                <div className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {s.sugeridos.length} coinciden por nombre con un único artículo
                    </span>
                    <Button size="sm" disabled={vincularAuto.isPending} onClick={() => vincularAuto.mutate()}>
                      {vincularAuto.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                      Vincular estos {s.sugeridos.length}
                    </Button>
                  </div>
                  <ul className="max-h-32 overflow-y-auto text-xs text-muted-foreground">
                    {s.sugeridos.slice(0, 30).map((it) => (
                      <li key={it.sku} className="truncate">{it.nombreSistema}</li>
                    ))}
                    {s.sugeridos.length > 30 && <li>… y {s.sugeridos.length - 30} más</li>}
                  </ul>
                </div>
              )}

              {s.sinCandidato.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="text-sm font-medium">
                    {s.sinCandidato.length} sin coincidencia por nombre — vincular a mano
                  </span>
                  <div className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-md border">
                    {s.sinCandidato.map((p) => (
                      <FilaVinculacionManual
                        key={p.sku}
                        nombre={p.nombre}
                        query={busquedaManual[p.sku] ?? ''}
                        onQuery={(q) => setBusquedaManual((prev) => ({ ...prev, [p.sku]: q }))}
                        onVincular={(codigo) => vincularUno.mutate({ sku: p.sku, codigoSistema: codigo })}
                        vinculando={vincularUno.isPending}
                      />
                    ))}
                  </div>
                </div>
              )}

              {s.sugeridos.length === 0 && s.sinCandidato.length === 0 && (
                <p className="text-sm text-muted-foreground">Todo el catálogo ya está vinculado.</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Una fila de vinculación manual: busca un artículo del sistema por texto y lo liga a este producto del catálogo. */
function FilaVinculacionManual({
  nombre,
  query,
  onQuery,
  onVincular,
  vinculando,
}: {
  nombre: string
  query: string
  onQuery: (q: string) => void
  onVincular: (codigo: string) => void
  vinculando: boolean
}) {
  const busqueda = useQuery({
    queryKey: ['articles', 'search', query],
    queryFn: () => api.articles.searchByText(query),
    enabled: query.trim().length >= 2,
  })
  const resultados: ArticleDTO[] = query.trim().length >= 2 ? (busqueda.data ?? []).slice(0, 6) : []

  return (
    <div className="flex flex-col gap-1.5 p-2.5">
      <span className="text-sm">{nombre}</span>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="h-8 pl-7 text-xs"
          placeholder="Buscar artículo del sistema por nombre o código…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      {resultados.length > 0 && (
        <div className="flex flex-col gap-1">
          {resultados.map((a) => (
            <button
              key={a.id}
              type="button"
              disabled={vinculando}
              onClick={() => onVincular(a.barcode)}
              className="flex items-center justify-between rounded border px-2 py-1 text-left text-xs hover:bg-accent"
            >
              <span className="truncate">{a.description}</span>
              <span className="ml-2 shrink-0 font-mono text-muted-foreground">{a.barcode}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
