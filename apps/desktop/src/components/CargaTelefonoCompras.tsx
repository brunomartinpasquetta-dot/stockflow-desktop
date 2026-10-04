/**
 * Compras → «Cargar con el teléfono» (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 * Abre el QR para vincular el teléfono (el diálogo de siempre) y, mientras está
 * abierto, sigue la factura que manda ESE enlace: "Recibiendo hoja N…",
 * "Leyendo hoja N de M…". Cuando la factura queda leída:
 *  - si salió completa (`decidirAtajo`: proveedor, todo con artículo, nada en
 *    revisar, el total coincide), llena el formulario de Compras abierto;
 *  - si no, abre la revisión de esa factura (Facturas escaneadas) y espera: al
 *    terminar ahí, la factura vuelve a ESTE formulario sin recargarlo.
 * Si el formulario ya tiene renglones, pregunta antes de reemplazarlos. De acá
 * no sale ninguna compra: la confirma el usuario en Compras, como siempre.
 *
 * Sólo se monta con la opción activa: apagada, Compras no cambia en nada.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, ScanLine } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '@/lib/api'
import { mensajeError } from '@/lib/mensajeError'
import { useWindowManager } from '@/contexts/WindowManagerContext'
import { useArticles, useCompany } from '@/lib/hooks'
import { useWindowNav } from '@/lib/useWindowNav'
import {
  armarPasajeACompras,
  decidirAtajo,
  prefillDeFactura,
  textoDeSeguimiento,
  tipoDeEncabezado,
  type PrefillDeFactura,
} from '@/lib/facturaACompra'
import { VincularTelefonoDialog } from '@/components/VincularTelefonoDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { ArticleDTO, FacturaEscaneadaDetalleDTO, FacturasSeguimientoItemDTO, PriceMode } from '@/types/api'

/** Estados en los que la factura todavía se está mandando o leyendo. */
const EN_CAMINO = new Set(['recibiendo', 'en_cola', 'leyendo'])
/**
 * Cuánto se espera, como máximo, que una revisión vuelva. Pasado esto la
 * factura sigue en «Facturas escaneadas» y se deja de preguntar (una Compras
 * minimizada toda la noche no tiene por qué sondear al servidor hasta mañana).
 */
const MAXIMA_ESPERA_MS = 2 * 60 * 60_000
/** Cada cuánto se pregunta mientras se espera la revisión: seguido con la ventana a la vista, espaciado si está en segundo plano. */
const SONDEO_A_LA_VISTA_MS = 1500
const SONDEO_EN_FONDO_MS = 15_000
/** Recién abierta la revisión, la lista de ventanas puede tardar en reflejarla: no se la da por cerrada antes de esto. */
const GRACIA_VENTANA_MS = 10_000

export function CargaTelefonoCompras({
  abierto,
  onCerrar,
  hayRenglones,
  onCargar,
  pantalla,
  puedeConfigurar,
}: {
  abierto: boolean
  onCerrar: () => void
  /**
   * ¿El formulario tiene renglones AHORA? Se pregunta antes de reemplazarlos.
   * Es una función porque la decisión se toma después de pedir la factura y
   * el padrón: lo que había al disparar el pedido puede haber cambiado.
   */
  hayRenglones: () => boolean
  /** Pone la factura en el formulario (reemplaza lo que haya). `articulos` = la lista recién pedida. */
  onCargar: (prefill: PrefillDeFactura, articulos: ArticleDTO[]) => void
  /** Identificador de esta pantalla de Compras: la revisión le devuelve la factura a ÉSTA, no a la de otro puesto. */
  pantalla: string
  /** Puede abrir Configuración (si el enlace no se pudo generar). */
  puedeConfigurar: boolean
}) {
  const qc = useQueryClient()
  const openInWindow = useWindowNav()
  const ventanas = useWindowManager().windows
  const articlesQuery = useArticles()
  const companyQuery = useCompany()
  const priceMode: PriceMode = companyQuery.data?.priceMode ?? 'gross'

  /** El enlace del QR (para seguir lo que manda). */
  const [sesion, setSesion] = useState<string | null>(null)
  /** La factura que se sigue y en qué está. */
  const [seguida, setSeguida] = useState<FacturasSeguimientoItemDTO | null>(null)
  /** `revisando` = se abrió la revisión y se espera que la factura vuelva. */
  const [fase, setFase] = useState<'esperando' | 'revisando'>('esperando')
  const [motivo, setMotivo] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [trabajando, setTrabajando] = useState(false)
  const [aReemplazar, setAReemplazar] = useState<{ prefill: PrefillDeFactura; articulos: ArticleDTO[] } | null>(null)
  /** Facturas de este enlace que ya se atendieron (cargadas, mandadas a revisar, descartadas). */
  const atendidas = useRef(new Set<string>())
  /** La última vez que la revisión la mandó de vuelta y ya se cargó (no se carga dos veces). */
  const vueltaAtendida = useRef<number | null>(null)
  /** Desde cuándo se espera la revisión (tope de espera y gracia para la ventana). */
  const revisandoDesde = useRef<number | null>(null)

  const revisando = fase === 'revisando' && seguida !== null
  const seguidaId = seguida?.id ?? null
  const seguimiento = useQuery({
    queryKey: ['facturas', 'seguir', sesion, seguidaId, revisando],
    queryFn: () =>
      api.facturas.seguir({
        ...(sesion && !revisando ? { sesion } : {}),
        // La factura que ya se sigue va por id: no depende de que el enlace siga vivo.
        ...(seguidaId ? { id: seguidaId } : {}),
        ...(revisando ? { esperaRevision: true, pantalla } : {}),
      }),
    // Mientras el diálogo está abierto con un enlace, o mientras se espera la revisión.
    enabled: !trabajando && ((abierto && sesion !== null) || revisando),
    // La revisión es otra ventana: ésta puede quedar minimizada mientras se
    // espera. Minimizada, se pregunta espaciado (el servidor da la espera por
    // viva hasta 75 s sin preguntar).
    refetchInterval: () => (typeof document !== 'undefined' && document.hidden ? SONDEO_EN_FONDO_MS : SONDEO_A_LA_VISTA_MS),
    refetchIntervalInBackground: true,
    retry: false,
    gcTime: 0,
  })

  function reiniciar(): void {
    setSesion(null)
    setSeguida(null)
    setFase('esperando')
    setMotivo(null)
    setAviso(null)
    atendidas.current = new Set()
    vueltaAtendida.current = null
    revisandoDesde.current = null
  }

  function cerrar(): void {
    // Cerrar el diálogo mientras se espera la revisión no corta la espera:
    // queda el aviso arriba del formulario.
    if (fase !== 'revisando') reiniciar()
    onCerrar()
  }

  /** Los artículos de hoy (la revisión pudo crear alguno que esta ventana todavía no tiene). */
  async function articulosAlDia(d: FacturaEscaneadaDetalleDTO): Promise<ArticleDTO[]> {
    const actuales = articlesQuery.data ?? []
    const conocidos = new Set(actuales.map((a) => a.id))
    if (d.lineas.every((r) => !r.articleId || conocidos.has(r.articleId))) return actuales
    return qc.fetchQuery({ queryKey: ['articles'], queryFn: api.articles.list, staleTime: 0 })
  }

  function entregar(prefill: PrefillDeFactura, articulos: ArticleDTO[]): void {
    atendidas.current.add(prefill.facturaId)
    // Con lo que hay en el formulario AHORA (pudo cargar un renglón mientras se pedía la factura).
    if (hayRenglones()) {
      // Primero se cierra el QR: la pregunta queda sola en pantalla.
      setAReemplazar({ prefill, articulos })
      onCerrar()
      return
    }
    cargar(prefill, articulos)
  }

  function cargar(prefill: PrefillDeFactura, articulos: ArticleDTO[]): void {
    onCargar(prefill, articulos)
    toast.success('Factura cargada desde el teléfono: revise y confirme la compra.')
    reiniciar()
    onCerrar()
  }

  /** La factura quedó leída: al formulario si salió completa; si no, a la revisión. */
  async function procesar(id: string): Promise<void> {
    setTrabajando(true)
    try {
      const d = await api.facturas.obtener(id)
      const articulos = await articulosAlDia(d)
      const porId = new Map(articulos.filter((a) => a.active).map((a) => [a.id, a]))
      const decision = decidirAtajo(d, priceMode, (articleId) => {
        const a = porId.get(articleId)
        return a ? { alicuota: Number(a.vatRate), costo: Number(a.costPrice) } : null
      })
      if (decision.directo) {
        entregar(
          prefillDeFactura(
            id,
            {
              supplierId: d.supplierId,
              tipo: decision.tipo,
              ptoVta: d.header?.ptoVta ?? null,
              nroCmp: d.header?.nroCmp ?? null,
              fecha: d.header?.fecha ?? null,
              yaCargada: d.yaCargada,
            },
            decision.pasaje,
          ),
          articulos,
        )
        return
      }
      // A revisar: se abre la revisión de ESA factura y se espera que vuelva.
      atendidas.current.add(id)
      setMotivo(decision.motivo)
      setFase('revisando')
      revisandoDesde.current = Date.now()
      abrirRevision(id)
    } catch (e) {
      setAviso(mensajeError(e))
    } finally {
      setTrabajando(false)
    }
  }

  /**
   * Abre (o trae al frente) la revisión de esa factura. La ventana de Facturas
   * escaneadas recibe los `extras` sin recargarse (`extrasEnVivo`): si estaba
   * corrigiendo otra factura, guarda lo hecho y cambia.
   */
  function abrirRevision(id: string): void {
    openInWindow('facturasEscaneadas', { extras: { facturaId: id, desdeCompras: true, pantalla, lote: Date.now() } })
  }

  /** La revisión terminó y la mandó de vuelta: se arma el pasaje con lo que quedó guardado. */
  async function cargarRevisada(id: string): Promise<void> {
    setTrabajando(true)
    try {
      const d = await api.facturas.obtener(id)
      const tipo = tipoDeEncabezado(d.header)
      if (!tipo || !d.supplierId) {
        setAviso('A la factura le falta el proveedor o el tipo de comprobante. Complételos en la revisión.')
        return
      }
      const articulos = await articulosAlDia(d)
      const porId = new Map(articulos.filter((a) => a.active).map((a) => [a.id, a]))
      const pasaje = armarPasajeACompras(
        d.lineas.map((r) => ({ ...r, uxbConfirmado: r.uxbRecordado != null })),
        tipo,
        priceMode,
        (articleId) => {
          const a = porId.get(articleId)
          return a ? Number(a.vatRate) : null
        },
        (articleId) => {
          const a = porId.get(articleId)
          return a ? Number(a.costPrice) : null
        },
      )
      if (pasaje.lineas.length === 0) {
        setAviso('La factura no tiene renglones vinculados con artículos.')
        return
      }
      entregar(
        prefillDeFactura(
          id,
          {
            supplierId: d.supplierId,
            tipo,
            ptoVta: d.header?.ptoVta ?? null,
            nroCmp: d.header?.nroCmp ?? null,
            fecha: d.header?.fecha ?? null,
            yaCargada: d.yaCargada,
          },
          pasaje,
        ),
        articulos,
      )
    } catch (e) {
      setAviso(mensajeError(e))
    } finally {
      setTrabajando(false)
    }
  }

  /** Deja de esperar la revisión: la factura sigue en «Facturas escaneadas». */
  function dejarDeEsperar(porQue = 'La factura quedó en «Facturas escaneadas».'): void {
    toast.info(porQue)
    reiniciar()
    onCerrar()
  }

  // Lo que llega del sondeo. Cada cambio se atiende una sola vez (ver `atendidas`).
  const datos = seguimiento.data
  useEffect(() => {
    if (!datos || trabajando) return
    if (fase === 'revisando') {
      const f = datos.facturas.find((x) => x.id === seguida?.id)
      if (!f) return
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSeguida(f)
      if (f.enviadaACompras != null && f.enviadaACompras !== vueltaAtendida.current) {
        vueltaAtendida.current = f.enviadaACompras
        void cargarRevisada(f.id)
      } else if (f.estado === 'cargada' || f.estado === 'descartada') {
        toast.info(f.estado === 'cargada' ? 'La factura del teléfono se cargó desde otra pantalla.' : 'La factura del teléfono se descartó.')
        reiniciar()
        onCerrar()
      } else if (revisandoDesde.current !== null && Date.now() - revisandoDesde.current > MAXIMA_ESPERA_MS) {
        dejarDeEsperar('Pasaron dos horas sin terminar la revisión: la factura quedó en «Facturas escaneadas».')
      }
      return
    }
    // Esperando: la primera factura del enlace que todavía no se atendió.
    const f = datos.facturas.find((x) => !atendidas.current.has(x.id))
    if (!f) return
    setSeguida(f)
    if (f.estado === 'lista') {
      void procesar(f.id)
    } else if (f.estado === 'cargada' || f.estado === 'descartada') {
      atendidas.current.add(f.id)
      setAviso(textoDeSeguimiento(f))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datos])

  // Si cerraron la ventana de la revisión, no hay nada que esperar: la factura
  // sigue en «Facturas escaneadas» y, si después la cargan desde la lista,
  // llega igual a este formulario (sin recargarlo). Sólo con ventanas nativas:
  // en el navegador no hay lista de ventanas.
  const revisionAbierta = ventanas.some((w) => w.pageKey === 'facturasEscaneadas')
  const enNavegador = (window as { __stockflowWeb?: boolean }).__stockflowWeb === true
  useEffect(() => {
    if (!revisando || enNavegador || revisionAbierta || trabajando) return
    const desde = revisandoDesde.current
    if (desde === null || Date.now() - desde < GRACIA_VENTANA_MS) return
    dejarDeEsperar('Se cerró la revisión: la factura quedó en «Facturas escaneadas».')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revisando, revisionAbierta, enNavegador, trabajando, datos])

  const enCamino = fase === 'esperando' && seguida !== null && EN_CAMINO.has(seguida.estado)
  const conError = fase === 'esperando' && seguida?.estado === 'error'

  async function volverALeer(id: string): Promise<void> {
    try {
      await api.facturas.releer(id)
      setAviso(null)
    } catch (e) {
      toast.error(mensajeError(e))
    }
  }

  return (
    <>
      {revisando && !abierto && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            {trabajando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4 text-primary" />}
            Factura del teléfono en revisión: al terminar en «Facturas escaneadas», vuelve a este formulario.
          </span>
          <span className="flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => seguida && abrirRevision(seguida.id)}>
              Abrir la revisión
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => dejarDeEsperar()}>
              Dejar de esperar
            </Button>
          </span>
        </div>
      )}

      <VincularTelefonoDialog
        open={abierto}
        onClose={cerrar}
        titulo="Cargar con el teléfono"
        descripcion="Escanee el código con la cámara del teléfono y fotografíe las hojas de la factura. Cuando la PC termine de leerla, la factura completa este formulario."
        onEnlace={(e) => setSesion(e?.sesion ?? null)}
        ocultarQr={enCamino || trabajando || conError || revisando}
        error={() =>
          puedeConfigurar ? (
            <Button
              size="sm"
              onClick={() => {
                cerrar()
                openInWindow('configuracion', { extras: { initialTab: 'facturas' } })
              }}
            >
              Abrir Configuración
            </Button>
          ) : (
            <p className="text-center text-xs text-muted-foreground">
              Si el problema sigue, consulte al administrador (Configuración → Facturas por teléfono).
            </p>
          )
        }
      >
        {trabajando ? (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Preparando la compra…
          </div>
        ) : revisando ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center text-sm">
            <p className="font-medium">La factura necesita una revisión.</p>
            {motivo && <p className="text-amber-700">{motivo}</p>}
            <p className="text-xs text-muted-foreground">
              Se abrió «Facturas escaneadas». Al terminar la revisión con «Cargar en Compras», la factura vuelve a este formulario.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => seguida && abrirRevision(seguida.id)}>
                Abrir la revisión
              </Button>
              <Button size="sm" variant="ghost" onClick={() => dejarDeEsperar()}>
                Dejar de esperar
              </Button>
            </div>
          </div>
        ) : conError && seguida ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center text-sm">
            <p className="text-destructive">{textoDeSeguimiento(seguida)}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button size="sm" onClick={() => void volverALeer(seguida.id)}>
                Volver a leer
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  atendidas.current.add(seguida.id)
                  setSeguida(null)
                }}
              >
                Enviar otra
              </Button>
            </div>
          </div>
        ) : enCamino && seguida ? (
          <div className="flex w-full flex-col items-center gap-3 py-8 text-sm">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-base font-medium">{textoDeSeguimiento(seguida)}</p>
            {seguida.estado !== 'recibiendo' && seguida.hojas > 0 && (
              <div className="h-1.5 w-64 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((Math.min(seguida.hojasLeidas, seguida.hojas) / seguida.hojas) * 100)}%` }}
                />
              </div>
            )}
            <p className="text-center text-xs text-muted-foreground">
              {seguida.estado === 'recibiendo'
                ? 'Cuando termine de fotografiar las hojas, toque «Enviar factura» en el teléfono.'
                : 'Puede seguir trabajando: cuando la factura esté leída, completa este formulario.'}
            </p>
          </div>
        ) : (
          <p className="text-center text-xs text-muted-foreground">
            {aviso ?? 'Esperando la factura del teléfono…'}
          </p>
        )}
      </VincularTelefonoDialog>

      <AlertDialog open={aReemplazar != null} onOpenChange={(o) => { if (!o) setAReemplazar(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Reemplazar la compra en curso?</AlertDialogTitle>
            <AlertDialogDescription>
              El formulario de Compras ya tiene renglones. Si continúa, se reemplazan por los de la factura del teléfono.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setAReemplazar(null)
                toast.info('La factura quedó en «Facturas escaneadas».')
                reiniciar()
                onCerrar()
              }}
            >
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const pendiente = aReemplazar
                setAReemplazar(null)
                if (pendiente) cargar(pendiente.prefill, pendiente.articulos)
              }}
            >
              Reemplazar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
