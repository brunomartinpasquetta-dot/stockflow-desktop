/**
 * FACTURAS DE COMPRA POR TELÉFONO — el servicio que une todo
 * (ver docs/PLAN_FACTURAS_TELEFONO.md).
 *
 *  1. "Vincular teléfono" crea una sesión: un token de 32 hex que vence solo.
 *  2. El teléfono manda las fotos de UNA factura (`recibirFoto`) y la cierra
 *     (`cerrarFactura`): pasa a la cola.
 *  3. La cola lee de fondo, de a una factura y de a una hoja. El lector
 *     principal es el de texto del sistema operativo (`lectorSistema.ts`, al
 *     instante); el de Ollama queda para "Mejorar lectura" o si esta PC no
 *     tiene lector del sistema. El texto se pasa a renglones con `parser.ts`,
 *     se busca el QR fiscal (si no está, el encabezado sale del texto:
 *     `encabezado.ts`), el proveedor por CUIT y los artículos: por el código
 *     del proveedor ya aprendido, por el código de barras, por la
 *     descripción aprendida y, si nada de eso, por parecido de descripción
 *     (`asociador.ts`: queda "Sugerido", no se recuerda hasta que se acepta).
 *  4. Queda `lista`. De acá NUNCA sale una compra: Compras («Cargar con el
 *     teléfono») o la pantalla de revisión sólo precargan el formulario.
 *
 * Viene APAGADO. Apagado no lee nada, no llama a Ollama y las rutas del
 * teléfono contestan 404 (`activo()` es lo que mira servidorFotos.ts).
 *
 * Sin Electron: se prueba con tsx (electron/__tests__/facturas.smoke.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import type { Article, FacturaEscaneada, Repositories, ScannedInvoiceStatus, Supplier } from '@stockflow/db';

import {
  baseDeLaEmpresa,
  baseDeLaFactura,
  claveDeVinculo,
  controlDeTotal,
  costoParaCompras,
  cuentaCierra,
  enPesos,
  esCodigoDeBarras,
  esRenglonDeGasto,
  nombreDeProveedorNormalizado,
  PREFIJO_CLAVE_DESCRIPCION,
  proveedoresParecidos,
  sinAcentos,
  type ModoPrecios,
} from '../../src/lib/facturaACompra';

import { OllamaClient, OllamaError, type ProgresoDescarga } from '../assistant/ia/ollama';
import { prepararCatalogo, proponerArticulo, tamanosDistintos, type CatalogoPreparado, type PropuestaAsociacion } from './asociador';
import { leerEncabezado, type EncabezadoLeido } from './encabezado';
import { LectorFacturas, MODELO_LECTOR_POR_DEFECTO } from './lector';
import { armarRenglones, calidadDeFoto, type LecturaSistema } from './lectorSistema';
import { detectarFormato, MOTIVO_PEGADO, parsearTexto, totalesDelTexto, unirHojas, type RenglonLeido } from './parser';
import { leerQrFiscal, type DatosQr } from './qrFiscal';
import { MAX_FOTO_BYTES, type PuertaFotos } from './servidorFotos';

/* ─────────────────────────────── tipos ─────────────────────────────── */

export interface ConfigFacturas {
  activo: boolean;
  modelo: string;
  /**
   * "Mejorar lectura": lee con el modelo de Ollama (más preciso en facturas
   * difíciles, pero cada hoja demora minutos y hay que descargar 1,6 GB).
   * Apagado, lee el lector de texto del sistema operativo (al instante).
   */
  mejorLectura: boolean;
}

const CONFIG_FACTURAS_POR_DEFECTO: ConfigFacturas = { activo: false, modelo: MODELO_LECTOR_POR_DEFECTO, mejorLectura: false };

/**
 * Lo que el servicio necesita del lector de texto del sistema (`LectorSistema`
 * de lectorSistema.ts). Va como interfaz para poder probarlo con uno falso.
 */
export interface LectorDeHojas {
  disponible(): Promise<boolean>;
  leerHoja(jpeg: Buffer): Promise<LecturaSistema>;
}

/**
 * Encabezado de la factura. Sale del QR fiscal cuando se pudo leer (`qr:
 * true`, manda); si no, del texto impreso (`origen: 'texto'`, mejor esfuerzo:
 * lo controla el usuario en la revisión). Lo que no se leyó queda en null.
 */
export interface EncabezadoFactura extends DatosQr {
  /** true = los datos salieron del QR fiscal de la foto. */
  qr: boolean;
  /** De dónde salieron los datos. null = los completó el usuario. */
  origen?: 'qr' | 'texto' | null;
  /** Nombre del emisor tal como está impreso (para ofrecer "Crear proveedor"). */
  razonSocial?: string | null;
  /** Subtotal impreso en el pie, si se leyó (en Factura A es el neto: sirve para el control). */
  subtotal?: number | null;
  /**
   * Tipo de comprobante que eligió el usuario en la revisión (define si los
   * precios son netos o finales). null = todavía no eligió: vale la letra del QR.
   * Va aparte de `letra` porque el comprobante X no tiene letra fiscal.
   */
  tipo?: 'A' | 'B' | 'C' | 'X' | null;
  /**
   * Versión del lector (`VERSION_LECTURA`) con que se armaron encabezado y
   * renglones. Si es más vieja que la actual y el usuario no corrigió nada, la
   * factura se rearma sola desde el texto guardado al listarla o abrirla.
   */
  parser?: number | null;
  /** El usuario ya guardó correcciones en la revisión: no se rearma sola. */
  editada?: boolean;
  /**
   * Otros nombres del emisor impresos en la hoja (de fantasía, "Razón
   * Social:"): sirven para SUGERIR el proveedor cuando no se lo encuentra.
   */
  otrosNombres?: string[];
  /** Cuándo se registró la compra de esta factura (para avisar si se la vuelve a cargar). */
  cargadaEl?: number | null;
}

/**
 * Versión de lo que hace el servicio con el texto de las hojas (parser,
 * encabezado, proveedor, vínculos). Se sube cada vez que cambia el resultado
 * para un mismo texto: las facturas `lista` leídas con una versión anterior se
 * rearman desde `pages_text` (no hay que releer la foto).
 *  4 = artículos sugeridos por parecido de descripción (asociador.ts).
 *  5 = el código leído en una línea aparte queda dudoso: se ofrece, no vincula solo.
 */
const VERSION_LECTURA = 5;

/** Renglón guardado: lo leído + el artículo que eligió (o se le encontró) al vincular. */
export interface RenglonFactura extends RenglonLeido {
  articleId: string | null;
  /**
   * El usuario QUITÓ el vínculo de este renglón: no se le vuelve a poner solo
   * por el código (no es lo mismo que "nunca se vinculó").
   */
  sinVinculo?: boolean;
  /**
   * No hay certeza de que el código sea de este renglón: la hoja salió
   * cortada en un borde (puede estar incompleto) o el código se leyó en una
   * línea aparte y se le pegó por posición (`codigoSuelto` del parser). No se
   * vincula solo por ese código ni se recuerda nada de este renglón para el
   * proveedor.
   */
  codigoDudoso?: boolean;
  /**
   * `articleId` lo propuso el sistema por parecido de la descripción
   * (asociador.ts) y el usuario todavía no lo aceptó: se muestra como
   * «Sugerido», cuenta para cargar la factura, y NO se recuerda para el
   * proveedor (un parecido equivocado, recordado, vincularía mal las próximas).
   */
  sugerido?: boolean;
  /**
   * Flete, gastos de envío…: no es mercadería. Cuenta para el control del
   * total, no lleva artículo y no se carga como renglón de la compra.
   */
  esGasto?: boolean;
}

export type FacturaGuardada = FacturaEscaneada<EncabezadoFactura, RenglonFactura>;

export interface ArticuloDeRenglon {
  id: string;
  barcode: string;
  description: string;
  costPrice: string;
  active: boolean;
}

export interface RenglonDetalle extends RenglonFactura {
  /** El artículo de `articleId`, o el que se encontró por código. */
  articulo: ArticuloDeRenglon | null;
  /**
   * De dónde salió el vínculo: `guardado` (lo eligió el usuario en esta
   * factura), `proveedor` (código ya vinculado para este proveedor),
   * `codigo` (el código leído es el código de barras del artículo),
   * `descripcion` (la descripción ya vinculada para este proveedor, que no
   * usa códigos) o `sugerido` (parecido de descripción: lo controla el usuario).
   */
  vinculadoPor: 'guardado' | 'proveedor' | 'codigo' | 'descripcion' | 'sugerido' | null;
  /**
   * Hasta 3 artículos para ofrecer cuando no hay vínculo (o es sólo una
   * sugerencia): primero el que tiene el código leído como código propio (sin
   * forma de código de barras no se vincula solo), después los candidatos por
   * parecido de descripción.
   */
  sugerencias: ArticuloDeRenglon[];
  /**
   * Unidades por bulto que el usuario confirmó para este código de este
   * proveedor en una factura anterior (1 = sin bulto). null = nunca se confirmó.
   */
  uxbRecordado: number | null;
}

/** Proveedor ya cargado que puede ser el emisor leído (sólo para sugerirlo). */
export interface ProveedorSugerido {
  id: string;
  code: string;
  name: string;
  cuit: string | null;
}

/** Compra ya registrada con el mismo proveedor y número de factura. */
export interface CompraExistente {
  id: string;
  type: string;
  number: number;
  date: number;
  total: string;
  supplierInvoiceNumber: string | null;
  /** Cuándo se registró. */
  createdAt?: number;
}

/** La factura ya se cargó antes: hay una compra registrada o una factura escaneada «Cargada» con ese comprobante. */
export interface FacturaYaCargada {
  /** Cuándo se cargó (se registró la compra). */
  fecha: number;
  origen: 'compra' | 'escaneada';
}

/** Una factura que manda el teléfono, tal como la sigue Compras mientras espera. */
export interface SeguimientoFactura {
  id: string;
  estado: ScannedInvoiceStatus;
  hojas: number;
  hojasLeidas: number;
  error: string | null;
  /** Se está leyendo con "Mejorar lectura": cada hoja puede demorar minutos. */
  lento: boolean;
  /** La revisión la mandó de vuelta a Compras (`enviarACompras`): cuándo. null = todavía no. */
  enviadaACompras: number | null;
}

export interface Seguimiento {
  /** El enlace del teléfono sigue sirviendo. null = no se preguntó por un enlace. */
  sesionViva: boolean | null;
  /** Las facturas que mandó ese enlace (en orden) y la que se pidió por `id`. */
  facturas: SeguimientoFactura[];
}

export interface FacturaResumen {
  id: string;
  estado: ScannedInvoiceStatus;
  supplierId: string | null;
  proveedor: string | null;
  hojas: number;
  hojasLeidas: number;
  error: string | null;
  renglones: number;
  /** Renglones que no cierran por la cuenta o a los que les faltan datos. */
  porRevisar: number;
  /** Suma de los importes de los renglones (los descuentos restan). */
  sumaRenglones: number;
  /** Total del comprobante según el QR fiscal o el texto de la factura, si se leyó. */
  total: number | null;
  /**
   * ¿La suma de los renglones da el total leído (tolerancia: 1 peso)? null =
   * no se leyó ningún total. Si no coincide, `porRevisar` lo cuenta.
   */
  totalCoincide: boolean | null;
  /**
   * Lista, con proveedor, todos los renglones vinculados, ninguno en revisar y
   * el total coincide: se puede pasar a Compras sin abrir la revisión.
   */
  listaParaCargar: boolean;
  /**
   * El tipo de comprobante contradice al total (Factura A cuyos renglones ya
   * suman el total, o al revés): cuenta en `porRevisar` y no hay atajo.
   */
  tipoDudoso: boolean;
  /**
   * Se leyó con una versión anterior del lector y tiene correcciones del
   * usuario: no se rearma sola, se ofrece «Volver a leer».
   */
  lecturaVieja: boolean;
  /** Lo que se leyó del emisor, para mostrarlo mientras no hay proveedor asociado. */
  proveedorLeido: { razonSocial: string | null; cuit: string | null } | null;
  /** Se está leyendo con "Mejorar lectura": cada hoja puede demorar minutos. */
  lecturaLenta: boolean;
  letra: string | null;
  /** Código de comprobante de ARCA del QR (3, 8, 13… = nota de crédito). */
  tipoCmp: number | null;
  ptoVta: number | null;
  nroCmp: number | null;
  fecha: string | null;
  /** Hay otra factura escaneada con el mismo comprobante (emisor + punto de venta + número, o CAE). */
  repetida: boolean;
  creadaEl: number;
}

export interface FacturaDetalle extends FacturaResumen {
  header: EncabezadoFactura | null;
  lineas: RenglonDetalle[];
  /** Compra no anulada de ese proveedor con ese número de factura, si ya hay una. */
  compraExistente: CompraExistente | null;
  /** "Esta factura ya fue cargada el …": por una compra registrada o por otra factura escaneada «Cargada». */
  yaCargada: FacturaYaCargada | null;
  /** Sin proveedor asociado: los ya cargados que pueden ser el emisor leído (por CUIT o por nombre). */
  proveedoresSugeridos: ProveedorSugerido[];
}

export interface EstadoFacturas {
  activo: boolean;
  /** "Mejorar lectura": lee con el modelo de Ollama en vez del lector del sistema. */
  mejorLectura: boolean;
  /** Lector de texto del sistema operativo (el principal: no necesita Ollama). */
  lectorSistema: { disponible: boolean };
  modelo: string;
  /** Sólo se consulta con "Mejorar lectura" (o si esta PC no tiene lector del sistema). */
  ollama: { disponible: boolean; version: string | null; url: string };
  lector: { descargado: boolean };
  descarga: { modelo: string; estado: string; fraccion: number | null; bytes: number; total: number } | null;
  cola: { enCola: number; leyendo: { id: string; hoja: number; hojas: number; lento: boolean } | null };
  /** Facturas listas para revisar (el contador del botón de Compras). */
  listas: number;
  /** La escucha del teléfono en la red del local (la levanta main.ts). */
  servidorFotos: { puerto: number | null; error: string | null };
  ultimoError: string | null;
}

/** Error con texto pensado para mostrarle al usuario (en la PC o en el teléfono). */
export class FacturasError extends Error {
  constructor(
    message: string,
    /**
     * `foto` = la foto no sirve para leer (se le pide otra al teléfono, o "Usar igual").
     * `ocupado` = todavía se está leyendo la hoja anterior (el teléfono reintenta).
     */
    readonly tipo: 'no-existe' | 'estado' | 'validacion' | 'apagado' | 'foto' | 'ocupado' = 'validacion',
  ) {
    super(message);
    this.name = 'FacturasError';
  }
}

/** El lector de texto del sistema falló al leer una hoja y no hay otro lector listo. */
class FalloLectorSistema extends Error {}

type Log = { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };

export interface OpcionesFacturasTelefono {
  userDataDir: string;
  repos: Repositories;
  /**
   * Cliente de Ollama. Puede ser una función: la dirección de Ollama se
   * configura en Flowy y puede cambiar con la app abierta.
   */
  cliente: OllamaClient | (() => OllamaClient);
  /** Lector de texto del sistema operativo (el principal). Sin él se lee con Ollama. */
  lectorSistema?: LectorDeHojas | null;
  log?: Log;
  /** Lector del QR fiscal (tests). Por defecto, `leerQrFiscal`. */
  leerQr?: (jpeg: Buffer) => DatosQr | null;
  /**
   * ¿La licencia de esta PC permite escribir? Con el sistema en sólo lectura
   * (licencia suspendida, revocada o prueba vencida) el teléfono no puede
   * mandar nada: las rutas contestan lo mismo que con la opción apagada.
   * Sin esta función se supone que sí.
   */
  licenciaActiva?: () => boolean;
  /** Topes de un enlace de teléfono (tests). Por defecto, las constantes de abajo. */
  limites?: Partial<LimitesFacturas>;
}

export interface LimitesFacturas {
  /** Vida máxima de un enlace desde que se creó, por más que se lo siga usando. */
  vidaMaximaSesionMs: number;
  /** Facturas que puede mandar un mismo enlace. */
  facturasPorSesion: number;
  /** Bytes de fotos que puede mandar un mismo enlace. */
  bytesPorSesion: number;
  /** Facturas sin leer (recibiendo + en cola + leyendo) entre todos los teléfonos. */
  pendientes: number;
  /** Fotos rechazadas (no sirven para leer) que puede mandar un mismo enlace. */
  rechazosPorSesion: number;
  /** Hojas que se pueden estar leyendo a la vez al recibirlas, entre todos los teléfonos. */
  lecturasALaVez: number;
}

const MAX_HOJAS = 12;
const VIDA_SESION_MS = 30 * 60_000;
/**
 * Un enlace no es eterno ni sin fondo: quien lo tenga (viaja sin cifrar por la
 * Wi-Fi del local y queda en el historial del teléfono) no puede llenar el
 * disco de la PC ni dejar la cola de lectura ocupada por horas.
 */
const LIMITES_POR_DEFECTO: LimitesFacturas = {
  vidaMaximaSesionMs: 2 * 60 * 60_000,
  facturasPorSesion: 20,
  bytesPorSesion: 300 * 1024 * 1024,
  pendientes: 30,
  rechazosPorSesion: 60,
  lecturasALaVez: 3,
};
/** Las fotos de una factura ya cargada en Compras se borran pasado este tiempo. */
const DIAS_FOTOS_CARGADAS = 90;
/** Cuánto vale la última consulta a Ollama (el estado se pide seguido desde varias pantallas). */
const VIDA_SONDEO_OLLAMA_MS = 5000;
const MAX_SESIONES = 20;
const MAX_RENGLONES = 2000;
const FORMATO_TOKEN = /^[0-9a-f]{32}$/;
const FORMATO_SESION = /^[0-9a-f]{16}$/;
/** Identificador que se inventa cada pantalla de Compras para que la revisión le devuelva SU factura. */
const FORMATO_PANTALLA = /^[\w-]{1,64}$/;
const pantallaDe = (v: unknown): string | null => (typeof v === 'string' && FORMATO_PANTALLA.test(v) ? v : null);
/**
 * Compras que espera una factura en revisión vuelve a preguntar cada pocos
 * segundos: si no preguntó en este tiempo, ya no está esperando (la revisión
 * abre Compras con la factura, como siempre). Holgado a propósito: con la
 * ventana de Compras minimizada, el navegador espacia los sondeos hasta uno
 * por minuto. (Si la ventana se cerró, la revisión lo sabe por su cuenta.)
 */
const VIDA_ESPERA_MS = 75_000;
/** Los avisos "la revisión la mandó a Compras" se olvidan pasado este tiempo. */
const VIDA_PEDIDO_MS = 60 * 60_000;

interface Sesion {
  token: string;
  /**
   * Identificador para que la PC siga lo que manda este enlace (Compras,
   * mientras espera la factura). NO es el token: con él no se puede mandar nada.
   */
  id: string;
  /** Facturas que abrió este enlace, en orden. */
  ids: string[];
  userId: string | null;
  vence: number;
  /** Cuándo se creó: el enlace no vive más que `vidaMaximaSesionMs` desde acá. */
  creada: number;
  /** Facturas que ya abrió y bytes de fotos que ya mandó. */
  facturas: number;
  bytes: number;
  /** Fotos que mandó y se rechazaron por no servir para leer. */
  rechazos: number;
  /** Hay una hoja de este enlace recibiéndose (se lee de a una por enlace). */
  recibiendo: boolean;
  /** Factura que el teléfono está armando (`recibiendo`), si hay. */
  abierta: string | null;
  /** La última que cerró: es la que la página sigue por sondeo. */
  ultima: string | null;
}

const ESTADOS_EN_CURSO: ScannedInvoiceStatus[] = ['en_cola', 'leyendo'];
const ESTADOS_PENDIENTES: ScannedInvoiceStatus[] = ['recibiendo', 'en_cola', 'leyendo'];
const ESTADOS_VISIBLES: ScannedInvoiceStatus[] = ['en_cola', 'leyendo', 'lista', 'error', 'cargada'];

/* ───────────────────────────── utilidades ───────────────────────────── */

/**
 * IP de esta PC en la red del local: la que tiene que abrir el teléfono.
 * Se prefiere la placa Wi-Fi/Ethernet real (en0/en1, eth*, wlan*, "Wi-Fi",
 * "Ethernet") con dirección privada, y se descartan las de VPN, túneles,
 * puentes y máquinas virtuales (utun, bridge, docker, vEthernet…), que el
 * teléfono no alcanza.
 */
export function elegirIpLocal(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const descartada = /^(lo|utun|tun|tap|bridge|br-|docker|veth|vmnet|vboxnet|awdl|llw|anpi|ap\d|gif|stf|ppp|ipsec|wg|tailscale|zt|ham)|vethernet|virtual|vmware|loopback|hyper-v|wsl|bluetooth|tailscale|zerotier|hamachi|vpn/i;
  const real = /^(en\d|eth\d|wlan\d|wlp|enp|eno|ens|wlo)|^wi-?fi|^ethernet|^conexi[oó]n de [aá]rea local|^local area connection/i;
  const privada = (ip: string): boolean =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  let mejor: { ip: string; puntos: number } | null = null;
  for (const nombre of Object.keys(ifaces)) {
    if (descartada.test(nombre)) continue;
    for (const info of ifaces[nombre] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (/^169\.254\./.test(info.address)) continue; // sin red: dirección automática
      let puntos = 0;
      if (privada(info.address)) puntos += 4;
      if (real.test(nombre)) puntos += 2;
      if (/^192\.168\./.test(info.address)) puntos += 1; // la red típica de un local
      if (!mejor || puntos > mejor.puntos) mejor = { ip: info.address, puntos };
    }
  }
  return mejor?.ip ?? null;
}

/** Palabras que sirven para comparar descripciones (sin medidas ni números). */
function palabras(texto: string): string[] {
  return sinAcentos(texto)
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !/^\d/.test(w) && !/^x?\d+(ml|cc|gr?|kg|lt?|un|u)?$/.test(w));
}

/** ¿Dos palabras son la misma con un error de lectura (O↔0, I↔1) o una abreviatura (DESM ↔ DESMENUZADO)? */
function mismaPalabra(a: string, b: string): boolean {
  if (a === b) return true;
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  if (corta.length >= 4 && larga.startsWith(corta)) return true;
  if (corta.length < 5 || larga.length - corta.length > 1) return false;
  // A lo sumo un carácter distinto, de más o de menos.
  let i = 0;
  let j = 0;
  let errores = 0;
  while (i < corta.length && j < larga.length) {
    if (corta[i] === larga[j]) {
      i++;
      j++;
      continue;
    }
    if (++errores > 1) return false;
    if (corta.length === larga.length) i++;
    j++;
  }
  return errores + (larga.length - j) <= 1;
}

/**
 * ¿La descripción con que se APRENDIÓ un código del proveedor y la del renglón
 * nuevo son del mismo producto? El mismo proveedor imprime el mismo código
 * siempre igual (o casi: errores de lectura, abreviaturas, una palabra de
 * más). Si las palabras de la más corta no aparecen en la otra, o cambió el
 * tamaño, el código es de OTRO producto: lo más probable es que se haya
 * aprendido con un dígito mal leído. Sin palabras para comparar (vínculo
 * aprendido antes de guardar la descripción) se confía, como hasta ahora.
 */
function descripcionesCompatibles(aprendida: string | null | undefined, leida: string): boolean {
  const a = palabras(aprendida ?? '');
  const b = palabras(leida);
  if (a.length === 0 || b.length === 0) return true;
  if (tamanosDistintos(aprendida ?? '', leida)) return false;
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  return corta.every((p) => larga.some((q) => mismaPalabra(p, q)));
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function texto(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max);
}

function textoONull(v: unknown, max: number): string | null {
  const t = texto(v, max).trim();
  return t ? t : null;
}

/** ¿El número de factura escrito en una compra (`0001-00012345`, `1-12345`, `12345`) es este comprobante? */
export function mismoNumeroDeFactura(escrito: string | null | undefined, ptoVta: number | null, nroCmp: number | null): boolean {
  if (!escrito || nroCmp === null) return false;
  let grupos = escrito.match(/\d+/g);
  if (!grupos) return false;
  // Todo junto (`000100012345`): los últimos 8 son el número.
  if (grupos.length === 1 && grupos[0]!.length > 8) grupos = [grupos[0]!.slice(0, -8), grupos[0]!.slice(-8)];
  if (Number(grupos[grupos.length - 1]) !== nroCmp) return false;
  if (grupos.length < 2 || ptoVta === null) return true;
  return Number(grupos[grupos.length - 2]) === ptoVta;
}

/** Claves para reconocer el mismo comprobante escaneado dos veces. */
function clavesDeComprobante(f: FacturaGuardada): string[] {
  const h = f.header;
  if (!h) return [];
  const claves: string[] = [];
  if (h.codAut) claves.push(`cae:${h.codAut}`);
  if (typeof h.nroCmp === 'number') {
    // Sin el tipo de comprobante a propósito: con QR es 1/6/11 y leído del
    // texto es null, y la misma factura escaneada dos veces (una con el QR
    // legible, la otra no) tiene que reconocerse. Una nota de crédito con el
    // mismo número que una factura se avisa de más; el doble ingreso de stock
    // sale más caro que un aviso.
    const numero = `${h.ptoVta ?? ''}:${h.nroCmp}`;
    if (h.cuit) claves.push(`cuit:${h.cuit}:${numero}`);
    if (f.supplierId) claves.push(`prov:${f.supplierId}:${numero}`);
  }
  return claves;
}

/** Aviso de `calidadDeFoto` que dice que la hoja quedó cortada en un borde. */
const RE_AVISO_DE_BORDE = /falta parte de la hoja/i;

/** Lo que se guarda al lado de cada foto leída con el lector del sistema (`hoja-N.json`). */
interface LecturaGuardada {
  lectura: LecturaSistema;
  /** Avisos de `calidadDeFoto` (vacío = foto buena). */
  problemas: string[];
}

/** Nombre para comparar proveedores: sin acentos, sin tipo de sociedad ni signos. */
const nombreParaComparar = nombreDeProveedorNormalizado;

/** Artículo espejo de una promoción (marca PROMO, código PROMO-N): nunca es lo que trae un proveedor. */
function esEspejoDePromo(a: Article): boolean {
  return a.brand === 'PROMO' && /^PROMO-\d+$/.test(a.barcode);
}

/** Tipo de comprobante para la cuenta: lo que eligió el usuario; si no, la letra (M se trata como A). */
function tipoDe(h: EncabezadoFactura | null | undefined): 'A' | 'B' | 'C' | 'X' | null {
  if (h?.tipo) return h.tipo;
  if (h?.letra === 'M') return 'A';
  return h?.letra ?? null;
}

/** Notas de crédito según el código de ARCA (las mismas de `claseDeComprobante`). */
const NOTAS_DE_CREDITO = [3, 8, 13, 53, 203, 208, 213];

/**
 * Encabezado a guardar: el QR manda; sin QR, lo leído del texto. Siempre
 * devuelve uno (lleva la versión del lector): si no se leyó nada, vacío y con
 * `origen: null` (la revisión pide completarlo).
 */
function armarEncabezado(qr: DatosQr | null, leido: EncabezadoLeido, subtotal: number | null): EncabezadoFactura {
  const otros = leido.otrosNombres.length > 0 ? { otrosNombres: leido.otrosNombres.slice(0, 5) } : {};
  if (qr) return { ...qr, qr: true, origen: 'qr', razonSocial: leido.razonSocial, subtotal, parser: VERSION_LECTURA, ...otros };
  const [pv, nro] = (leido.numero ?? '').split('-');
  const hay = leido.cuit || leido.razonSocial || leido.numero || leido.fecha || leido.letra || leido.total !== null;
  return {
    ...otros,
    fecha: leido.fecha,
    cuit: leido.cuit,
    ptoVta: pv && nro ? Number(pv) : null,
    tipoCmp: null,
    letra: leido.letra,
    nroCmp: nro ? Number(nro) : pv ? Number(pv) : null,
    importe: leido.total,
    codAut: leido.cae,
    qr: false,
    origen: hay ? 'texto' : null,
    razonSocial: leido.razonSocial,
    subtotal,
    parser: VERSION_LECTURA,
  };
}

/** Los datos del QR fiscal que quedaron guardados en un encabezado (para rearmar sin releer la foto). */
function qrGuardado(h: EncabezadoFactura | null | undefined): DatosQr | null {
  if (!h || h.qr !== true) return null;
  return {
    fecha: h.fecha ?? null,
    cuit: h.cuit ?? null,
    ptoVta: h.ptoVta ?? null,
    tipoCmp: h.tipoCmp ?? null,
    letra: h.letra ?? null,
    nroCmp: h.nroCmp ?? null,
    importe: h.importe ?? null,
    codAut: h.codAut ?? null,
  };
}

function aArticulo(a: Article): ArticuloDeRenglon {
  return { id: a.id, barcode: a.barcode, description: a.description, costPrice: a.costPrice, active: a.active };
}

/**
 * Renglón que llega de la pantalla (o de una terminal de la red): se arma de
 * nuevo campo por campo, así no se guarda nada que no sea un renglón.
 */
function sanearRenglon(crudo: unknown): RenglonFactura {
  const r = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>;
  const estado = r.estado === 'ok' || r.estado === 'corregido' ? r.estado : 'revisar';
  const importe = numero(r.importe);
  const tasa = numero(r.tasaIva);
  const articleId = textoONull(r.articleId, 64);
  return {
    codigo: textoONull(r.codigo, 60),
    descripcion: texto(r.descripcion, 300),
    cantidad: numero(r.cantidad),
    unidadesPorBulto: numero(r.unidadesPorBulto),
    precioUnitario: numero(r.precioUnitario),
    importe,
    esDescuento: typeof r.esDescuento === 'boolean' ? r.esDescuento : importe !== null && importe < 0,
    estado,
    motivo: textoONull(r.motivo, 200),
    original: texto(r.original, 1000),
    hoja: Math.max(1, Math.trunc(numero(r.hoja) ?? 1)),
    tasaIva: tasa !== null && tasa > 0 && tasa < 100 ? tasa : null,
    articleId,
    ...(r.sinVinculo === true && articleId === null ? { sinVinculo: true } : {}),
    ...(r.codigoDudoso === true ? { codigoDudoso: true } : {}),
    ...(r.packResuelto === true ? { packResuelto: true, bultos: numero(r.bultos) } : {}),
    // Un gasto no lleva artículo: si se lo vinculó, es mercadería.
    ...(r.esGasto === true && articleId === null && !(importe !== null && importe < 0) ? { esGasto: true } : {}),
    // Sugerido sin artículo no significa nada.
    ...(r.sugerido === true && articleId !== null ? { sugerido: true } : {}),
  };
}

function sanearEncabezado(crudo: unknown): EncabezadoFactura | null {
  if (!crudo || typeof crudo !== 'object') return null;
  const h = crudo as Record<string, unknown>;
  const letra = h.letra === 'A' || h.letra === 'B' || h.letra === 'C' || h.letra === 'M' ? h.letra : null;
  const fecha = textoONull(h.fecha, 10);
  const entero = (v: unknown): number | null => {
    const n = numero(v);
    return n === null ? null : Math.trunc(n);
  };
  return {
    fecha: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : null,
    cuit: textoONull(h.cuit, 20)?.replace(/\D/g, '') || null,
    ptoVta: entero(h.ptoVta),
    tipoCmp: entero(h.tipoCmp),
    letra,
    nroCmp: entero(h.nroCmp),
    importe: numero(h.importe),
    codAut: textoONull(h.codAut, 20),
    qr: h.qr === true,
    tipo: h.tipo === 'A' || h.tipo === 'B' || h.tipo === 'C' || h.tipo === 'X' ? h.tipo : null,
    origen: h.origen === 'qr' || h.origen === 'texto' ? h.origen : h.qr === true ? 'qr' : null,
    razonSocial: textoONull(h.razonSocial, 120),
    subtotal: numero(h.subtotal),
    parser: numero(h.parser),
    ...(h.editada === true ? { editada: true } : {}),
    ...(Array.isArray(h.otrosNombres)
      ? { otrosNombres: h.otrosNombres.map((n) => textoONull(n, 120)).filter((n): n is string => n !== null).slice(0, 5) }
      : {}),
    ...(numero(h.cargadaEl) !== null ? { cargadaEl: numero(h.cargadaEl) } : {}),
  };
}

/* ─────────────────────────────── servicio ─────────────────────────────── */

export class FacturasTelefono implements PuertaFotos {
  private readonly repos: Repositories;
  private readonly log: Log;
  private readonly rutaConfig: string;
  private readonly dirFotos: string;
  private readonly clienteDe: () => OllamaClient;
  private readonly lectorSistema: LectorDeHojas | null;
  private readonly leerQr: (jpeg: Buffer) => DatosQr | null;
  private readonly licenciaActiva: () => boolean;
  private readonly limites: LimitesFacturas;
  private sondeoOllama: { hasta: number; url: string; modelo: string; version: string | null; descargado: boolean } | null = null;

  private config: ConfigFacturas;
  private readonly sesiones = new Map<string, Sesion>();

  /** Hojas que se están leyendo al recibirlas (control de calidad), entre todos los enlaces. */
  private lecturasEnCurso = 0;
  /**
   * El padrón preparado para el asociador (artículos activos). Se arma una vez
   * y vale mientras no cambie la huella del padrón (cantidad y última modificación).
   */
  private catalogo: { huella: string; preparado: CatalogoPreparado; porId: Map<string, Article> } | null = null;
  /** Veces que se armó el índice del asociador (lo mira la prueba). */
  armadosDelCatalogo = 0;
  /**
   * Factura en revisión → la última vez que una pantalla de Compras preguntó
   * por ella esperando que vuelva, y QUÉ pantalla (`pantalla`: identificador
   * que se inventa cada ventana de Compras). Con varios puestos en red, la
   * revisión abierta en otro puesto no tiene que "devolverle" la factura a la
   * Compras de este.
   */
  private readonly esperas = new Map<string, { desde: number; pantalla: string | null }>();
  /** Factura → cuándo la revisión la mandó de vuelta a la pantalla de Compras que la esperaba. */
  private readonly pedidosACompras = new Map<string, number>();
  /** Facturas que se están rearmando o que no se pudieron rearmar en esta sesión de la app. */
  private readonly rearmando = new Set<string>();
  private readonly sinRearmar = new Set<string>();

  private cola: Promise<void> | null = null;
  private leyendo: { id: string; hoja: number; hojas: number; lento: boolean; corte: AbortController } | null = null;
  private apagado = false;

  private descarga: EstadoFacturas['descarga'] = null;
  private descargando: Promise<void> | null = null;
  private corteDescarga: AbortController | null = null;
  private ultimoError: string | null = null;

  /**
   * La escucha del teléfono la levanta main.ts (acá no hay red): deja anotado
   * el puerto para armar el enlace del QR y mostrarlo en el estado.
   */
  servidorFotos: { puerto: number | null; error: string | null } = { puerto: null, error: null };

  /** Aviso a main.ts cuando se activa o se apaga la opción (levanta o baja la escucha). */
  alConfigurar: ((config: ConfigFacturas) => void) | null = null;

  constructor(opts: OpcionesFacturasTelefono) {
    this.repos = opts.repos;
    this.log = opts.log ?? {
      info: (m) => console.info('[facturas]', m),
      warn: (m) => console.warn('[facturas]', m),
      error: (m) => console.error('[facturas]', m),
    };
    const cliente = opts.cliente;
    this.clienteDe = typeof cliente === 'function' ? cliente : () => cliente;
    this.lectorSistema = opts.lectorSistema ?? null;
    this.leerQr = opts.leerQr ?? leerQrFiscal;
    this.licenciaActiva = opts.licenciaActiva ?? (() => true);
    this.limites = { ...LIMITES_POR_DEFECTO, ...opts.limites };
    this.rutaConfig = join(opts.userDataDir, 'facturas-telefono.json');
    this.dirFotos = join(opts.userDataDir, 'facturas-escaneadas');
    this.config = this.leerConfig();
  }

  /* ------------------------------ configuración ------------------------------ */

  private leerConfig(): ConfigFacturas {
    try {
      if (existsSync(this.rutaConfig)) {
        const j = JSON.parse(readFileSync(this.rutaConfig, 'utf8')) as Partial<ConfigFacturas>;
        return {
          activo: j.activo === true,
          modelo: typeof j.modelo === 'string' && j.modelo.trim() ? j.modelo.trim() : CONFIG_FACTURAS_POR_DEFECTO.modelo,
          mejorLectura: j.mejorLectura === true,
        };
      }
    } catch {
      /* archivo dañado: vuelve a los valores por defecto (apagado) */
    }
    return { ...CONFIG_FACTURAS_POR_DEFECTO };
  }

  private guardarConfig(): void {
    const tmp = `${this.rutaConfig}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.rutaConfig);
  }

  getConfig(): ConfigFacturas {
    return { ...this.config };
  }

  /** La opción está activada y la app no se está cerrando: la cola puede leer. */
  private encendido(): boolean {
    return this.config.activo && !this.apagado;
  }

  /**
   * Lo que mira `servidorFotos.ts`: apagado, todo contesta 404. También con la
   * licencia fuera de 'active' (sistema en sólo lectura): el teléfono escribe
   * en la base y en el disco, igual que cualquier otra escritura por la red.
   * Lo ya recibido se sigue leyendo (eso lo decide `encendido`).
   */
  activo(): boolean {
    if (!this.encendido()) return false;
    try {
      return this.licenciaActiva() === true;
    } catch {
      return false;
    }
  }

  async configurar(cambios: Partial<ConfigFacturas>): Promise<EstadoFacturas> {
    const antes = this.config;
    this.config = {
      activo: typeof cambios.activo === 'boolean' ? cambios.activo : antes.activo,
      modelo: typeof cambios.modelo === 'string' && cambios.modelo.trim() ? cambios.modelo.trim() : antes.modelo,
      mejorLectura: typeof cambios.mejorLectura === 'boolean' ? cambios.mejorLectura : antes.mejorLectura,
    };
    this.guardarConfig();
    this.sondeoOllama = null;
    if (!this.config.activo) {
      // Apagar corta los enlaces ya entregados y la lectura en curso (la
      // factura vuelve a la cola y sigue cuando se active de nuevo).
      this.sesiones.clear();
      this.leyendo?.corte.abort();
    }
    if (this.config.activo !== antes.activo) {
      try {
        this.alConfigurar?.(this.getConfig());
      } catch (e) {
        this.log.warn(`no se pudo aplicar el cambio de configuración: ${(e as Error).message}`);
      }
    }
    if (this.config.activo) this.arrancarCola();
    return this.estado();
  }

  /** ¿Esta PC tiene lector de texto del sistema? (la respuesta queda guardada en el lector). */
  private async sistemaDisponible(): Promise<boolean> {
    if (!this.lectorSistema) return false;
    try {
      return (await this.lectorSistema.disponible()) === true;
    } catch {
      return false;
    }
  }

  /** Versión de Ollama y si el lector está descargado. La consulta vale unos segundos. */
  private async sondearOllama(): Promise<{ version: string | null; descargado: boolean }> {
    const cliente = this.clienteDe();
    const s = this.sondeoOllama;
    if (s && s.hasta > Date.now() && s.url === cliente.baseUrl && s.modelo === this.config.modelo && !this.descarga) {
      return { version: s.version, descargado: s.descargado };
    }
    const version = await cliente.version();
    let descargado = false;
    let consultado = true;
    if (version) {
      try {
        descargado = this.estaEl(this.config.modelo, (await cliente.modelos()).map((m) => m.nombre));
      } catch {
        consultado = false; // se reintenta en la próxima consulta
      }
    }
    this.sondeoOllama = consultado
      ? { hasta: Date.now() + VIDA_SONDEO_OLLAMA_MS, url: cliente.baseUrl, modelo: this.config.modelo, version, descargado }
      : null;
    return { version, descargado };
  }

  /**
   * ¿Se lee con el lector del sistema? Sí, salvo que esté "Mejorar lectura" Y
   * Ollama esté listo (si falta Ollama o el modelo, no se traba: lee el del
   * sistema). Sin lector del sistema lee siempre Ollama.
   */
  private async leeConSistema(): Promise<boolean> {
    if (!(await this.sistemaDisponible())) return false;
    if (!this.config.mejorLectura) return true;
    try {
      const o = await this.sondearOllama();
      return !(o.version && o.descargado);
    } catch {
      return true;
    }
  }

  async estado(): Promise<EstadoFacturas> {
    const cliente = this.clienteDe();
    let version: string | null = null;
    let descargado = false;
    // Apagado NO se sondea NADA (ni el lector del sistema, que en Windows es
    // ejecutar PowerShell, ni Ollama): Compras pide el estado en todos los
    // comercios sólo para saber si muestra el botón. Con la opción activa,
    // tampoco se llama a Ollama si lee el lector del sistema y "Mejorar
    // lectura" está apagado: no hace falta para nada.
    const sistema = this.config.activo ? await this.sistemaDisponible() : false;
    if (this.config.activo && (this.config.mejorLectura || !sistema)) {
      ({ version, descargado } = await this.sondearOllama());
    }
    const cuenta = this.repos.scannedInvoices.contarPorEstado();
    return {
      activo: this.config.activo,
      mejorLectura: this.config.mejorLectura,
      lectorSistema: { disponible: sistema },
      modelo: this.config.modelo,
      ollama: { disponible: Boolean(version), version, url: cliente.baseUrl },
      lector: { descargado },
      descarga: this.descarga ? { ...this.descarga } : null,
      cola: {
        enCola: cuenta.en_cola ?? 0,
        leyendo: this.leyendo
          ? { id: this.leyendo.id, hoja: this.leyendo.hoja, hojas: this.leyendo.hojas, lento: this.leyendo.lento }
          : null,
      },
      listas: cuenta.lista ?? 0,
      servidorFotos: { ...this.servidorFotos },
      ultimoError: this.ultimoError,
    };
  }

  private estaEl(modelo: string, presentes: string[]): boolean {
    return presentes.includes(modelo) || presentes.includes(`${modelo}:latest`);
  }

  /** Descarga el lector (1,6 GB) en segundo plano. El avance sale por `estado()`. */
  descargarLector(): EstadoFacturas['descarga'] {
    if (this.descargando) return this.descarga;
    const modelo = this.config.modelo;
    const cliente = this.clienteDe();
    const corte = new AbortController();
    this.corteDescarga = corte;
    this.descarga = { modelo, estado: 'Preparando…', fraccion: null, bytes: 0, total: 0 };
    this.descargando = (async () => {
      try {
        if (!(await cliente.version())) throw new Error('Ollama no está instalado o no está abierto en esta PC.');
        if (!this.estaEl(modelo, (await cliente.modelos()).map((m) => m.nombre))) {
          // Con internet lento la descarga a veces se corta: Ollama guarda lo
          // bajado, así que reintentar retoma desde donde quedó.
          for (let intento = 1; ; intento++) {
            try {
              await cliente.descargar(
                modelo,
                (p: ProgresoDescarga) => {
                  this.descarga = { modelo, estado: p.estado, fraccion: p.fraccion, bytes: p.completado, total: p.total };
                },
                corte.signal,
              );
              break;
            } catch (e) {
              if (corte.signal.aborted || intento >= 5) throw e;
              this.log.warn(`descarga de ${modelo} cortada (intento ${intento}): ${(e as Error).message}`);
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
        }
        this.ultimoError = null;
        // Las facturas que fallaron por falta del lector no se releen solas:
        // el usuario las vuelve a leer desde la lista. Las que esperan, siguen.
        this.arrancarCola();
      } catch (e) {
        if (!corte.signal.aborted) this.ultimoError = (e as Error).message;
      } finally {
        this.descarga = null;
        this.sondeoOllama = null;
        this.descargando = null;
        this.corteDescarga = null;
      }
    })();
    return this.descarga;
  }

  /* -------------------------- sesiones del teléfono -------------------------- */

  /**
   * Enlace nuevo para un teléfono: token de 32 hex en minúsculas, vence a los
   * 30 minutos (se renueva mientras manda, hasta la vida máxima del enlace).
   */
  crearSesion(userId: string | null): { token: string; vence: number; sesion: string } {
    if (!this.encendido()) throw new FacturasError('Las facturas por teléfono están desactivadas.', 'apagado');
    if (!this.activo()) {
      throw new FacturasError('El sistema está en sólo lectura: no se pueden recibir facturas desde el teléfono.', 'apagado');
    }
    this.limpiarSesiones();
    while (this.sesiones.size >= MAX_SESIONES) {
      // Tope de enlaces vivos: se va el que vence primero.
      let viejo: Sesion | null = null;
      for (const s of this.sesiones.values()) if (!viejo || s.vence < viejo.vence) viejo = s;
      if (!viejo) break;
      this.cerrarSesion(viejo);
    }
    const token = randomBytes(16).toString('hex');
    const sesion = randomBytes(8).toString('hex');
    const creada = Date.now();
    const vence = creada + Math.min(VIDA_SESION_MS, this.limites.vidaMaximaSesionMs);
    this.sesiones.set(token, {
      token,
      id: sesion,
      ids: [],
      userId,
      vence,
      creada,
      facturas: 0,
      bytes: 0,
      rechazos: 0,
      recibiendo: false,
      abierta: null,
      ultima: null,
    });
    return { token, vence, sesion };
  }

  /** Mientras el teléfono manda, el enlace no vence… hasta su vida máxima. */
  private renovar(s: Sesion): void {
    const tope = s.creada + this.limites.vidaMaximaSesionMs;
    s.vence = Math.min(tope, Math.max(s.vence, Date.now() + VIDA_SESION_MS));
  }

  /**
   * Una sesión sigue viva mientras no venció, o mientras la factura que mandó
   * se está leyendo (una factura de 12 hojas sin GPU tarda más de 30 minutos
   * y el teléfono tiene que poder ver cuando termina).
   */
  private viva(s: Sesion, ahora = Date.now()): boolean {
    if (s.vence > ahora) return true;
    if (!s.ultima) return false;
    const f = this.repos.scannedInvoices.obtener(s.ultima);
    return Boolean(f && ESTADOS_EN_CURSO.includes(f.status));
  }

  /** Al vencer un enlace, lo que alcanzó a mandar no se pierde: se lee igual. */
  private cerrarSesion(s: Sesion): void {
    this.sesiones.delete(s.token);
    if (s.abierta) this.cerrarORetirar(s.abierta);
  }

  /** Una factura que quedó `recibiendo` sin dueño: con hojas va a la cola; vacía, se descarta. */
  private cerrarORetirar(id: string, arrancar = true): void {
    const f = this.repos.scannedInvoices.obtener(id);
    if (!f || f.status !== 'recibiendo') return;
    if (f.photos.length > 0) {
      this.repos.scannedInvoices.actualizar(id, { status: 'en_cola', pagesDone: 0 });
      if (arrancar) this.arrancarCola();
    } else {
      this.repos.scannedInvoices.actualizar(id, { status: 'descartada' });
      this.borrarFotos(id);
    }
  }

  private limpiarSesiones(): void {
    const ahora = Date.now();
    for (const s of [...this.sesiones.values()]) if (!this.viva(s, ahora)) this.cerrarSesion(s);
  }

  /** Busca la sesión comparando en tiempo constante contra TODAS las vivas. */
  private sesionDe(token: string): Sesion | null {
    if (typeof token !== 'string' || !FORMATO_TOKEN.test(token)) return null;
    const dado = Buffer.from(token, 'utf8');
    const ahora = Date.now();
    let hallada: Sesion | null = null;
    for (const s of this.sesiones.values()) {
      const igual = timingSafeEqual(dado, Buffer.from(s.token, 'utf8'));
      if (igual && this.viva(s, ahora)) hallada = s;
    }
    return hallada;
  }

  validarToken(token: string): boolean {
    if (!this.activo()) return false;
    return this.sesionDe(token) !== null;
  }

  private sesionOError(token: string): Sesion {
    const s = this.activo() ? this.sesionDe(token) : null;
    if (!s) throw new FacturasError('El enlace venció. Vincule el teléfono de nuevo.', 'no-existe');
    return s;
  }

  /* ------------------------------ fotos ------------------------------ */

  private dirDe(id: string): string {
    return join(this.dirFotos, id);
  }

  private borrarFotos(id: string): void {
    try {
      rmSync(this.dirDe(id), { recursive: true, force: true });
    } catch (e) {
      this.log.warn(`no se pudieron borrar las fotos de ${id}: ${(e as Error).message}`);
    }
  }

  private rutaLectura(id: string, foto: string): string {
    return join(this.dirDe(id), foto.replace(/\.jpg$/, '.json'));
  }

  /** La lectura del sistema guardada al recibir la hoja, si está (y sana). */
  private lecturaGuardada(id: string, foto: string): LecturaGuardada | null {
    try {
      const j = JSON.parse(readFileSync(this.rutaLectura(id, foto), 'utf8')) as Partial<LecturaGuardada>;
      if (!j?.lectura || !Array.isArray(j.lectura.textos)) return null;
      return { lectura: j.lectura, problemas: Array.isArray(j.problemas) ? j.problemas.filter((p) => typeof p === 'string') : [] };
    } catch {
      return null;
    }
  }

  private guardarLectura(id: string, foto: string, guardada: LecturaGuardada): void {
    try {
      writeFileSync(this.rutaLectura(id, foto), JSON.stringify(guardada), 'utf8');
    } catch (e) {
      this.log.warn(`no se pudo guardar la lectura de ${foto}: ${(e as Error).message}`);
    }
  }

  /**
   * Texto de las hojas ya recibidas de la factura abierta del enlace (para
   * sumar sus renglones con los de la hoja nueva). null si a alguna le falta
   * la lectura guardada: entonces el total no se controla al recibir.
   */
  private textosDeLaFacturaAbierta(s: Sesion): string[] | null {
    const f = s.abierta ? this.repos.scannedInvoices.obtener(s.abierta) : null;
    if (!f || f.status !== 'recibiendo') return [];
    const textos: string[] = [];
    for (const foto of f.photos) {
      const g = this.lecturaGuardada(f.id, foto);
      if (!g) return null;
      textos.push(armarRenglones(g.lectura).join('\n'));
    }
    return textos;
  }

  /**
   * Control COMPLETO de una hoja al recibirla: la lectura del sistema se pasa
   * por los mismos pasos que la cola (renglones y total) y, si lo que sale no
   * sirve, se pide otra foto en vez de mostrar después renglones sin
   * descripción o una suma que no da. Se rechaza cuando:
   *  1. hay renglones sin descripción (la birome la tapó) o con dos productos
   *     pegados en una línea;
   *  2. quedan 2 o más renglones para revisar, o más del 25 % de ellos;
   *  3. la hoja trae el total (o el subtotal) y la suma de los renglones de la
   *     factura (hojas anteriores + ésta) difiere en más de $ 1.
   * Devuelve el motivo para el teléfono (qué pasó y qué hacer) o null si la
   * hoja está bien. El teléfono puede insistir con «Usar igual»: una cruz de
   * birome no se arregla repitiendo la foto.
   */
  private controlDeLaHoja(lectura: LecturaSistema, textosPrevios: string[] | null): string | null {
    const texto = armarRenglones(lectura).join('\n');
    const renglones = parsearTexto(texto);
    const n = renglones.length;
    const repetir = 'Repita la foto con la hoja derecha, sin inclinar y sin sombras.';
    const sinDescripcion = renglones.filter((r) => !r.esDescuento && r.descripcion.trim() === '').length;
    const pegados = renglones.filter((r) => r.motivo === MOTIVO_PEGADO).length;
    if (sinDescripcion > 0 || pegados > 0) {
      const partes: string[] = [];
      if (sinDescripcion > 0) partes.push(`${sinDescripcion} ${sinDescripcion === 1 ? 'quedó' : 'quedaron'} sin descripción`);
      if (pegados > 0) partes.push(`${pegados} ${pegados === 1 ? 'trae' : 'traen'} dos productos en la misma línea`);
      return `Se leyeron ${n} renglones y ${partes.join(' y ')}. ${repetir}`;
    }
    const revisar = renglones.filter((r) => r.estado === 'revisar').length;
    if (revisar >= 2 || revisar > n * 0.25) {
      return `Se leyeron ${n} renglones y ${revisar} ${revisar === 1 ? 'quedó' : 'quedaron'} para revisar (la cuenta no cierra o faltan datos). ${repetir}`;
    }
    const totales = totalesDelTexto(texto);
    if ((totales.total !== null || totales.subtotal !== null) && textosPrevios !== null) {
      const todos = textosPrevios.length > 0 ? unirHojas([...textosPrevios, texto]) : renglones;
      const control = controlDeTotal(todos, totales, null);
      if (control.coincide === false && control.total !== null) {
        return `La suma de los renglones ($ ${enPesos(control.suma)}) no coincide con el total ($ ${enPesos(control.total)}): falta leer algún renglón. Repita la foto.`;
      }
    }
    return null;
  }

  /**
   * Recibe una hoja. Con el lector del sistema (y sin "Mejorar lectura") la
   * lee en el momento: si la foto no sirve (borrosa, cortada, torcida) o lo
   * que se lee de ella no sirve (renglones sin descripción, suma que no da el
   * total: `controlDeLaHoja`) NO se agrega y se le pide otra al teléfono,
   * salvo `forzar` ("Usar igual"). La lectura queda guardada al lado de la
   * foto: la cola no lee dos veces.
   */
  async recibirFoto(token: string, jpeg: Buffer, opciones: { forzar?: boolean } = {}): Promise<{ hojas: number }> {
    /** Todo lo que se puede rechazar sin tocar nada. Se repite después de leer (pasó tiempo). */
    const validar = (): Sesion => {
      const s = this.sesionOError(token);
      // El enlace puede seguir "vivo" sólo para que el teléfono vea terminar la
      // lectura de lo que mandó: para mandar más tiene que estar vigente.
      if (s.vence <= Date.now()) throw new FacturasError('El enlace venció. Vincule el teléfono de nuevo.', 'no-existe');
      if (s.bytes + jpeg.length > this.limites.bytesPorSesion) {
        throw new FacturasError('Este enlace ya envió demasiadas fotos. Vincule el teléfono de nuevo.');
      }
      const abierta = s.abierta ? this.repos.scannedInvoices.obtener(s.abierta) : null;
      if (abierta && abierta.status === 'recibiendo') {
        if (abierta.photos.length >= MAX_HOJAS) throw new FacturasError(`La factura ya tiene ${MAX_HOJAS} hojas`);
      } else {
        if (s.facturas >= this.limites.facturasPorSesion) {
          throw new FacturasError(`Este enlace ya cargó ${this.limites.facturasPorSesion} facturas. Vincule el teléfono de nuevo.`);
        }
        const cuenta = this.repos.scannedInvoices.contarPorEstado();
        const pendientes = ESTADOS_PENDIENTES.reduce((t, e) => t + (cuenta[e] ?? 0), 0);
        if (pendientes >= this.limites.pendientes) {
          throw new FacturasError('Hay demasiadas facturas esperando lectura. Espere a que se lean y vuelva a intentar.');
        }
      }
      return s;
    };

    this.sesionOError(token);
    if (!Buffer.isBuffer(jpeg) || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      throw new FacturasError('El archivo no es una foto JPEG');
    }
    if (jpeg.length > MAX_FOTO_BYTES) throw new FacturasError('La foto es demasiado grande (máximo 12 MB)');
    const sesion = validar();
    // De a una hoja por enlace (la página las manda así): quien tenga el
    // enlace no puede poner a leer cientos de fotos a la vez.
    if (sesion.recibiendo) throw new FacturasError('Espere a que termine de enviarse la hoja anterior.', 'ocupado');
    if (sesion.rechazos >= this.limites.rechazosPorSesion) {
      throw new FacturasError('Este enlace envió demasiadas fotos que no se pudieron leer. Vincule el teléfono de nuevo.');
    }
    // El cupo de bytes se gasta al INTENTAR, se acepte o no la foto: las
    // rechazadas también le costaron una lectura a la PC.
    sesion.bytes += jpeg.length;
    sesion.recibiendo = true;
    try {
      return await this.recibirFotoValidada(jpeg, opciones, validar, sesion);
    } finally {
      sesion.recibiendo = false;
    }
  }

  /**
   * ¿Se puede recibir otra hoja de este enlace ahora? Lo pregunta
   * `servidorFotos` ANTES de leer el cuerpo: mientras se lee la hoja anterior
   * (o la PC ya está leyendo las de otros teléfonos) no se guardan 12 MB más
   * en memoria; el teléfono reintenta.
   */
  puedeRecibir(token: string): boolean {
    const s = this.activo() ? this.sesionDe(token) : null;
    if (!s) return true; // el rechazo de un enlace vencido lo da `recibirFoto`
    return !s.recibiendo && this.lecturasEnCurso < this.limites.lecturasALaVez;
  }

  private async recibirFotoValidada(
    jpeg: Buffer,
    opciones: { forzar?: boolean },
    validar: () => Sesion,
    sesion: Sesion,
  ): Promise<{ hojas: number }> {
    // Control de la hoja: sólo con el lector del sistema (tarda menos de un
    // segundo) y sin «Mejorar lectura» (con Ollama interpretarla tardaría
    // minutos). Primero la calidad básica (borrosa, cortada, torcida); si pasa,
    // el control completo de lo leído (`controlDeLaHoja`). Si el lector falla,
    // la foto se acepta igual y se lee en la cola.
    let guardada: LecturaGuardada | null = null;
    if (!this.config.mejorLectura && (await this.sistemaDisponible())) {
      if (this.lecturasEnCurso >= this.limites.lecturasALaVez) {
        throw new FacturasError('La PC está leyendo otras hojas. Intente de nuevo en unos segundos.', 'ocupado');
      }
      this.lecturasEnCurso++;
      try {
        const lectura = await this.lectorSistema!.leerHoja(jpeg);
        this.log.info(`hoja controlada con ${lectura.lector ?? 'el lector del sistema'}: ${lectura.textos.length} cajas`);
        guardada = { lectura, problemas: calidadDeFoto(lectura).problemas };
      } catch (e) {
        this.log.warn(`no se pudo controlar la foto: ${(e as Error).message}`);
      } finally {
        this.lecturasEnCurso--;
      }
      if (guardada && guardada.problemas.length > 0 && opciones.forzar !== true) {
        sesion.rechazos++;
        throw new FacturasError(guardada.problemas.join(' '), 'foto');
      }
      if (guardada && opciones.forzar !== true) {
        const motivo = this.controlDeLaHoja(guardada.lectura, this.textosDeLaFacturaAbierta(sesion));
        if (motivo) {
          sesion.rechazos++;
          throw new FacturasError(motivo, 'foto');
        }
      }
    }

    // De acá en más no hay esperas: dos fotos seguidas no se pisan. (Los bytes
    // de esta foto ya se contaron: no cuentan dos veces contra el cupo.)
    sesion.bytes -= jpeg.length;
    let s: Sesion;
    try {
      s = validar();
    } finally {
      sesion.bytes += jpeg.length;
    }
    let f = s.abierta ? this.repos.scannedInvoices.obtener(s.abierta) : null;
    if (!f || f.status !== 'recibiendo') {
      f = this.repos.scannedInvoices.crear({ createdBy: s.userId });
      s.abierta = f.id;
      s.ids.push(f.id);
      s.facturas++;
    }

    // El número sale del último nombre y no de la cantidad: después de quitar
    // una hoja no se pisa ni se repite ningún archivo.
    const ultimo = f.photos[f.photos.length - 1];
    const n = (ultimo ? Number(/hoja-(\d+)\.jpg$/.exec(ultimo)?.[1] ?? f.photos.length) : 0) + 1;
    const nombre = `hoja-${n}.jpg`;
    mkdirSync(this.dirDe(f.id), { recursive: true });
    writeFileSync(join(this.dirDe(f.id), nombre), jpeg);
    if (guardada) this.guardarLectura(f.id, nombre, guardada);
    const fotos = [...f.photos, nombre];
    this.repos.scannedInvoices.actualizar(f.id, { photos: fotos });
    this.renovar(s);
    return { hojas: fotos.length };
  }

  async quitarUltimaFoto(token: string): Promise<{ hojas: number }> {
    const s = this.sesionOError(token);
    const f = s.abierta ? this.repos.scannedInvoices.obtener(s.abierta) : null;
    if (!f || f.status !== 'recibiendo' || f.photos.length === 0) return { hojas: 0 };
    const fotos = f.photos.slice(0, -1);
    const quitada = f.photos[f.photos.length - 1]!;
    this.repos.scannedInvoices.actualizar(f.id, { photos: fotos });
    try {
      rmSync(join(this.dirDe(f.id), quitada), { force: true });
      rmSync(this.rutaLectura(f.id, quitada), { force: true });
    } catch {
      /* el archivo queda huérfano en la carpeta; se va al descartar la factura */
    }
    return { hojas: fotos.length };
  }

  async cerrarFactura(token: string): Promise<{ id: string }> {
    const s = this.sesionOError(token);
    const f = s.abierta ? this.repos.scannedInvoices.obtener(s.abierta) : null;
    if (!f || f.status !== 'recibiendo') {
      // El teléfono repite el pedido si se le cortó la respuesta: la factura
      // ya está cerrada, se contesta lo mismo.
      if (s.ultima && this.repos.scannedInvoices.obtener(s.ultima)) return { id: s.ultima };
      throw new FacturasError('La factura no tiene hojas');
    }
    if (f.photos.length === 0) throw new FacturasError('La factura no tiene hojas');
    this.repos.scannedInvoices.actualizar(f.id, { status: 'en_cola', pagesDone: 0, error: null });
    s.abierta = null;
    s.ultima = f.id;
    this.renovar(s);
    this.arrancarCola();
    return { id: f.id };
  }

  estadoParaTelefono(token: string): {
    factura: null | { estado: string; hojas: number; hojasLeidas: number; error: string | null; lento: boolean };
  } {
    const s = this.activo() ? this.sesionDe(token) : null;
    const id = s?.abierta ?? s?.ultima ?? null;
    const f = id ? this.repos.scannedInvoices.obtener(id) : null;
    if (!f) return { factura: null };
    // `lento`: se lee con "Mejorar lectura" (cada hoja puede demorar minutos).
    const lento = this.leyendo?.id === f.id ? this.leyendo.lento : f.status === 'en_cola' && this.config.mejorLectura;
    return { factura: { estado: f.status, hojas: f.photos.length, hojasLeidas: f.pagesDone, error: f.error, lento } };
  }

  /**
   * Lo que sigue Compras («Cargar con el teléfono») mientras espera: las
   * facturas que mandó el enlace `sesion` (en orden) y, si se pide, una por
   * su `id` (ya no depende del enlace: puede haber vencido mientras se
   * revisaba). Con `esperaRevision`, esa factura está abierta en la revisión y
   * esta pantalla de Compras (`pantalla`) espera que vuelva: queda anotado
   * (ver `enviarACompras`). No escribe nada en la base.
   */
  seguir(input: { sesion?: unknown; id?: unknown; esperaRevision?: unknown; pantalla?: unknown } = {}): Seguimiento {
    const ahora = Date.now();
    this.olvidarEsperasViejas(ahora);
    let sesionViva: boolean | null = null;
    const ids: string[] = [];
    if (input.sesion !== undefined && input.sesion !== null) {
      const buscada = typeof input.sesion === 'string' && FORMATO_SESION.test(input.sesion) ? input.sesion : null;
      let s: Sesion | null = null;
      if (buscada) for (const x of this.sesiones.values()) if (x.id === buscada) s = x;
      sesionViva = s !== null && this.activo() && this.viva(s, ahora);
      if (s) ids.push(...s.ids);
    }
    const pedida = typeof input.id === 'string' && input.id.length > 0 && input.id.length <= 64 ? input.id : null;
    if (pedida && !ids.includes(pedida)) ids.push(pedida);
    if (pedida && input.esperaRevision === true) this.esperas.set(pedida, { desde: ahora, pantalla: pantallaDe(input.pantalla) });
    const facturas: SeguimientoFactura[] = [];
    for (const id of ids) {
      const f = this.repos.scannedInvoices.obtener(id);
      if (!f) continue;
      const lento = this.leyendo?.id === f.id ? this.leyendo.lento : f.status === 'en_cola' && this.config.mejorLectura;
      facturas.push({
        id: f.id,
        estado: f.status,
        hojas: f.photos.length,
        hojasLeidas: f.pagesDone,
        error: f.error,
        lento,
        enviadaACompras: this.pedidosACompras.get(f.id) ?? null,
      });
    }
    return { sesionViva, facturas };
  }

  private olvidarEsperasViejas(ahora: number): void {
    for (const [id, e] of this.esperas) if (ahora - e.desde > VIDA_PEDIDO_MS) this.esperas.delete(id);
    for (const [id, t] of this.pedidosACompras) if (ahora - t > VIDA_PEDIDO_MS) this.pedidosACompras.delete(id);
  }

  /* ------------------------------ cola de lectura ------------------------------ */

  /**
   * La limpieza es para lo que quedó de la sesión ANTERIOR de la app: main.ts
   * la llama en el arranque, antes de que pueda existir un enlace o una
   * lectura (`arrancar: false`), y recién después de unos segundos arranca la
   * cola (`retomarCola`: Ollama tarda en abrir al prender la PC). Por las
   * dudas, lo que es de ESTA sesión (la factura que se está leyendo, las que
   * un teléfono vinculado está mandando) no se toca nunca.
   *
   * De paso se borran las fotos de las facturas cargadas en Compras hace más
   * de 90 días: el registro queda, las fotos y el texto leído no.
   */
  reanudar(opts: { arrancar?: boolean } = {}): void {
    const repo = this.repos.scannedInvoices;
    const arrancar = opts.arrancar !== false;
    const abiertas = new Set<string>();
    for (const s of this.sesiones.values()) if (s.abierta) abiertas.add(s.abierta);
    for (const f of repo.listar({ estados: ['leyendo'], limite: 1000, sinTexto: true })) {
      if (this.leyendo?.id === f.id) continue;
      repo.actualizar(f.id, { status: 'en_cola' });
    }
    for (const f of repo.listar({ estados: ['recibiendo'], limite: 1000, sinTexto: true })) {
      if (abiertas.has(f.id)) continue;
      this.cerrarORetirar(f.id, arrancar);
    }
    const viejas = Date.now() - DIAS_FOTOS_CARGADAS * 24 * 60 * 60_000;
    for (const f of repo.listar({ estados: ['cargada'], limite: 1000, sinTexto: true })) {
      if (f.updatedAt >= viejas || f.photos.length === 0) continue;
      this.borrarFotos(f.id);
      repo.actualizar(f.id, { photos: [], pagesText: [] });
    }
    if (arrancar) this.arrancarCola();
  }

  /** Arranca la cola de lectura si hay algo esperando (main.ts, unos segundos después de abrir). */
  retomarCola(): void {
    this.arrancarCola();
  }

  /** Lee lo que haya en la cola, de a una factura. Si ya está leyendo, no hace nada. */
  private arrancarCola(): void {
    if (this.cola || !this.encendido()) return;
    // El `finally` va encadenado (y no adentro de la función) a propósito: si
    // la cola está vacía la función termina en el acto, y limpiar `cola` ahí
    // adentro ocurriría ANTES de asignarla, dejándola trabada para siempre.
    this.cola = this.correrCola().finally(() => {
      this.cola = null;
    });
  }

  private async correrCola(): Promise<void> {
    try {
      for (;;) {
        if (!this.encendido()) break;
        const f = this.repos.scannedInvoices.siguienteEnCola() as FacturaGuardada | null;
        if (!f) break;
        await this.leerFactura(f);
      }
    } catch (e) {
      this.log.error(`la cola de lectura se detuvo: ${(e as Error).message}`);
    }
  }

  /** Espera a que la cola quede vacía (tests y cierre). */
  async esperarCola(): Promise<void> {
    while (this.cola) await this.cola;
  }

  private mensajeDeError(e: unknown): string {
    if (e instanceof FalloLectorSistema) {
      return 'No se pudo leer la hoja con el lector del sistema. Puede volver a leerla, activar «Mejorar lectura» en Configuración → Facturas por teléfono o cargar la compra a mano.';
    }
    if (e instanceof OllamaError) {
      if (e.tipo === 'no-disponible') return 'El lector no respondió: Ollama no está abierto en esta PC.';
      if (e.tipo === 'modelo-faltante') return 'Falta descargar el lector de facturas (Configuración, Facturas por teléfono).';
      if (e.tipo === 'tiempo') return 'La lectura tardó demasiado y se canceló. Puede volver a leerla.';
      return `El lector falló: ${e.message.slice(0, 160)}`;
    }
    const codigo = (e as { code?: unknown } | null)?.code;
    if (codigo === 'ENOENT') return 'No se encontró la foto de una hoja. Descarte la factura y vuelva a enviarla.';
    return 'No se pudo leer la factura. Puede volver a leerla.';
  }

  private async leerFactura(f: FacturaGuardada): Promise<void> {
    const repo = this.repos.scannedInvoices;
    const corte = new AbortController();
    // Si quedó a medio leer (la app se cerró), se retoma desde la hoja que falta.
    const textos = f.pagesText.slice(0, f.photos.length);
    const estaLectura = { id: f.id, hoja: textos.length + 1, hojas: f.photos.length, lento: false, corte };
    this.leyendo = estaLectura;
    repo.actualizar(f.id, { status: 'leyendo', pagesDone: textos.length, error: null });
    const lector = new LectorFacturas({ cliente: this.clienteDe(), modelo: this.config.modelo });
    // Lector principal: el de texto del sistema (al instante). El de Ollama
    // sólo con "Mejorar lectura" o si esta PC no tiene lector del sistema.
    let conSistema = await this.leeConSistema();
    /** Alguna hoja se terminó leyendo con Ollama porque el lector del sistema falló. */
    let huboRespaldo = false;
    estaLectura.lento = !conSistema;
    let qr: DatosQr | null = null;
    /** Hojas (desde 1) que salieron cortadas en un borde: sus códigos pueden estar incompletos. */
    const hojasCortadas = new Set<number>();

    /** ¿Sigue siendo nuestra? La pudieron descartar o mandar a releer mientras se leía. */
    const vigente = (): boolean => !corte.signal.aborted && repo.obtener(f.id)?.status === 'leyendo';
    /**
     * Cancelada: si la app se cierra o se apagó la opción, vuelve a la cola
     * para seguir después; si la descartaron o la mandaron a releer, ya tiene
     * su estado nuevo y no se toca.
     */
    const soltar = (): void => {
      if (repo.obtener(f.id)?.status === 'leyendo') repo.actualizar(f.id, { status: 'en_cola' });
    };

    try {
      for (let i = textos.length; i < f.photos.length; i++) {
        estaLectura.hoja = i + 1;
        const nombre = f.photos[i]!;
        let leido: string | null = null;
        if (conSistema) {
          // Si la hoja ya se leyó al recibirla (o en una lectura anterior), no
          // se vuelve a leer la foto: se rearman los renglones de esa lectura.
          let guardada = this.lecturaGuardada(f.id, nombre);
          if (guardada && guardada.lectura.textos.length === 0) guardada = null;
          if (!guardada) {
            const jpeg = readFileSync(join(this.dirDe(f.id), nombre));
            try {
              const lectura = await this.lectorSistema!.leerHoja(jpeg);
              // Salida vacía (ni una caja de texto) cuenta como falla del lector.
              if (lectura.textos.length === 0) throw new Error('el lector del sistema no devolvió texto');
              this.log.info(`hoja ${nombre} de ${f.id} leída con ${lectura.lector ?? 'el lector del sistema'}: ${lectura.textos.length} cajas`);
              guardada = { lectura, problemas: calidadDeFoto(lectura).problemas };
              this.guardarLectura(f.id, nombre, guardada);
            } catch (e) {
              if (!vigente()) return soltar();
              // El lector del sistema dijo «disponible» y falló al leer (en
              // Windows: política de PowerShell, antivirus, tipos WinRT). Si
              // Ollama está listo, la factura sigue con ese lector; si no, el
              // error dice qué hacer.
              this.log.warn(`el lector del sistema falló en ${nombre}: ${(e as Error).message}`);
              let ollamaListo = false;
              try {
                const o = await this.sondearOllama();
                ollamaListo = Boolean(o.version && o.descargado);
              } catch {
                ollamaListo = false;
              }
              if (!ollamaListo) throw new FalloLectorSistema((e as Error).message);
              conSistema = false;
              huboRespaldo = true;
              estaLectura.lento = true;
            }
          }
          if (guardada) leido = armarRenglones(guardada.lectura).join('\n');
        }
        if (leido === null) {
          leido = await lector.leerHoja(readFileSync(join(this.dirDe(f.id), nombre)), { signal: corte.signal });
        }
        if (!vigente()) return soltar();
        textos.push(leido);
        repo.actualizar(f.id, { pagesText: textos, pagesDone: textos.length });
      }
      this.anotarLector(f.id, conSistema ? 'sistema' : huboRespaldo ? 'mixto' : 'ollama');
      if (conSistema || huboRespaldo) {
        f.photos.forEach((nombre, i) => {
          if (this.lecturaGuardada(f.id, nombre)?.problemas.some((p) => RE_AVISO_DE_BORDE.test(p))) hojasCortadas.add(i + 1);
        });
      }

      // El QR fiscal se busca hoja por hoja hasta el primero. Es lento y
      // bloquea (decodifica el JPEG en JS), así que entre hojas se le devuelve
      // el control al resto de la app.
      for (const nombre of f.photos) {
        await new Promise((r) => setImmediate(r));
        if (!vigente()) return soltar();
        try {
          qr = this.leerQr(readFileSync(join(this.dirDe(f.id), nombre)));
        } catch {
          qr = null; // mejor esfuerzo: sin QR la factura se revisa igual
        }
        if (qr) break;
      }

      // Si no se reconoce al proveedor, se conserva el que ya tenía (lo eligió
      // el usuario antes de «Volver a leer»).
      const r = await this.interpretar(f.id, textos, qr, hojasCortadas, repo.obtener(f.id)?.supplierId ?? null);
      if (!vigente()) return soltar();
      repo.actualizar(f.id, {
        status: 'lista',
        supplierId: r.supplierId,
        header: r.header as unknown as Record<string, unknown>,
        lines: r.lineas,
        pagesDone: textos.length,
        error: null,
      });
      this.ultimoError = null;
      this.log.info(`factura ${f.id} leída: ${textos.length} hojas, ${r.lineas.length} renglones`);
    } catch (e) {
      if (!vigente()) return soltar();
      const mensaje = this.mensajeDeError(e);
      this.ultimoError = mensaje;
      this.log.warn(`factura ${f.id}: ${mensaje} (${(e as Error).message})`);
      repo.actualizar(f.id, { status: 'error', error: mensaje });
    } finally {
      if (this.leyendo === estaLectura) this.leyendo = null;
      // Una lectura (sobre todo si falló) puede haber cambiado lo que se sabe de Ollama.
      this.sondeoOllama = null;
    }
  }

  /**
   * Del TEXTO de las hojas a la factura para revisar: encabezado (el QR manda;
   * sin QR, lo impreso), proveedor, renglones y sus vínculos. Lo usan la
   * lectura y el rearmado de una factura leída con una versión anterior.
   */
  private async interpretar(
    id: string,
    textos: string[],
    qr: DatosQr | null,
    hojasCortadas: ReadonlySet<number>,
    proveedorAnterior: string | null,
  ): Promise<{ header: EncabezadoFactura; supplierId: string | null; lineas: RenglonFactura[] }> {
    const leido = leerEncabezado(textos, {
      cuitPropio: await this.cuitDeLaEmpresa(),
      cuitsDescartados: this.cuitsDelComercio(id),
    });
    const header = armarEncabezado(qr, leido, this.subtotalImpreso(textos));
    const proveedor = await this.buscarProveedor(header.cuit ?? null, [leido.razonSocial, ...leido.otrosNombres], qr !== null);
    const supplierId = proveedor?.id ?? proveedorAnterior;
    const lineas: RenglonFactura[] = unirHojas(textos).map(({ codigoSuelto, ...r }) => ({
      ...r,
      articleId: null,
      // Hoja cortada en un borde (el código puede estar incompleto) o código
      // leído en una línea aparte y pegado por posición (puede ser del renglón
      // vecino): no se vincula solo por el código ni se recuerda.
      ...(hojasCortadas.has(r.hoja) || codigoSuelto ? { codigoDudoso: true } : {}),
      ...(!r.esDescuento && esRenglonDeGasto(r.descripcion) ? { esGasto: true } : {}),
    }));
    const vinculos = await this.vinculos(lineas, supplierId);
    for (const [i, v] of vinculos.entries()) {
      // Lo que sólo se puede ofrecer no se vincula solo: va primero en las sugerencias.
      if (!v || v.por === 'ofrecer') continue;
      const r = lineas[i]!;
      r.articleId = v.articulo.id;
      delete r.esGasto;
      // Unidades por bulto que el usuario confirmó para este código: la
      // factura cotiza por bulto y el artículo es la unidad. Se aplican sólo
      // si la cuenta sigue cerrando (cantidad × UxB × precio por unidad) y si
      // la factura no dice ya que la cantidad es de unidades (`packResuelto`).
      const uxb = v.por === 'proveedor' || v.por === 'descripcion' ? v.uxb : null;
      if (uxb && uxb > 1 && r.unidadesPorBulto == null && !r.packResuelto && r.estado !== 'revisar' && r.cantidad != null && r.precioUnitario != null && r.importe != null) {
        const porUnidad = Math.round((r.precioUnitario / uxb) * 10000) / 10000;
        if (cuentaCierra(r.cantidad, uxb, porUnidad, r.importe)) {
          r.unidadesPorBulto = uxb;
          r.precioUnitario = porUnidad;
          r.estado = 'corregido';
          r.motivo = `Unidades por bulto (${uxb}) recordadas de una factura anterior de este proveedor`;
        }
      }
    }
    // Lo que no salió por código ni por descripción aprendida: el artículo
    // parecido, si hay uno solo con confianza (asociador.ts). Queda «Sugerido».
    const catalogo = await this.catalogoParaAsociar();
    if (catalogo) {
      const tipo = tipoDe(header);
      const modo = await this.modoDePrecios();
      for (const [i, r] of lineas.entries()) {
        if (r.articleId || r.esDescuento || r.esGasto) continue;
        const p = this.proponer(r, catalogo.preparado, supplierId, tipo, modo);
        // Si el código leído apunta a OTRO artículo, las dos pistas no
        // coinciden: no se propone ninguno (los dos quedan como sugerencias).
        const ofrecido = vinculos[i]?.por === 'ofrecer' ? vinculos[i]!.articulo.id : null;
        if (p.articuloId && (ofrecido === null || ofrecido === p.articuloId)) {
          r.articleId = p.articuloId;
          r.sugerido = true;
        }
      }
    }
    return { header, supplierId, lineas };
  }

  /**
   * El padrón preparado para el asociador: artículos activos (sin los espejos
   * de las promociones), con su proveedor y su costo. Se arma una vez y se
   * reusa mientras no cambie la huella del padrón (cantidad y última
   * modificación). null = no se pudo armar: la factura se lee igual, sin
   * sugerencias por parecido.
   */
  private async catalogoParaAsociar(): Promise<{ preparado: CatalogoPreparado; porId: Map<string, Article> } | null> {
    try {
      const h = await this.repos.articles.huella();
      const huella = `${h.cantidad}:${h.ultimaModificacion}`;
      if (this.catalogo?.huella === huella) return this.catalogo;
      const activos = (await this.repos.articles.findAll()).filter((a) => a.active && !esEspejoDePromo(a));
      const preparado = prepararCatalogo(
        activos.map((a) => ({
          id: a.id,
          descripcion: a.description,
          marca: a.brand,
          proveedorId: a.supplierId,
          costo: Number(a.costPrice) > 0 ? Number(a.costPrice) : null,
          activo: a.active,
        })),
      );
      this.catalogo = { huella, preparado, porId: new Map(activos.map((a) => [a.id, a])) };
      this.armadosDelCatalogo++;
      return this.catalogo;
    } catch (e) {
      this.log.warn(`no se pudo preparar el padrón para sugerir artículos: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Propuesta del asociador para un renglón. El precio de la factura se pasa a
   * la base de los costos del comercio (neto o con IVA) para que la pista del
   * costo compare lo mismo. Las unidades por bulto no se pasan: el precio que
   * deja el parser ya es por unidad.
   */
  private proponer(
    r: RenglonFactura,
    catalogo: CatalogoPreparado,
    supplierId: string | null,
    tipo: 'A' | 'B' | 'C' | 'X' | null,
    modo: ModoPrecios,
  ): PropuestaAsociacion {
    const precio = r.precioUnitario;
    const enBase = precio !== null && precio > 0 && tipo ? costoParaCompras(precio, r.tasaIva ?? 21, tipo, modo) : precio;
    try {
      return proponerArticulo({ descripcion: r.descripcion, precioUnitario: enBase, unidadesPorBulto: null }, catalogo, { proveedorId: supplierId });
    } catch {
      return { articuloId: null, candidatos: [], motivo: null };
    }
  }

  /**
   * CUIT que NO pueden ser de un proveedor: los que se leyeron del texto como
   * "emisor" en facturas que el usuario asoció a proveedores DISTINTOS. Un
   * mismo CUIT en facturas de dos proveedores es el del que compra (el
   * comercio, un socio, el titular monotributista).
   */
  private cuitsDelComercio(salvo: string): string[] {
    const porCuit = new Map<string, Set<string>>();
    try {
      const filas = this.repos.scannedInvoices.listar({ estados: ['lista', 'cargada'], limite: 1000, sinTexto: true }) as unknown as FacturaGuardada[];
      for (const f of filas) {
        const h = f.header;
        if (f.id === salvo || !h || h.qr === true || !h.cuit || !f.supplierId) continue;
        const de = porCuit.get(h.cuit) ?? new Set<string>();
        de.add(f.supplierId);
        porCuit.set(h.cuit, de);
      }
    } catch {
      return [];
    }
    return [...porCuit].filter(([, de]) => de.size >= 2).map(([cuit]) => cuit);
  }

  /** ¿Hay que rearmar esta factura? Lista, leída con una versión anterior y sin correcciones del usuario. */
  private lecturaAnterior(f: FacturaGuardada): boolean {
    return f.status === 'lista' && f.photos.length > 0 && (f.header == null || (f.header.parser ?? 0) < VERSION_LECTURA);
  }

  /**
   * Rearma una factura `lista` leída con una versión anterior del lector:
   * encabezado, renglones, proveedor y vínculos salen de nuevo del texto
   * guardado (no se relee la foto). Sólo si el usuario no corrigió nada; con
   * correcciones no se toca (la revisión ofrece «Volver a leer»).
   * Devuelve true si la cambió.
   */
  private async rearmar(id: string): Promise<boolean> {
    if (this.rearmando.has(id) || this.sinRearmar.has(id)) return false;
    this.rearmando.add(id);
    try {
      const f = this.repos.scannedInvoices.obtener(id) as FacturaGuardada | null;
      if (!f || !this.lecturaAnterior(f) || f.header?.editada === true || this.leyendo?.id === id) return false;
      // Con el lector del sistema el texto se rearma de las cajas guardadas
      // (armarRenglones también puede haber mejorado); si no, el texto guardado.
      let textos = f.pagesText.slice(0, f.photos.length);
      const hojasCortadas = new Set<number>();
      if (this.lectorAnotado(id) === 'sistema') {
        const guardadas = f.photos.map((nombre) => this.lecturaGuardada(id, nombre));
        if (guardadas.every((g) => g !== null)) {
          textos = guardadas.map((g) => armarRenglones(g!.lectura).join('\n'));
          guardadas.forEach((g, i) => {
            if (g!.problemas.some((p) => RE_AVISO_DE_BORDE.test(p))) hojasCortadas.add(i + 1);
          });
        }
      }
      if (textos.length === 0 || textos.length !== f.photos.length) {
        // No quedó el texto de todas las hojas: no hay de dónde rearmar.
        this.sinRearmar.add(id);
        return false;
      }
      const r = await this.interpretar(id, textos, qrGuardado(f.header), hojasCortadas, f.supplierId);
      // Mientras se rearmaba la pudieron tocar (guardar, releer, descartar).
      const ahora = this.repos.scannedInvoices.obtener(id) as FacturaGuardada | null;
      if (!ahora || !this.lecturaAnterior(ahora) || ahora.header?.editada === true) return false;
      this.repos.scannedInvoices.actualizar(id, {
        supplierId: r.supplierId,
        header: r.header as unknown as Record<string, unknown>,
        lines: r.lineas,
        pagesText: textos,
      });
      this.log.info(`factura ${id} rearmada con la versión ${VERSION_LECTURA} del lector: ${r.lineas.length} renglones`);
      return true;
    } catch (e) {
      this.sinRearmar.add(id);
      this.log.warn(`no se pudo rearmar la factura ${id}: ${(e as Error).message}`);
      return false;
    } finally {
      this.rearmando.delete(id);
    }
  }

  /** CUIT del negocio que usa StockFlow: en la hoja figura como cliente, nunca es el proveedor. */
  private async cuitDeLaEmpresa(): Promise<string | null> {
    try {
      return (await this.repos.company.findAll())[0]?.cuit ?? null;
    } catch {
      return null;
    }
  }

  /** Subtotal impreso en el pie (la última hoja que lo trae). */
  private subtotalImpreso(textos: string[]): number | null {
    try {
      const formato = detectarFormato(textos.join('\n'));
      for (let h = textos.length - 1; h >= 0; h--) {
        const { subtotal } = totalesDelTexto(textos[h] ?? '', formato);
        if (subtotal !== null) return subtotal;
      }
    } catch {
      /* mejor esfuerzo */
    }
    return null;
  }

  /**
   * Proveedor del comprobante: por CUIT; si no hay ninguno con ese CUIT, por
   * nombre EXACTO (sin acentos ni tipo de sociedad) cuando hay uno solo y no
   * tiene cargado otro CUIT. Nada de parecidos: ante la duda queda sin asociar
   * (los parecidos se SUGIEREN en la revisión, `proveedoresSugeridos`).
   *
   * `cuitFirme` = el CUIT salió del QR fiscal. Leído del texto puede ser el del
   * que compra: si el proveedor que tiene ese CUIT NO es el que dice el nombre
   * impreso (que coincide exacto con otro proveedor), no se asocia a ninguno.
   */
  private async buscarProveedor(cuit: string | null, nombres: (string | null)[], cuitFirme = false): Promise<Supplier | null> {
    const porCuit = cuit ? await this.repos.suppliers.findByCuit(cuit) : null;
    if (porCuit && cuitFirme) return porCuit;
    const buscados = new Set(nombres.map((n) => (n ? nombreParaComparar(n) : '')).filter((n) => n.length >= 4));
    const hallados =
      buscados.size === 0 ? [] : (await this.repos.suppliers.findAll()).filter((p) => buscados.has(nombreParaComparar(p.name)));
    if (porCuit) {
      const otro = hallados.length === 1 && hallados[0]!.id !== porCuit.id;
      if (otro) this.log.warn(`el CUIT leído es del proveedor ${porCuit.code} pero el nombre impreso es el de ${hallados[0]!.code}: queda sin asociar`);
      return otro ? null : porCuit;
    }
    if (hallados.length !== 1) return null;
    const suyo = (hallados[0]!.cuit ?? '').replace(/\D/g, '');
    return cuit && suyo && suyo !== cuit ? null : hallados[0]!;
  }

  /** Con qué lector se leyeron las hojas (para saber si «Volver a leer» tiene que releer las fotos). */
  private anotarLector(id: string, lector: 'sistema' | 'ollama' | 'mixto'): void {
    try {
      writeFileSync(join(this.dirDe(id), 'lector.json'), JSON.stringify({ lector }), 'utf8');
    } catch {
      /* sin la marca, «Volver a leer» relee las fotos */
    }
  }

  private lectorAnotado(id: string): 'sistema' | 'ollama' | null {
    try {
      const l = (JSON.parse(readFileSync(join(this.dirDe(id), 'lector.json'), 'utf8')) as { lector?: unknown }).lector;
      return l === 'sistema' || l === 'ollama' ? l : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------ vínculos ------------------------------ */

  /**
   * Artículo de cada renglón, en este orden:
   *  (a) el código con que ESE proveedor ya llama a un artículo (aprendido al
   *      registrar una compra anterior) → `proveedor`;
   *  (b) el código leído es el código de barras del artículo, SÓLO si tiene
   *      forma de código de barras (`esCodigoDeBarras`) → `codigo`. Un código
   *      corto o interno del proveedor que coincide con un código del padrón
   *      puede ser otro producto: se ofrece primero y lo confirma el usuario;
   *  (c) la descripción tal cual (`claveDeVinculo`) con que ese proveedor, que
   *      no usa códigos (ROA), ya llama a un artículo → `descripcion`.
   * `ofrecer` = no se vincula solo: va primero en las sugerencias (código de
   * una hoja cortada o de una línea aparte, código del padrón sin forma de
   * código de barras, o código aprendido cuya descripción no se parece a la
   * de hoy: los códigos de proveedor no tienen dígito verificador y uno mal
   * leído al aprenderlo es el código REAL de otro producto).
   * El parecido de descripción (asociador) viene después, fuera de acá.
   * `uxb` = unidades por bulto que el usuario confirmó para ese código.
   */
  private async vinculos(
    lineas: RenglonFactura[],
    supplierId: string | null,
  ): Promise<({ articulo: Article; por: 'proveedor' | 'codigo' | 'descripcion' | 'ofrecer'; uxb: number | null } | null)[]> {
    const deProveedor = new Map<string, { articleId: string; uxb: number | null; descripcion: string | null }>();
    if (supplierId) {
      for (const c of this.repos.articleSupplierCodes.listarPorProveedor(supplierId)) {
        deProveedor.set(c.code, { articleId: c.articleId, uxb: c.unitsPerPack ?? null, descripcion: c.description ?? null });
      }
    }
    const recordado = async (clave: string | null): Promise<{ articulo: Article; uxb: number | null; descripcion: string | null } | null> => {
      const rec = clave ? deProveedor.get(clave) : undefined;
      const articulo = rec ? await this.repos.articles.findById(rec.articleId) : null;
      return articulo ? { articulo, uxb: rec!.uxb, descripcion: rec!.descripcion } : null;
    };
    const salida: ({ articulo: Article; por: 'proveedor' | 'codigo' | 'descripcion' | 'ofrecer'; uxb: number | null } | null)[] = [];
    for (const r of lineas) {
      if (r.esDescuento) {
        salida.push(null);
        continue;
      }
      const codigo = r.codigo?.trim() || null;
      let ofrecido: Article | null = null;
      // (a) Código de una hoja cortada o de una línea aparte: no se vincula
      // solo. Tampoco si el proveedor describe hoy ese código como OTRA cosa.
      if (codigo) {
        const rec = await recordado(codigo);
        if (rec && !r.codigoDudoso && descripcionesCompatibles(rec.descripcion, r.descripcion)) {
          salida.push({ articulo: rec.articulo, por: 'proveedor', uxb: rec.uxb });
          continue;
        }
        ofrecido = rec?.articulo ?? null;
      }
      // (b)
      if (codigo && !ofrecido) {
        const porCodigo = await this.repos.articles.findByBarcode(codigo);
        if (porCodigo && esCodigoDeBarras(codigo) && !r.codigoDudoso) {
          salida.push({ articulo: porCodigo, por: 'codigo', uxb: null });
          continue;
        }
        ofrecido = porCodigo;
      }
      // (c) Sin código, o con un código que puede estar cortado. Lo aprendido
      // nunca sale de una hoja cortada: si coincide tal cual, está completa.
      if (!codigo || r.codigoDudoso) {
        const rec = await recordado(claveDeVinculo({ codigo: null, descripcion: r.descripcion }));
        if (rec) {
          salida.push({ articulo: rec.articulo, por: 'descripcion', uxb: rec.uxb });
          continue;
        }
      }
      salida.push(ofrecido ? { articulo: ofrecido, por: 'ofrecer', uxb: null } : null);
    }
    return salida;
  }

  /* ------------------------------ pantalla de la PC ------------------------------ */

  /** Las claves de comprobante que aparecen en MÁS de una factura escaneada (no descartada). */
  private clavesRepetidas(filas: FacturaGuardada[]): Set<string> {
    const veces = new Map<string, number>();
    for (const f of filas) for (const c of clavesDeComprobante(f)) veces.set(c, (veces.get(c) ?? 0) + 1);
    return new Set([...veces].filter(([, n]) => n > 1).map(([c]) => c));
  }

  /**
   * Control de la suma de los renglones contra el total leído (`controlDeTotal`
   * de facturaACompra.ts, la misma cuenta que hace la revisión). En Factura A
   * los renglones son netos: para llegar al total se les suma el IVA del
   * renglón; si no se leyó, el del artículo vinculado (y si no, 21 %).
   */
  private async controlDelTotal(
    f: FacturaGuardada,
    lineas: RenglonFactura[],
    ivas: Map<string, number | null>,
  ): Promise<{ coincide: boolean | null; tipoDudoso: boolean }> {
    const h = f.header;
    if (!h || (h.importe == null && h.subtotal == null)) return { coincide: null, tipoDudoso: false };
    const leido = { total: h.importe ?? null, subtotal: h.subtotal ?? null };
    const tipo = tipoDe(h);
    const rapido = controlDeTotal(lineas, leido, tipo, () => null);
    if (rapido.coincide !== false || (tipo !== 'A' && tipo !== null)) return rapido;
    for (const r of lineas) {
      if (!r.articleId || r.tasaIva != null || ivas.has(r.articleId)) continue;
      const a = await this.repos.articles.findById(r.articleId);
      const iva = a ? Number(a.vatRate) : null;
      ivas.set(r.articleId, iva !== null && Number.isFinite(iva) ? iva : null);
    }
    return controlDeTotal(lineas, leido, tipo, (r) => (r.articleId ? (ivas.get(r.articleId) ?? null) : null));
  }

  /** Modo de precios de la empresa ('gross' si no hay empresa cargada: el valor por defecto). */
  private async modoDePrecios(): Promise<ModoPrecios> {
    try {
      return (await this.repos.company.findAll())[0]?.priceMode === 'net' ? 'net' : 'gross';
    } catch {
      return 'gross';
    }
  }

  private async resumen(
    f: FacturaGuardada,
    proveedores: Map<string, string>,
    repetidas: Set<string>,
    ivas: Map<string, number | null> = new Map(),
    modo?: ModoPrecios,
  ): Promise<FacturaResumen> {
    let nombre: string | null = null;
    if (f.supplierId) {
      if (!proveedores.has(f.supplierId)) {
        proveedores.set(f.supplierId, (await this.repos.suppliers.findById(f.supplierId))?.name ?? '');
      }
      nombre = proveedores.get(f.supplierId) || null;
    }
    const lineas = Array.isArray(f.lines) ? f.lines : [];
    const suma = lineas.reduce((t, r) => t + (typeof r?.importe === 'number' ? r.importe : 0), 0);
    const leida = f.status === 'lista' || f.status === 'cargada';
    const control = leida ? await this.controlDelTotal(f, lineas, ivas) : { coincide: null, tipoDudoso: false };
    const totalCoincide = control.coincide;
    const porRevisar = lineas.filter((r) => r?.estado === 'revisar').length;
    // Descuentos que Compras no puede precargar: la factura y la empresa
    // trabajan en bases distintas (neto / con IVA) y algún renglón de
    // descuento no trae alícuota para convertirlo. Sin revisión, la compra
    // quedaría por más que la factura.
    const tipo = tipoDe(f.header);
    const hayDescuentos = lineas.some((r) => r?.esDescuento && typeof r.importe === 'number' && r.importe !== 0);
    let descuentosSinCargar = false;
    if (leida && hayDescuentos && tipo !== null) {
      const otraBase = baseDeLaFactura(tipo) !== baseDeLaEmpresa(modo ?? (await this.modoDePrecios()));
      descuentosSinCargar = otraBase && lineas.some((r) => r?.esDescuento && r.importe !== 0 && !(typeof r.tasaIva === 'number' && r.tasaIva > 0));
    }
    const repetida = clavesDeComprobante(f).some((c) => repetidas.has(c));
    const h = f.header;
    return {
      id: f.id,
      estado: f.status,
      supplierId: f.supplierId,
      proveedor: nombre,
      hojas: f.photos.length,
      hojasLeidas: f.pagesDone,
      error: f.error,
      renglones: lineas.length,
      // El total que no coincide (o que contradice al tipo) cuenta como una cosa más para revisar.
      porRevisar: porRevisar + (totalCoincide === false ? 1 : 0) + (control.tipoDudoso ? 1 : 0),
      sumaRenglones: Math.round(suma * 100) / 100,
      total: h?.importe ?? null,
      totalCoincide,
      listaParaCargar:
        f.status === 'lista' &&
        f.supplierId != null &&
        nombre != null &&
        lineas.length > 0 &&
        porRevisar === 0 &&
        totalCoincide === true &&
        // Sin letra leída no se sabe si los precios son netos o finales: se revisa.
        tipo !== null &&
        !control.tipoDudoso &&
        !descuentosSinCargar &&
        !repetida &&
        !NOTAS_DE_CREDITO.includes(h?.tipoCmp ?? -1) &&
        lineas.some((r) => r && !r.esDescuento) &&
        lineas.every((r) => r?.esDescuento || (typeof r?.articleId === 'string' && r.articleId !== '')),
      tipoDudoso: control.tipoDudoso,
      lecturaVieja: this.lecturaAnterior(f) && f.header?.editada === true,
      proveedorLeido: h && (h.razonSocial || h.cuit) ? { razonSocial: h.razonSocial ?? null, cuit: h.cuit ?? null } : null,
      lecturaLenta: this.leyendo?.id === f.id && this.leyendo.lento,
      letra: f.header?.letra ?? null,
      tipoCmp: f.header?.tipoCmp ?? null,
      ptoVta: f.header?.ptoVta ?? null,
      nroCmp: f.header?.nroCmp ?? null,
      fecha: f.header?.fecha ?? null,
      repetida,
      creadaEl: f.createdAt,
    };
  }

  /** Las facturas que se muestran en la lista (no las descartadas ni las que el teléfono todavía está mandando). */
  async listar(opts: { limite?: number } = {}): Promise<FacturaResumen[]> {
    const proveedores = new Map<string, string>();
    // Sin el texto de las hojas: la lista se pide cada pocos segundos.
    const filas = this.repos.scannedInvoices.listar({ estados: ESTADOS_VISIBLES, limite: opts.limite ?? 200, sinTexto: true }) as unknown as FacturaGuardada[];
    // Las leídas con una versión anterior del lector (y sin correcciones) se
    // rearman acá, desde el texto guardado: lo que se ve es lo que hace el
    // lector de hoy.
    for (const [i, f] of filas.entries()) {
      if (!this.lecturaAnterior(f) || f.header?.editada === true) continue;
      if (await this.rearmar(f.id)) {
        const nueva = this.repos.scannedInvoices.obtener(f.id) as FacturaGuardada | null;
        if (nueva) filas[i] = { ...nueva, pagesText: [] };
      }
    }
    const repetidas = this.clavesRepetidas(filas);
    const ivas = new Map<string, number | null>();
    const modo = await this.modoDePrecios();
    const salida: FacturaResumen[] = [];
    for (const f of filas) salida.push(await this.resumen(f, proveedores, repetidas, ivas, modo));
    return salida;
  }

  private facturaOError(id: unknown): FacturaGuardada {
    const f = typeof id === 'string' && id ? (this.repos.scannedInvoices.obtener(id) as FacturaGuardada | null) : null;
    if (!f || f.status === 'descartada') throw new FacturasError('La factura escaneada no existe.', 'no-existe');
    return f;
  }

  /**
   * La factura con sus renglones, el artículo vinculado de cada uno (y de
   * dónde salió) y sugerencias. En una factura `lista`, el renglón que no
   * tiene vínculo (y al que el usuario no se lo quitó) recibe la propuesta del
   * asociador como «Sugerido»: así también se aprovechan los artículos que se
   * crearon después de leerla. No escribe nada: lo propuesto se guarda cuando
   * el usuario guarda la revisión.
   */
  async obtener(id: string): Promise<FacturaDetalle> {
    let f = this.facturaOError(id);
    if (this.lecturaAnterior(f) && f.header?.editada !== true && (await this.rearmar(f.id))) f = this.facturaOError(id);
    const lineas = (Array.isArray(f.lines) ? f.lines : []).map(sanearRenglon);
    const porCodigo = await this.vinculos(lineas, f.supplierId);
    const lista = f.status === 'lista';
    const modo = await this.modoDePrecios();
    const tipo = tipoDe(f.header);
    // El asociador sólo hace falta si algún renglón no tiene vínculo o tiene uno sugerido.
    const conPropuestas = lista && lineas.some((r) => !r.esDescuento && !r.esGasto && (r.sugerido === true || !r.articleId));
    const catalogo = conPropuestas ? await this.catalogoParaAsociar() : null;

    // Sugerencias de respaldo (sin asociador): el padrón se mira una sola vez.
    let padron: { articulo: Article; palabras: Set<string> }[] | null = null;
    const porPalabras = async (descripcion: string): Promise<Article[]> => {
      const buscadas = palabras(descripcion);
      if (buscadas.length === 0) return [];
      padron ??= (await this.repos.articles.findAll())
        .filter((a) => a.active && !esEspejoDePromo(a))
        .map((a) => ({ articulo: a, palabras: new Set(palabras(a.description)) }));
      return padron
        .map((p) => ({ p, aciertos: buscadas.filter((w) => p.palabras.has(w)).length }))
        // Una sola palabra en común ("fideos") no alcanza, salvo que la
        // descripción leída tenga una sola.
        .filter((x) => x.aciertos >= Math.min(2, buscadas.length))
        .sort((a, b) => b.aciertos - a.aciertos || a.p.palabras.size - b.p.palabras.size)
        .slice(0, 3)
        .map((x) => x.p.articulo);
    };

    const detalle: RenglonDetalle[] = [];
    for (const [i, r] of lineas.entries()) {
      const v = porCodigo[i];
      let articulo: Article | null = null;
      let vinculadoPor: RenglonDetalle['vinculadoPor'] = null;
      if (r.articleId) {
        articulo = await this.repos.articles.findById(r.articleId);
        // Si es el mismo que sale por código (o por la descripción aprendida),
        // se informa de dónde salió; si no, lo propuso el sistema o lo eligió
        // el usuario a mano.
        if (articulo) vinculadoPor = v && v.por !== 'ofrecer' && v.articulo.id === articulo.id ? v.por : r.sugerido ? 'sugerido' : 'guardado';
      }
      // El vínculo por código se aplica a lo que nunca se vinculó (o cuando
      // cambió el proveedor). Si el usuario lo QUITÓ, no vuelve solo.
      if (!articulo && v && v.por !== 'ofrecer' && !r.sinVinculo) {
        articulo = v.articulo;
        vinculadoPor = v.por;
      }
      const ofrecido = v?.por === 'ofrecer' ? v.articulo : null;
      const propuesta =
        catalogo && !r.esDescuento && !r.esGasto && (!articulo || vinculadoPor === 'sugerido')
          ? this.proponer(r, catalogo.preparado, f.supplierId, tipo, modo)
          : null;
      if (!articulo && !r.sinVinculo && !r.esDescuento && !r.esGasto && propuesta?.articuloId && (!ofrecido || ofrecido.id === propuesta.articuloId)) {
        const a = catalogo!.porId.get(propuesta.articuloId);
        if (a) {
          articulo = a;
          vinculadoPor = 'sugerido';
        }
      }
      let sugerencias: ArticuloDeRenglon[] = [];
      if ((!articulo || vinculadoPor === 'sugerido') && !r.esDescuento) {
        const vistas = new Set<string>();
        const candidatos: Article[] = [];
        const sumar = (a: Article | null | undefined): void => {
          if (!a || !a.active || vistas.has(a.id) || a.id === articulo?.id) return;
          vistas.add(a.id);
          candidatos.push(a);
        };
        // El artículo que tiene ese mismo código (o el vínculo que el usuario
        // quitó) va primero, pero sin vincular.
        sumar(v?.articulo);
        for (const c of propuesta?.candidatos ?? []) sumar(catalogo?.porId.get(c.articuloId));
        if (!propuesta || propuesta.candidatos.length === 0) for (const a of await porPalabras(r.descripcion)) sumar(a);
        sugerencias = candidatos.slice(0, 3).map(aArticulo);
      }
      const resto: RenglonFactura = { ...r };
      delete resto.sugerido;
      detalle.push({
        ...resto,
        articleId: articulo?.id ?? null,
        ...(vinculadoPor === 'sugerido' ? { sugerido: true } : {}),
        articulo: articulo ? aArticulo(articulo) : null,
        vinculadoPor,
        sugerencias,
        uxbRecordado: v && (v.por === 'proveedor' || v.por === 'descripcion') && articulo?.id === v.articulo.id ? v.uxb : null,
      });
    }
    // Sin proveedor: los ya cargados que pueden ser el emisor (por CUIT, por el
    // nombre o los otros nombres de la hoja, o por una palabra propia). Sólo se
    // sugieren; elige el usuario.
    let proveedoresSugeridos: ProveedorSugerido[] = [];
    const h = f.header;
    if (!f.supplierId && h && (h.razonSocial || h.cuit || (h.otrosNombres?.length ?? 0) > 0)) {
      try {
        proveedoresSugeridos = proveedoresParecidos(
          { razonSocial: h.razonSocial ?? null, cuit: h.cuit ?? null, otrosNombres: h.otrosNombres ?? [] },
          await this.repos.suppliers.findAll(),
        ).map((p) => ({ id: p.id, code: p.code, name: p.name, cuit: p.cuit ?? null }));
      } catch {
        proveedoresSugeridos = [];
      }
    }
    const otras = this.repos.scannedInvoices.listar({ estados: ESTADOS_VISIBLES, limite: 1000, sinTexto: true }) as unknown as FacturaGuardada[];
    const repetidas = this.clavesRepetidas(otras.some((o) => o.id === f.id) ? otras : [...otras, f]);
    const compraExistente = await this.compraExistente(f);
    // El resumen (y el atajo a Compras) se calcula con los vínculos de pantalla.
    const vivas: RenglonFactura[] = detalle.map(sanearRenglon);
    return {
      ...(await this.resumen({ ...f, lines: vivas }, new Map(), repetidas, new Map(), modo)),
      header: f.header ? sanearEncabezado(f.header) : null,
      lineas: detalle,
      compraExistente,
      yaCargada: this.yaCargada(f, compraExistente, otras),
      proveedoresSugeridos,
    };
  }

  /** ¿Ya hay una compra (no anulada) de ese proveedor con ese número de factura? */
  private async compraExistente(f: FacturaGuardada): Promise<CompraExistente | null> {
    const nro = f.header?.nroCmp;
    if (!f.supplierId || typeof nro !== 'number') return null;
    try {
      const compras = await this.repos.purchases.findBySupplier(f.supplierId);
      const c = compras.find(
        (x) => x.status !== 'voided' && mismoNumeroDeFactura(x.supplierInvoiceNumber, f.header?.ptoVta ?? null, nro),
      );
      if (!c) return null;
      return {
        id: c.id,
        type: c.type,
        number: c.number,
        date: c.date,
        total: c.total,
        supplierInvoiceNumber: c.supplierInvoiceNumber,
        ...(typeof c.createdAt === 'number' ? { createdAt: c.createdAt } : {}),
      };
    } catch (e) {
      this.log.warn(`no se pudo buscar la compra de la factura ${f.id}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * "Esta factura ya fue cargada el …": hay una compra registrada de ese
   * proveedor con ese número, o una factura escaneada «Cargada» con el mismo
   * comprobante (mismo proveedor o emisor y número, o el mismo CAE). La fecha
   * es la de la carga: la de la compra, o cuándo se registró la compra de
   * aquella factura escaneada.
   */
  private yaCargada(f: FacturaGuardada, compra: CompraExistente | null, otras: FacturaGuardada[]): FacturaYaCargada | null {
    if (compra) return { fecha: compra.createdAt ?? compra.date, origen: 'compra' };
    const claves = new Set(clavesDeComprobante(f));
    if (claves.size === 0) return null;
    let fecha: number | null = null;
    for (const o of otras) {
      if (o.id === f.id || o.status !== 'cargada' || !clavesDeComprobante(o).some((c) => claves.has(c))) continue;
      const cuando = typeof o.header?.cargadaEl === 'number' ? o.header.cargadaEl : o.updatedAt;
      if (fecha === null || cuando < fecha) fecha = cuando;
    }
    return fecha === null ? null : { fecha, origen: 'escaneada' };
  }

  /** Foto de una hoja como data URL (para mostrarla al lado de los renglones). */
  foto(id: string, hoja: number): string {
    const f = this.facturaOError(id);
    const n = Math.trunc(Number(hoja));
    const nombre = Number.isFinite(n) ? f.photos[n - 1] : undefined;
    // El nombre sale de la base y se vuelve a controlar: nunca una ruta.
    if (!nombre || !/^hoja-\d+\.jpg$/.test(nombre)) throw new FacturasError('La factura no tiene esa hoja.', 'no-existe');
    let datos: Buffer;
    try {
      datos = readFileSync(join(this.dirDe(f.id), nombre));
    } catch {
      throw new FacturasError('No se encontró la foto de esa hoja.', 'no-existe');
    }
    return `data:image/jpeg;base64,${datos.toString('base64')}`;
  }

  /** Guarda lo que el usuario corrigió en la revisión (proveedor, encabezado, renglones). */
  async guardar(input: { id: string; supplierId?: string | null; header?: unknown; lines?: unknown }): Promise<FacturaDetalle> {
    const f = this.facturaOError(input?.id);
    if (f.status !== 'lista') throw new FacturasError('Sólo se puede modificar una factura que está lista para revisar.', 'estado');
    const cambios: Parameters<Repositories['scannedInvoices']['actualizar']>[1] = {};
    if (input.supplierId !== undefined) {
      if (input.supplierId === null || input.supplierId === '') cambios.supplierId = null;
      else {
        const p = await this.repos.suppliers.findById(String(input.supplierId));
        if (!p) throw new FacturasError('El proveedor elegido no existe.');
        cambios.supplierId = p.id;
      }
    }
    // El encabezado conserva la versión del lector con que se leyó y queda
    // marcado como corregido por el usuario: no se rearma solo. Lo que no
    // corrige el usuario (los otros nombres leídos, cuándo se cargó) sale
    // siempre de lo guardado, no de la pantalla.
    const encabezado: EncabezadoFactura =
      (input.header !== undefined ? sanearEncabezado(input.header) : null) ??
      (f.header ? { ...f.header } : { fecha: null, cuit: null, ptoVta: null, tipoCmp: null, letra: null, nroCmp: null, importe: null, codAut: null, qr: false, origen: null });
    delete encabezado.otrosNombres;
    delete encabezado.cargadaEl;
    cambios.header = {
      ...encabezado,
      parser: f.header?.parser ?? null,
      editada: true,
      ...(Array.isArray(f.header?.otrosNombres) && f.header.otrosNombres.length > 0 ? { otrosNombres: f.header.otrosNombres } : {}),
      ...(typeof f.header?.cargadaEl === 'number' ? { cargadaEl: f.header.cargadaEl } : {}),
    } as unknown as Record<string, unknown>;
    if (input.lines !== undefined) {
      if (!Array.isArray(input.lines)) throw new FacturasError('Los renglones no son válidos.');
      if (input.lines.length > MAX_RENGLONES) throw new FacturasError(`La factura no puede tener más de ${MAX_RENGLONES} renglones.`);
      cambios.lines = input.lines.map(sanearRenglon);
    }
    this.repos.scannedInvoices.actualizar(f.id, cambios);
    return this.obtener(f.id);
  }

  /**
   * Vuelve a leer la factura. El texto de las hojas pasa de nuevo por el
   * parser (renglones, encabezado, proveedor, vínculos); las FOTOS sólo se
   * releen si hace falta:
   *  - lector del sistema: se rearman los renglones de la lectura guardada de
   *    cada hoja; la hoja que no la tiene (se leyó con el otro lector) se lee;
   *  - "Mejorar lectura": si ya se había leído con ese lector, se conserva el
   *    texto (leer de nuevo daría lo mismo y tarda minutos); si no, se relee.
   */
  async releer(id: string): Promise<FacturaResumen['estado']> {
    this.facturaOError(id);
    // Lo único que espera va primero: de acá en más todo ocurre de una vez.
    const conSistema = await this.leeConSistema();
    const f = this.facturaOError(id);
    if (f.status === 'recibiendo') throw new FacturasError('El teléfono todavía está enviando esta factura.', 'estado');
    if (f.status === 'cargada') throw new FacturasError('La factura ya se cargó en Compras.', 'estado');
    if (f.photos.length === 0) throw new FacturasError('La factura no tiene hojas');
    if (this.leyendo?.id === f.id) this.leyendo.corte.abort();
    this.sinRearmar.delete(f.id);
    const conservar = !conSistema && f.status === 'lista' && this.lectorAnotado(f.id) === 'ollama' && f.pagesText.length === f.photos.length;
    this.repos.scannedInvoices.actualizar(f.id, {
      status: 'en_cola',
      pagesText: conservar ? f.pagesText : [],
      pagesDone: conservar ? f.pagesText.length : 0,
      header: null,
      lines: [],
      error: null,
    });
    this.arrancarCola();
    return 'en_cola';
  }

  /** Descarta la factura y borra sus fotos. Una ya cargada en Compras no se descarta. */
  descartar(id: string): void {
    const f = this.facturaOError(id);
    if (f.status === 'cargada') throw new FacturasError('La factura ya se cargó en Compras.', 'estado');
    if (this.leyendo?.id === f.id) this.leyendo.corte.abort();
    for (const s of this.sesiones.values()) if (s.abierta === f.id) s.abierta = null;
    this.repos.scannedInvoices.actualizar(f.id, { status: 'descartada', photos: [], pagesText: [], error: null });
    this.borrarFotos(f.id);
    this.esperas.delete(f.id);
    this.pedidosACompras.delete(f.id);
  }

  /**
   * La revisión terminó y manda la factura a Compras. Si hay una pantalla de
   * Compras esperándola («Cargar con el teléfono»: preguntó por ella hace
   * menos de `VIDA_ESPERA_MS`), queda anotado y ESA pantalla la carga en su
   * formulario sin recargarse (y pregunta antes de pisar una compra a medio
   * armar). `recibe: false` = nadie la espera: la revisión abre Compras con la
   * factura, como siempre. La espera es de UNA pantalla (`pantalla`, el
   * identificador que recibió la revisión al abrirse desde Compras): una
   * revisión abierta desde la lista, o en otro puesto de la red, no la
   * devuelve. No crea la compra ni cambia el estado de la factura.
   */
  enviarACompras(id: string, pantalla?: unknown): { recibe: boolean } {
    const f = this.facturaOError(id);
    if (f.status !== 'lista') return { recibe: false };
    const ahora = Date.now();
    this.olvidarEsperasViejas(ahora);
    const espera = this.esperas.get(f.id);
    const recibe = espera !== undefined && ahora - espera.desde <= VIDA_ESPERA_MS && espera.pantalla === pantallaDe(pantalla);
    if (recibe) this.pedidosACompras.set(f.id, ahora);
    return { recibe };
  }

  /**
   * La compra de esta factura YA SE REGISTRÓ (lo avisa Compras al confirmar;
   * hasta entonces la factura sigue `lista`). Se recuerdan los vínculos que
   * el usuario confirmó (código del proveedor, o descripción si el proveedor
   * no usa códigos): la próxima factura sale vinculada sola. Nunca los de una
   * hoja cortada en un borde ni los artículos sugeridos que nadie aceptó.
   * `supplierId` es el proveedor con que se REGISTRÓ la compra: si en Compras
   * se eligió otro que el de la factura (un homónimo cargado dos veces, un
   * error en la revisión), los códigos se atribuyen a ése y la factura queda
   * asociada a él (así «ya cargada» y la compra existente se encuentran).
   * NO crea la compra.
   */
  async marcarCargada(input: {
    id: string;
    supplierId?: unknown;
    vinculos?: { code: string; articleId: string; unitsPerPack?: number | null }[];
  }): Promise<{ guardados: number }> {
    const f = this.facturaOError(input?.id);
    if (f.status !== 'lista' && f.status !== 'cargada') {
      throw new FacturasError('Sólo se puede cargar una factura que está lista para revisar.', 'estado');
    }
    const vinculos = Array.isArray(input.vinculos) ? input.vinculos.slice(0, MAX_RENGLONES) : [];
    let supplierId = f.supplierId;
    const elegido = typeof input.supplierId === 'string' && input.supplierId ? input.supplierId : null;
    if (elegido && elegido !== f.supplierId && (await this.repos.suppliers.findById(elegido))) {
      this.log.info(`factura ${f.id}: la compra se registró con el proveedor ${elegido} (la factura tenía ${f.supplierId ?? 'ninguno'})`);
      supplierId = elegido;
    }
    let guardados = 0;
    // Lo que no se recuerda aunque llegue: las claves de renglones de hojas
    // cortadas en un borde (un código incompleto recordado vincularía mal las
    // próximas facturas) y las de renglones que sólo tienen un artículo
    // SUGERIDO por parecido (Compras ya no las manda; esto es por las dudas).
    // Y de cada clave, cómo la describió el proveedor: la próxima factura la
    // compara antes de confiar en el código.
    const noRecordar = new Set<string>();
    const soloSugeridas = new Map<string, boolean>();
    const descripcionDe = new Map<string, string>();
    for (const r of Array.isArray(f.lines) ? f.lines : []) {
      if (!r || r.esDescuento) continue;
      const clave = claveDeVinculo(r);
      if (!clave) continue;
      if (r.codigoDudoso === true) noRecordar.add(clave);
      soloSugeridas.set(clave, (soloSugeridas.get(clave) ?? true) && r.sugerido === true && typeof r.articleId === 'string');
      if (!descripcionDe.has(clave) && typeof r.descripcion === 'string' && r.descripcion.trim()) descripcionDe.set(clave, r.descripcion);
    }
    for (const [clave, sugerida] of soloSugeridas) if (sugerida) noRecordar.add(clave);
    // Sin proveedor no hay a quién atribuirle los códigos: no se guardan.
    if (supplierId) {
      for (const v of vinculos) {
        const code = typeof v?.code === 'string' ? v.code.trim().slice(0, 130) : '';
        const articleId = typeof v?.articleId === 'string' ? v.articleId : '';
        if (!code || !articleId || noRecordar.has(code)) continue;
        // Un renglón sin código se recuerda por su descripción: la clave la
        // arma `claveDeVinculo`, nunca llega cruda.
        if (code.startsWith(PREFIJO_CLAVE_DESCRIPCION) && claveDeVinculo({ codigo: null, descripcion: code.slice(PREFIJO_CLAVE_DESCRIPCION.length) }) !== code) continue;
        const articulo = await this.repos.articles.findById(articleId);
        if (!articulo) continue;
        // Unidades por bulto con que el usuario cargó ese código (1 = sin bulto).
        const uxb = numero(v.unitsPerPack);
        const unidades = uxb !== null && uxb > 0 && uxb <= 10000 ? uxb : null;
        // Si el código ES el código de barras del artículo (y tiene forma de
        // código de barras), se vincula solo: no hace falta recordarlo, salvo
        // que haya unidades por bulto que proponer la próxima vez.
        if (articulo.barcode === code && esCodigoDeBarras(code) && (unidades === null || unidades === 1)) continue;
        this.repos.articleSupplierCodes.guardar(supplierId, code, articulo.id, unidades, descripcionDe.get(code) ?? null);
        guardados++;
      }
    }
    // Cuándo se cargó: si la misma factura se escanea otra vez, se avisa con esta fecha.
    this.repos.scannedInvoices.actualizar(f.id, {
      status: 'cargada',
      ...(supplierId !== f.supplierId ? { supplierId } : {}),
      ...(f.header && f.status === 'lista'
        ? { header: { ...f.header, cargadaEl: Date.now() } as unknown as Record<string, unknown> }
        : {}),
    });
    this.esperas.delete(f.id);
    this.pedidosACompras.delete(f.id);
    return { guardados };
  }

  /* ------------------------------ cierre ------------------------------ */

  /**
   * Corta la lectura y la descarga en curso. La factura que se estaba leyendo
   * vuelve a la cola y sigue en el próximo arranque (`reanudar`).
   */
  async apagar(): Promise<void> {
    this.apagado = true;
    this.sesiones.clear();
    this.corteDescarga?.abort();
    const id = this.leyendo?.id;
    this.leyendo?.corte.abort();
    // Por si la app sale antes de que la cola llegue a anotarlo.
    if (id && this.repos.scannedInvoices.obtener(id)?.status === 'leyendo') {
      try {
        this.repos.scannedInvoices.actualizar(id, { status: 'en_cola' });
      } catch {
        /* la base ya está cerrando: `reanudar` lo arregla al arrancar */
      }
    }
  }
}
