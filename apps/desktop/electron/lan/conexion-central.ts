/**
 * CONECTAR UNA PC DE SUCURSAL A LA CASA CENTRAL — del lado de la PC nueva.
 *
 * La PC de sucursal recién instalada no tiene licencia ni sabe nada del
 * comercio: sólo tiene dos datos que le pasó el administrador de la casa
 * central (la dirección de su Acceso remoto y un código de emparejamiento).
 * Acá se revisa la dirección, se le pregunta a la central si acepta PC de
 * sucursal y se canjea el código. La licencia que importa es la de la CENTRAL
 * (ella genera códigos y acepta emparejamientos): esta PC no necesita una.
 *
 * Cada falla termina en un mensaje que el comerciante entiende y que le dice
 * qué hacer: dirección mal escrita, sin internet, central apagada o sin Acceso
 * remoto, central sin la edición Multisucursal, código vencido o ya usado.
 * Corre en el proceso main de la terminal (allí `fetch` es el de Node, sin CORS).
 *
 * Después de emparejada, la PC comprueba ANTES de cada sesión (y cada pocos
 * minutos) que en esa dirección esté SU casa central (`verificarCentral`): si
 * otro se quedara con la dirección, la PC no le manda ni el token ni una
 * contraseña.
 *
 * Ningún pedido sigue redirecciones (`redirect: 'error'`): la central nunca
 * redirige, y una redirección se llevaría el código o el token a otro lado.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';

import { esHostDeRedLocal, normalizarUrlServidor } from '../preload-bridge';
import { ALFABETO, normalizarCodigo, pruebaEsperada } from './dispositivos';

export type MotivoCentral =
  | 'direccion'
  | 'sin_internet'
  | 'no_existe'
  | 'no_responde'
  | 'no_es_stockflow'
  | 'conexion_segura'
  | 'sin_edicion'
  | 'version_vieja'
  | 'sin_licencia'
  | 'codigo_formato'
  | 'codigo_vencido'
  | 'codigo_invalido'
  | 'pc_ya_emparejada'
  | 'bloqueado'
  /** En la dirección guardada contesta alguien que no es la central de esta PC. */
  | 'suplantacion'
  /** La central no tiene a esta PC en su lista (borrada o base restaurada). */
  | 'pc_desconocida'
  | 'otro';

export type FallaCentral = { ok: false; motivo: MotivoCentral; mensaje: string };

export type ResultadoRevision =
  | {
      ok: true;
      /** Origen normalizado (`https://host` o `http://IP:puerto`). */
      url: string;
      latencyMs: number;
      /** ¿La central acepta PC de sucursal (edición Multisucursal)? `null` = versión que no lo informa. */
      sucursales: boolean | null;
    }
  | FallaCentral;

export type ResultadoCanje = { ok: true; token: string } | FallaCentral;

/** Lo que se puede reemplazar en las pruebas. */
export interface IoCentral {
  fetch?: typeof fetch;
  /** ¿Hay internet? Por defecto, resolver un nombre conocido. */
  hayInternet?: () => Promise<boolean>;
  timeoutMs?: number;
  /** Reloj (sólo para el mensaje de fecha y hora mal puestas). */
  ahora?: () => number;
}

export const EJEMPLO_DIRECCION = 'https://sucomercio.mistockflow.com';
const DONDE_SE_GENERA = 'Configuración → Red local → PC de sucursal';

async function hayInternetPorDefecto(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vencido = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), 4000);
  });
  const consulta = lookup('cloudflare.com')
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([consulta, vencido]);
  } finally {
    clearTimeout(timer);
  }
}

function falla(motivo: MotivoCentral, mensaje: string): FallaCentral {
  return { ok: false, motivo, mensaje };
}

/** Código de error de red de Node/undici (`fetch failed` trae la causa adentro). */
function codigoDeRed(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string; message?: string } } | null;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'TIMEOUT';
  // `redirect: 'error'`: undici corta con "unexpected redirect" (sin código).
  if (/redirect/i.test(String(e?.cause?.message ?? ''))) return 'REDIRECCION';
  return String(e?.cause?.code ?? e?.code ?? e?.cause?.name ?? '');
}

/**
 * Traduce una falla de red a lo que le pasa al comerciante. Para un nombre de
 * internet, primero se descarta que sea ESTA PC la que no tiene conexión: si
 * no, "no existe la dirección" confunde a quien se quedó sin WiFi.
 */
async function fallaDeRed(err: unknown, host: string, https: boolean, io: IoCentral): Promise<FallaCentral> {
  const codigo = codigoDeRed(err);
  if (codigo === 'REDIRECCION') {
    return falla(
      'no_es_stockflow',
      `En «${host}» no hay un StockFlow (esa dirección lleva a otro lado). Revise la dirección: es la que figura en la casa central, en ${DONDE_SE_GENERA}.`,
    );
  }
  // Certificado "todavía no válido" o "vencido": con Cloudflare, casi siempre
  // es el reloj de ESTA PC (pila del BIOS agotada en una PC de mostrador).
  // Nadie piensa en el reloj si el mensaje habla de antivirus.
  if (codigo === 'CERT_NOT_YET_VALID' || codigo === 'CERT_HAS_EXPIRED') {
    return falla(
      'conexion_segura',
      `Revise la fecha y la hora de esta PC (figura ${fechaHora((io.ahora ?? Date.now)())}): si están mal, la conexión segura falla. ${dondeSeCorrigeLaHora()} y vuelva a intentar.`,
    );
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|VERIFY|SIGNATURE/i.test(codigo)) {
    return falla(
      'conexion_segura',
      `No se pudo establecer una conexión segura con «${host}». Revise la dirección (es la que figura en la casa central, en ${DONDE_SE_GENERA}); si está bien, puede ser un antivirus o un proxy de esta PC que intercepta las conexiones seguras.`,
    );
  }
  if (!esHostDeRedLocal(host)) {
    const internet = await (io.hayInternet ?? hayInternetPorDefecto)();
    if (!internet) {
      return falla('sin_internet', 'Esta PC no tiene conexión a internet. Revise el cable o el WiFi y vuelva a intentar.');
    }
    if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN' || codigo === 'EAI_NONAME') {
      return falla(
        'no_existe',
        `No existe la dirección «${host}». Revise que esté bien escrita (por ejemplo: ${EJEMPLO_DIRECCION}).`,
      );
    }
  }
  return falla(
    'no_responde',
    https
      ? `La casa central no responde en «${host}». Revise que la dirección esté bien escrita y que en la casa central StockFlow esté abierto, con el Acceso remoto encendido (Configuración → Acceso remoto → «Conectado»).`
      : // Una dirección http:// es de la red del local de la casa central (la
        // "Dirección para las cajas de este local"): desde otro local no
        // anda, y el mensaje viejo mandaba a revisar algo que estaba bien.
        `No responde ningún StockFlow en «${host}». Esa dirección sólo sirve dentro del local de la casa central: si esta PC está en otro local, use la dirección web que figura en la casa central, en ${DONDE_SE_GENERA} (empieza con https://). Si está en el mismo local, revise que StockFlow esté abierto en esa PC.`,
  );
}

function fechaHora(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function dondeSeCorrigeLaHora(): string {
  if (process.platform === 'win32') {
    return 'Corríjalas en Configuración de Windows → Hora e idioma → Fecha y hora → «Establecer la hora automáticamente»';
  }
  if (process.platform === 'darwin') {
    return 'Corríjalas en Ajustes del Sistema → General → Fecha y hora → «Ajustar la fecha y la hora automáticamente»';
  }
  return 'Corríjalas en la configuración de fecha y hora del sistema';
}

/** El error de `normalizarUrlServidor` con un ejemplo de cómo se escribe. */
export function mensajeDeDireccion(error: string): string {
  if (/^Ingrese/.test(error)) return `${error} (por ejemplo: ${EJEMPLO_DIRECCION}).`;
  return `${error.replace(/\.$/, '')}. Ejemplo: ${EJEMPLO_DIRECCION}`;
}

/**
 * Revisa la dirección que cargó el usuario y le pregunta a la central quién es
 * (`GET /lan/ping`). No decide sobre la edición: eso lo hace quien llama
 * (para emparejar hace falta; para "Probar conexión" sólo se informa).
 */
export async function revisarCentral(entrada: string, io: IoCentral = {}): Promise<ResultadoRevision> {
  const n = normalizarUrlServidor(entrada);
  if (!n.ok) return falla('direccion', mensajeDeDireccion(n.error));
  const u = new URL(n.url);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const https = u.protocol === 'https:';
  const f = io.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), io.timeoutMs ?? 10_000);
  const inicio = Date.now();
  let res: Response;
  try {
    res = await f(`${n.url}/lan/ping`, { signal: controller.signal, redirect: 'error' });
  } catch (err) {
    clearTimeout(timer);
    return fallaDeRed(err, host, https, io);
  }
  type CuerpoPing = { ok?: unknown; timestamp?: unknown; license?: unknown; sucursales?: unknown };
  const cuerpo = (await res.json().catch(() => null)) as CuerpoPing | null;
  clearTimeout(timer);
  const latencyMs = Date.now() - inicio;
  const esStockflow = res.ok && cuerpo?.ok === true && typeof cuerpo.timestamp === 'number';
  if (!esStockflow) {
    // 502/503/504 y 52x: lo que contesta Cloudflare cuando la PC de la central
    // está apagada, StockFlow cerrado o el túnel caído (530 = error 1033).
    if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530)) {
      return falla(
        'no_responde',
        `La casa central no responde en «${host}»: la PC puede estar apagada, con StockFlow cerrado o con el Acceso remoto apagado. Revise en la casa central Configuración → Acceso remoto («Conectado»).`,
      );
    }
    return falla(
      'no_es_stockflow',
      `En «${host}» no hay un StockFlow. Revise la dirección: es la que figura en la casa central, en ${DONDE_SE_GENERA}.`,
    );
  }
  if (cuerpo?.license === 'unlicensed' || cuerpo?.license === 'revoked') {
    return falla('sin_licencia', 'La casa central no tiene una licencia activa. Hasta regularizarla no se pueden conectar PC de sucursal.');
  }
  return {
    ok: true,
    url: n.url,
    latencyMs,
    sucursales: typeof cuerpo?.sucursales === 'boolean' ? cuerpo.sucursales : null,
  };
}

export const MENSAJE_SIN_EDICION =
  'La casa central no tiene habilitada la edición Multisucursal. Sin ella no se pueden conectar PC de sucursal: consulte a su proveedor de StockFlow.';
export const MENSAJE_VERSION_VIEJA =
  'La casa central tiene una versión de StockFlow que no admite PC de sucursal. Actualícela y vuelva a intentar.';

/**
 * Revisa la central y canjea el código (`POST /lan/emparejar`). Si algo falla
 * no se guarda nada: la PC queda como estaba.
 */
export async function emparejarConCentral(
  entrada: string,
  codigo: string,
  pc: { nombre: string; machineId: string },
  io: IoCentral = {},
): Promise<ResultadoCanje & { url?: string }> {
  const limpio = normalizarCodigo(codigo);
  if (!(codigo ?? '').trim()) {
    return falla('codigo_formato', `Ingrese el código de emparejamiento. Lo genera el administrador en la casa central (${DONDE_SE_GENERA}).`);
  }
  // Antes de mandarlo: un código mal copiado no tiene que sumar intentos
  // fallidos en la central (a los 5 bloquea un rato).
  if (!limpio) {
    return falla('codigo_formato', 'El código tiene 10 letras y números (por ejemplo: ABCDE-FGH23). Revise que esté completo.');
  }
  if ([...limpio].some((c) => !ALFABETO.includes(c))) {
    return falla('codigo_formato', 'El código no lleva 0, 1, O ni I: revise esas letras y números (por ejemplo: ABCDE-FGH23).');
  }
  const rev = await revisarCentral(entrada, io);
  if (!rev.ok) return rev;
  if (rev.sucursales === false) return falla('sin_edicion', MENSAJE_SIN_EDICION);
  if (rev.sucursales === null) return falla('version_vieja', MENSAJE_VERSION_VIEJA);

  const u = new URL(rev.url);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const f = io.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(io.timeoutMs ?? 10_000, 15_000));
  type CuerpoCanje = { ok?: boolean; motivo?: string; message?: string; data?: { token?: unknown } };
  let res: Response;
  let cuerpo: CuerpoCanje | null;
  try {
    res = await f(`${rev.url}/lan/emparejar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ codigo: limpio, nombre: pc.nombre, machineId: pc.machineId }),
      signal: controller.signal,
      // Un 307/308 reenviaría el código (y el nombre de la PC) a cualquier lado.
      redirect: 'error',
    });
    cuerpo = (await res.json().catch(() => null)) as CuerpoCanje | null;
  } catch (err) {
    return fallaDeRed(err, host, u.protocol === 'https:', io);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok && cuerpo?.ok && typeof cuerpo.data?.token === 'string') {
    return { ok: true, token: cuerpo.data.token, url: rev.url };
  }
  const mensajeServidor = typeof cuerpo?.message === 'string' ? cuerpo.message : '';
  switch (res.status) {
    case 404:
      // Entre el ping y el canje la central bajó de edición.
      return falla('sin_edicion', MENSAJE_SIN_EDICION);
    case 401: {
      const vencido = cuerpo?.motivo === 'vencido' || (!cuerpo?.motivo && /venci/i.test(mensajeServidor));
      return vencido
        ? falla('codigo_vencido', `El código venció (dura 15 minutos). Genere uno nuevo en la casa central (${DONDE_SE_GENERA}).`)
        : falla('codigo_invalido', `El código no es válido o ya se usó. Revise que esté bien copiado o genere uno nuevo en la casa central (${DONDE_SE_GENERA}).`);
    }
    case 409:
      return falla(
        'pc_ya_emparejada',
        `Esta PC ya figura emparejada en la casa central. Para emparejarla de nuevo, revóquela allí (${DONDE_SE_GENERA}) y vuelva a cargar el mismo código.`,
      );
    case 429:
      return falla('bloqueado', mensajeServidor || 'Demasiados intentos fallidos. Espere unos minutos y vuelva a intentar.');
    default:
      // Sin códigos HTTP ni mensajes técnicos del servidor: no le dicen nada
      // al comerciante.
      return falla('otro', 'La casa central no aceptó la conexión. Vuelva a intentar en unos minutos; si sigue igual, avise a la casa central.');
  }
}

/* ------------------------------------------------------------------------ */
/* ¿Es SU casa central? (después de emparejada)                              */
/* ------------------------------------------------------------------------ */

export type ResultadoVerificacion = { ok: true } | FallaCentral;

/** Cómo volver a conectar la PC desde el ingreso (sin sesión no hay Configuración). */
export const COMO_RECONECTAR = 'en la pantalla de ingreso, «Conectar esta PC con un código nuevo»';

function iguales(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Le pide a la dirección guardada que pruebe que es la casa central con la
 * que se emparejó esta PC (`POST /lan/central`, ver dispositivos.ts →
 * `pruebaDeCentral`). Se llama ANTES de mandar el token o una contraseña.
 *
 *  - Prueba correcta → `ok`.
 *  - Sin respuesta (central apagada, sin internet) → `no_responde` o
 *    `sin_internet`: el pedido tampoco habría llegado.
 *  - La central no conoce esta PC → `pc_desconocida`: hay que conectarla de nuevo.
 *  - Cualquier otra cosa (prueba que no coincide, otra página, redirección) →
 *    `suplantacion`: la PC no manda nada.
 */
export async function verificarCentral(base: string, token: string, io: IoCentral = {}): Promise<ResultadoVerificacion> {
  const n = normalizarUrlServidor(base);
  if (!n.ok) return falla('direccion', mensajeDeDireccion(n.error));
  const u = new URL(n.url);
  const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  const nonce = randomBytes(32).toString('base64url');
  const esperado = pruebaEsperada(token, nonce);
  if (!esperado) {
    return falla('pc_desconocida', `Los datos de conexión de esta PC están dañados. Vuelva a conectarla con un código nuevo: ${COMO_RECONECTAR}.`);
  }
  const suplantacion = falla(
    'suplantacion',
    `La dirección «${host}» no responde como la casa central con la que se conectó esta PC. Por seguridad, esta PC no le envía su usuario ni su contraseña. Avise a la casa central: puede ser una dirección cambiada o alguien que se hace pasar por ella.`,
  );
  const f = io.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), io.timeoutMs ?? 8_000);
  let res: Response;
  let cuerpo: { ok?: unknown; prueba?: unknown; motivo?: unknown } | null;
  try {
    res = await f(`${n.url}/lan/central`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dispositivoId: esperado.dispositivoId, nonce }),
      signal: controller.signal,
      redirect: 'error',
    });
    cuerpo = (await res.json().catch(() => null)) as typeof cuerpo;
  } catch (err) {
    if (codigoDeRed(err) === 'REDIRECCION') return suplantacion;
    return fallaDeRed(err, host, u.protocol === 'https:', io);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 502 || res.status === 503 || res.status === 504 || (res.status >= 520 && res.status <= 530)) {
    return falla(
      'no_responde',
      `La casa central no responde en «${host}»: la PC puede estar apagada, con StockFlow cerrado o sin internet. Avise a la casa central y vuelva a intentar.`,
    );
  }
  if (res.status === 404 && cuerpo?.motivo === 'desconocida') {
    return falla(
      'pc_desconocida',
      `La casa central no reconoce esta PC: pudo haber sido borrada de su lista o la casa central volvió a una copia vieja de sus datos. Pida un código nuevo y vuelva a conectarla: ${COMO_RECONECTAR}.`,
    );
  }
  if (res.ok && cuerpo?.ok === true && typeof cuerpo.prueba === 'string' && iguales(cuerpo.prueba, esperado.prueba)) {
    return { ok: true };
  }
  return suplantacion;
}

/**
 * Lo verificado se recuerda un rato: la interfaz hace varios pedidos por
 * minuto y no hace falta preguntar en cada uno. Al iniciar sesión se verifica
 * de nuevo siempre (`forzar`). Una falla se recuerda unos segundos, para que
 * diez pedidos simultáneos no salgan diez veces a la red.
 */
const VIGENCIA_VERIFICADA_MS = 5 * 60_000;
const VIGENCIA_FALLA_MS = 3_000;
const verificaciones = new Map<string, { resultado: ResultadoVerificacion; en: number }>();
const verificando = new Map<string, Promise<ResultadoVerificacion>>();

export async function verificarCentralRecordando(
  base: string,
  token: string,
  opciones: { forzar?: boolean; io?: IoCentral } = {},
): Promise<ResultadoVerificacion> {
  const clave = `${base}|${token.split('.')[1] ?? ''}`;
  const previa = verificaciones.get(clave);
  if (previa && !opciones.forzar) {
    const vigencia = previa.resultado.ok ? VIGENCIA_VERIFICADA_MS : VIGENCIA_FALLA_MS;
    if (Date.now() - previa.en < vigencia) return previa.resultado;
  }
  const enCurso = verificando.get(clave);
  if (enCurso) return enCurso;
  const p = verificarCentral(base, token, opciones.io)
    .then((resultado) => {
      verificaciones.set(clave, { resultado, en: Date.now() });
      return resultado;
    })
    .finally(() => verificando.delete(clave));
  verificando.set(clave, p);
  return p;
}

/** Para las pruebas: olvidar lo verificado. */
export function olvidarVerificacionesDeCentral(): void {
  verificaciones.clear();
  verificando.clear();
}
