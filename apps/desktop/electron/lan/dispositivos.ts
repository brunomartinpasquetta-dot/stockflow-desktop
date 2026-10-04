/**
 * PC DE SUCURSAL EMPAREJADAS (multisucursal, etapa 1).
 *
 * Problema: la PC de la sucursal trabaja contra el servidor por el túnel
 * (`https://<comercio>.mistockflow.com`), y por esa puerta el servidor aplica
 * la lista CORTA de canales (`remotoAccepts`): sin ARCA ni Mercado Pago, para
 * que una contraseña robada no sirva para facturar a nombre del comercio. Eso
 * está bien para el dueño mirando desde su casa, pero deja a la sucursal
 * vendiendo todo en Remito X.
 *
 * Solución: la PC de la sucursal se EMPAREJA una vez. El administrador genera
 * en el servidor un código de un solo uso (10 caracteres, vence a los 15
 * minutos); la PC lo canjea en `POST /lan/emparejar` y recibe un token de
 * dispositivo que guarda cifrado y manda en cada pedido. Con un token válido,
 * el túnel le aplica la lista de la red local. El administrador ve la lista de
 * PC emparejadas y puede revocar cualquiera; la revocación corta en el pedido
 * siguiente.
 *
 * Decisiones:
 *  - Persistencia en una TABLA (`dispositivos_sucursal`, migración 0041) y no
 *    en un JSON de userData: viaja con los backups y con la base cuando se
 *    cambia la PC servidor (un JSON aparte se pierde y deja a la sucursal sin
 *    vender), y queda junto a `audit_log` para auditar.
 *  - El servidor guarda SÓLO el hash SHA-256 del secreto. Es un secreto de 32
 *    bytes al azar: no hace falta un hash lento (no hay diccionario posible).
 *  - Formato del token: `sfd1.<id>.<secreto base64url>`. Se busca la fila por
 *    `id` y se compara el hash en tiempo constante (`timingSafeEqual`); nunca
 *    se busca "por hash" en SQL.
 *  - Los códigos viven en MEMORIA: duran 15 minutos y no tienen por qué
 *    sobrevivir a un reinicio (se genera otro). Se comparan en tiempo constante
 *    contra todos los vigentes.
 *  - Emparejar una PC cuyo machineId ya tiene una fila ACTIVA se rechaza
 *    (`ocupado`): hay que revocarla antes en el servidor. Antes se reemplazaba
 *    en silencio y quien consiguiera un código podía sacar de servicio a una
 *    caja ajena y quedarse con su identidad (y su caja abierta). El código no
 *    se consume: el administrador revoca y la PC vuelve a intentar.
 *  - El machineId lo declara la PC: no es prueba de nada. Por eso la caja de
 *    una PC emparejada es `disp:<machineId>` (terminal-actual.ts), un espacio
 *    de nombres que ninguna terminal de la red puede declarar.
 *  - Auditoría: el canje queda con la red/IP del visitante, por dónde entró,
 *    el id del dispositivo y un fragmento del machineId. Los canjes fallidos y
 *    los tokens inválidos o revocados también, con un tope por ventana para no
 *    inundar `audit_log`.
 *  - IDENTIDAD DE LA CASA CENTRAL (al revés: la PC de sucursal comprueba a la
 *    central). Antes de mandar su token o una contraseña, la PC de sucursal le
 *    pide a la dirección guardada que pruebe que es SU central: le manda el id
 *    del dispositivo y un número al azar, y la central contesta
 *    HMAC(hash del secreto, número). La central guarda ese hash; quien se haga
 *    pasar por ella en esa dirección no lo tiene y la PC no le manda nada (ver
 *    `pruebaDeCentral` y conexion-central.ts → `verificarCentral`).
 */
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import type { DispositivoSucursalDTO } from '../ipc/types';
import { tieneMultisucursal, type DepsConLicencia } from '../license/funciones';

/** Sin I, O, 0 ni 1: se dictan por teléfono sin confundirse. 32 símbolos → 50 bits. */
export const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 10;
export const VIGENCIA_CODIGO_MS = 15 * 60_000;
/** Códigos vivos a la vez: alcanza para emparejar varias PC sin dejar la puerta abierta. */
const MAX_CODIGOS_VIVOS = 10;
/** El último uso se graba como mucho cada 5 minutos: cada escritura es un fsync. */
const INTERVALO_ULTIMO_USO_MS = 5 * 60_000;
/** Incidentes (canjes fallidos, tokens inválidos) que se auditan por ventana. */
const MAX_INCIDENTES_POR_VENTANA = 20;
const VENTANA_INCIDENTES_MS = 10 * 60_000;
/** Un incidente con la misma clave (misma PC revocada, misma red) se audita como mucho una vez por hora. */
const REPETICION_INCIDENTE_MS = 60 * 60_000;
const PREFIJO_TOKEN = 'sfd1';
/** Id de dispositivo (uuid) tal como viaja en el token. */
const ID_VALIDO = /^[0-9a-f-]{36}$/;
/** Número al azar del pedido de identidad: base64url, de 16 bytes para arriba. */
const NONCE_VALIDO = /^[A-Za-z0-9_-]{22,128}$/;
/** Separador de dominio de la prueba de identidad: la firma no sirve para otra cosa. */
const DOMINIO_PRUEBA = 'stockflow-central-v1';

/**
 * Lo que se usa de better-sqlite3 (`db.$client`). Estructural a propósito:
 * así el módulo no depende de cómo resuelvan los tipos del driver.
 */
export interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
}

export interface DispositivoVerificado {
  id: string;
  nombre: string;
  machineId: string;
}

export interface AutorDeCambio {
  id: string | null;
  nombre: string;
}

export type ResultadoCanje =
  | { ok: true; token: string; dispositivoId: string; nombre: string }
  | { ok: false; motivo: 'invalido' | 'vencido' | 'datos' | 'ocupado' };

/** Desde dónde llega un pedido: red/IP del visitante y por qué puerta. */
export interface OrigenPedido {
  ip: string;
  via: 'tunel' | 'lan';
}

/** Lo que LanServer necesita (y los tests pueden simular). */
export interface DispositivosLike {
  canjear(input: { codigo: unknown; nombre: unknown; machineId: unknown }, origen?: OrigenPedido): ResultadoCanje;
  verificar(token: string, origen?: OrigenPedido): DispositivoVerificado | null;
  /**
   * ¿Es el token (bien formado y con el secreto correcto) de una PC que fue
   * revocada? Es una PC conocida que sigue prendida, no alguien adivinando:
   * no suma al contador de intentos fallidos.
   */
  esRevocado?(token: string): boolean;
  /**
   * Deja constancia de un incidente (con tope por ventana). Con `clave`, el
   * mismo incidente no se repite en la auditoría por una hora (una PC revocada
   * que sigue prendida reintenta cada 20 segundos).
   */
  registrarIncidente?(descripcion: string, clave?: string): void;
  /**
   * Prueba de identidad de la casa central para ese dispositivo y ese número
   * al azar (ver `pruebaDeCentral`), o null si el dispositivo no existe.
   */
  probarIdentidad?(dispositivoId: unknown, nonce: unknown): string | null;
}

/**
 * PRUEBA DE IDENTIDAD DE LA CASA CENTRAL: HMAC-SHA256 con el hash del secreto
 * del token (lo que la central guarda) sobre el id del dispositivo y el número
 * al azar que eligió la PC de sucursal. Sólo puede calcularla quien tiene ese
 * hash: la central de verdad (o la PC dueña del token, que tiene el secreto).
 */
export function pruebaDeCentral(tokenHashHex: string, dispositivoId: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(tokenHashHex, 'hex'))
    .update(`${DOMINIO_PRUEBA}|${dispositivoId}|${nonce}`, 'utf8')
    .digest('hex');
}

/**
 * Del lado de la PC de sucursal: qué tiene que contestar la casa central para
 * ESTE token y este número al azar. null si el token no tiene el formato.
 */
export function pruebaEsperada(token: string, nonce: string): { dispositivoId: string; prueba: string } | null {
  if (typeof token !== 'string' || token.length > 200) return null;
  const partes = token.split('.');
  if (partes.length !== 3 || partes[0] !== PREFIJO_TOKEN) return null;
  const [, id, secreto] = partes as [string, string, string];
  if (!ID_VALIDO.test(id) || !secreto) return null;
  return { dispositivoId: id, prueba: pruebaDeCentral(sha256Hex(secreto), id, nonce) };
}

function describirOrigen(o: OrigenPedido | undefined): string {
  if (!o) return 'origen desconocido';
  return `${o.ip || '¿?'} ${o.via === 'tunel' ? 'por internet' : 'en la red local'}`;
}

export interface OpcionesDispositivos {
  /** Reloj inyectable (tests de vencimiento). */
  ahora?: () => number;
  /**
   * Registro de auditoría: emparejar y revocar quedan en `audit_log`. Se pasa
   * desde afuera para no acoplar este módulo a los repositorios.
   */
  auditar?: (e: { userId: string | null; username: string; description: string }) => void;
}

interface CodigoVivo {
  vence: number;
  creadoPor: AutorDeCambio | null;
}

interface FilaDispositivo {
  id: string;
  nombre: string;
  machine_id: string;
  token_hash: string;
  estado: string;
  creado_en: number;
  ultimo_uso_en: number | null;
  revocado_en: number | null;
  creado_desde: string | null;
  ultima_ip: string | null;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Mayúsculas, sin guiones ni espacios: así se lo dicte como se lo dicte. */
export function normalizarCodigo(codigo: unknown): string | null {
  if (typeof codigo !== 'string') return null;
  const limpio = codigo.toUpperCase().replace(/[\s-]/g, '');
  return limpio.length === LARGO_CODIGO ? limpio : null;
}

/** Para mostrar: dos grupos de cinco (`ABCDE-FGH23`). */
export function formatearCodigo(codigo: string): string {
  return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
}

/** Nombre de PC seguro para guardar y mostrar: sin caracteres de control, acotado. */
function limpiarNombre(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  return s || null;
}

function limpiarMachineId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return /^[A-Za-z0-9._:-]{8,128}$/.test(v) ? v : null;
}

export class DispositivosSucursal implements DispositivosLike {
  private readonly codigos = new Map<string, CodigoVivo>();
  private readonly ultimoUsoGrabado = new Map<string, { en: number; ip: string | null }>();
  private readonly ahora: () => number;
  /** Instantes de los incidentes auditados en la ventana (tope anti-inundación). */
  private incidentes: number[] = [];
  private topeAvisado = false;
  /** clave → última vez que se auditó (para no repetir el mismo incidente). */
  private readonly incidentesPorClave = new Map<string, number>();

  constructor(
    private readonly sqlite: SqliteLike,
    private readonly opts: OpcionesDispositivos = {},
  ) {
    this.ahora = opts.ahora ?? (() => Date.now());
  }

  private purgarVencidos(): void {
    const t = this.ahora();
    for (const [c, v] of this.codigos) if (v.vence <= t) this.codigos.delete(c);
  }

  /** Genera un código de un solo uso. Lo llama el administrador en el servidor. */
  generarCodigo(creadoPor: AutorDeCambio | null): { codigo: string; venceEn: number } {
    this.purgarVencidos();
    // Tope de códigos vivos: se descarta el más viejo antes que dejar crecer
    // la cantidad de puertas abiertas.
    while (this.codigos.size >= MAX_CODIGOS_VIVOS) {
      const primero = this.codigos.keys().next().value;
      if (primero === undefined) break;
      this.codigos.delete(primero);
    }
    let codigo = '';
    for (let i = 0; i < LARGO_CODIGO; i++) codigo += ALFABETO[randomInt(0, ALFABETO.length)];
    const venceEn = this.ahora() + VIGENCIA_CODIGO_MS;
    this.codigos.set(codigo, { vence: venceEn, creadoPor });
    return { codigo: formatearCodigo(codigo), venceEn };
  }

  /**
   * Canjea un código por un token de dispositivo. El código se consume en el
   * primer canje válido. El token se devuelve UNA vez y no se guarda.
   */
  canjear(input: { codigo: unknown; nombre: unknown; machineId: unknown }, origen?: OrigenPedido): ResultadoCanje {
    const nombre = limpiarNombre(input.nombre);
    const machineId = limpiarMachineId(input.machineId);
    const pedido = normalizarCodigo(input.codigo);
    if (!pedido) return { ok: false, motivo: 'invalido' };
    // Se recorren TODOS los códigos con comparación en tiempo constante: el
    // tiempo de respuesta no dice cuántos caracteres se acertaron.
    const b = Buffer.from(pedido, 'utf8');
    let hallado: string | null = null;
    for (const c of this.codigos.keys()) {
      const a = Buffer.from(c, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) hallado = c;
    }
    if (!hallado) return { ok: false, motivo: 'invalido' };
    const vivo = this.codigos.get(hallado)!;
    if (vivo.vence <= this.ahora()) {
      this.codigos.delete(hallado);
      return { ok: false, motivo: 'vencido' };
    }
    // Datos de la PC inválidos: el código NO se consume (es un error del
    // programa, no un intento de adivinar).
    if (!nombre || !machineId) return { ok: false, motivo: 'datos' };

    // Esa PC (machineId) ya está emparejada y activa: NO se reemplaza en
    // silencio. Quien tenga un código podría si no revocar una caja ajena y
    // heredar su identidad. El código no se consume: el administrador revoca
    // la PC vieja en Configuración y se vuelve a intentar con el mismo.
    const activa = this.sqlite
      .prepare(`SELECT id, nombre FROM dispositivos_sucursal WHERE machine_id = ? AND estado = 'activo' LIMIT 1`)
      .get(machineId) as { id: string; nombre: string } | undefined;
    if (activa) {
      this.registrarIncidente(
        `Emparejamiento rechazado: la PC ${machineId.slice(0, 12)}… ya está emparejada como «${activa.nombre}» ` +
          `(se pidió como «${nombre}», ${describirOrigen(origen)})`,
      );
      return { ok: false, motivo: 'ocupado' };
    }
    this.codigos.delete(hallado);

    const id = randomUUID();
    const secreto = randomBytes(32).toString('base64url');
    const ahora = this.ahora();
    const desde = origen ? describirOrigen(origen) : null;
    this.sqlite
      .prepare(
        `INSERT INTO dispositivos_sucursal (id, nombre, machine_id, token_hash, estado, creado_en, creado_por, creado_desde, ultima_ip)
           VALUES (?, ?, ?, ?, 'activo', ?, ?, ?, ?)`,
      )
      .run(id, nombre, machineId, sha256Hex(secreto), ahora, vivo.creadoPor?.id ?? null, desde, origen?.ip ?? null);
    this.opts.auditar?.({
      userId: vivo.creadoPor?.id ?? null,
      username: vivo.creadoPor?.nombre ?? '—',
      description:
        `PC de sucursal emparejada: ${nombre} (dispositivo ${id.slice(0, 8)}, PC ${machineId.slice(0, 12)}…, ` +
        `${desde ?? 'origen desconocido'}; código generado por ${vivo.creadoPor?.nombre ?? '—'})`,
    });
    return { ok: true, token: `${PREFIJO_TOKEN}.${id}.${secreto}`, dispositivoId: id, nombre };
  }

  /**
   * Deja un incidente en la auditoría (canje fallido, token inválido o de una
   * PC revocada, emparejamiento rechazado). Tope: MAX_INCIDENTES_POR_VENTANA
   * cada 10 minutos, más una línea avisando que se alcanzó; así alguien que
   * prueba códigos no llena `audit_log`.
   */
  registrarIncidente(descripcion: string, clave?: string): void {
    const t = this.ahora();
    if (clave) {
      const previo = this.incidentesPorClave.get(clave);
      if (previo !== undefined && t - previo < REPETICION_INCIDENTE_MS) return;
      if (this.incidentesPorClave.size > 1000) this.incidentesPorClave.clear();
      this.incidentesPorClave.set(clave, t);
    }
    this.incidentes = this.incidentes.filter((x) => t - x < VENTANA_INCIDENTES_MS);
    if (this.incidentes.length === 0) this.topeAvisado = false;
    if (this.incidentes.length >= MAX_INCIDENTES_POR_VENTANA) {
      if (!this.topeAvisado) {
        this.topeAvisado = true;
        this.opts.auditar?.({
          userId: null,
          username: '—',
          description: `Demasiados incidentes de PC de sucursal: se dejan de registrar por 10 minutos`,
        });
      }
      return;
    }
    this.incidentes.push(t);
    this.opts.auditar?.({ userId: null, username: '—', description: descripcion });
  }

  /** Fila del token si el secreto coincide (activa o no); null si no. */
  private filaDelToken(
    token: string,
  ): Pick<FilaDispositivo, 'id' | 'nombre' | 'machine_id' | 'estado'> | null {
    if (typeof token !== 'string' || token.length > 200) return null;
    const partes = token.split('.');
    if (partes.length !== 3 || partes[0] !== PREFIJO_TOKEN) return null;
    const [, id, secreto] = partes as [string, string, string];
    if (!ID_VALIDO.test(id) || !secreto) return null;
    const fila = this.sqlite
      .prepare(`SELECT id, nombre, machine_id, token_hash, estado FROM dispositivos_sucursal WHERE id = ?`)
      .get(id) as Pick<FilaDispositivo, 'id' | 'nombre' | 'machine_id' | 'token_hash' | 'estado'> | undefined;
    // Se calcula el hash igual aunque no haya fila: mismo trabajo en los dos caminos.
    const esperado = Buffer.from(fila?.token_hash ?? '0'.repeat(64), 'hex');
    const recibido = Buffer.from(sha256Hex(secreto), 'hex');
    const coincide = esperado.length === recibido.length && timingSafeEqual(esperado, recibido);
    if (!fila || !coincide) return null;
    return fila;
  }

  /** Valida un token de dispositivo. null = inválido, revocado o desconocido. */
  verificar(token: string, origen?: OrigenPedido): DispositivoVerificado | null {
    const fila = this.filaDelToken(token);
    if (!fila || fila.estado !== 'activo') return null;
    this.marcarUso(fila.id, origen?.ip ?? null);
    return { id: fila.id, nombre: fila.nombre, machineId: fila.machine_id };
  }

  esRevocado(token: string): boolean {
    const fila = this.filaDelToken(token);
    return !!fila && fila.estado !== 'activo';
  }

  /**
   * Contesta el pedido de identidad de una PC de sucursal (ver
   * `pruebaDeCentral`). No depende del estado: una PC revocada también recibe
   * la prueba, y después su pedido recibe el 401 de siempre ("ya no está
   * autorizada"), que es lo que le dice qué hacer. No habilita nada.
   */
  probarIdentidad(dispositivoId: unknown, nonce: unknown): string | null {
    if (typeof dispositivoId !== 'string' || !ID_VALIDO.test(dispositivoId)) return null;
    if (typeof nonce !== 'string' || !NONCE_VALIDO.test(nonce)) return null;
    const fila = this.sqlite
      .prepare(`SELECT token_hash FROM dispositivos_sucursal WHERE id = ?`)
      .get(dispositivoId) as { token_hash: string } | undefined;
    if (!fila) return null;
    return pruebaDeCentral(fila.token_hash, dispositivoId, nonce);
  }

  private marcarUso(id: string, ip: string | null): void {
    const t = this.ahora();
    const previo = this.ultimoUsoGrabado.get(id);
    // Cada 5 minutos, o antes si cambió la red desde la que opera.
    if (previo && t - previo.en < INTERVALO_ULTIMO_USO_MS && (ip === null || ip === previo.ip)) return;
    this.ultimoUsoGrabado.set(id, { en: t, ip: ip ?? previo?.ip ?? null });
    try {
      if (ip) {
        this.sqlite.prepare(`UPDATE dispositivos_sucursal SET ultimo_uso_en = ?, ultima_ip = ? WHERE id = ?`).run(t, ip, id);
      } else {
        this.sqlite.prepare(`UPDATE dispositivos_sucursal SET ultimo_uso_en = ? WHERE id = ?`).run(t, id);
      }
    } catch {
      /* el último uso es informativo: nunca frena un pedido */
    }
  }

  /** Lista para Configuración (sin hashes). Activos primero, después los más nuevos. */
  listar(): DispositivoSucursalDTO[] {
    const filas = this.sqlite
      .prepare(
        `SELECT id, nombre, machine_id, estado, creado_en, ultimo_uso_en, revocado_en, creado_desde, ultima_ip
           FROM dispositivos_sucursal
           ORDER BY CASE estado WHEN 'activo' THEN 0 ELSE 1 END, creado_en DESC`,
      )
      .all() as Omit<FilaDispositivo, 'token_hash'>[];
    return filas.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      estado: f.estado === 'activo' ? 'activo' : 'revocado',
      creadoEn: f.creado_en,
      ultimoUsoEn: f.ultimo_uso_en ?? null,
      revocadoEn: f.revocado_en ?? null,
      // Para distinguir dos PC con el mismo nombre: fragmentos, no el dato entero.
      idCorto: f.id.slice(0, 8),
      pcCorta: f.machine_id.slice(0, 8),
      creadoDesde: f.creado_desde ?? null,
      ultimaIp: f.ultima_ip ?? null,
    }));
  }

  /** Revoca una PC: su token deja de valer en el pedido siguiente. */
  revocar(id: string, por: AutorDeCambio | null): boolean {
    const fila = this.sqlite
      .prepare(`SELECT nombre, estado FROM dispositivos_sucursal WHERE id = ?`)
      .get(id) as { nombre: string; estado: string } | undefined;
    if (!fila || fila.estado !== 'activo') return false;
    this.sqlite
      .prepare(`UPDATE dispositivos_sucursal SET estado = 'revocado', revocado_en = ?, revocado_por = ? WHERE id = ?`)
      .run(this.ahora(), por?.id ?? null, id);
    this.ultimoUsoGrabado.delete(id);
    this.opts.auditar?.({
      userId: por?.id ?? null,
      username: por?.nombre ?? '—',
      description: `PC de sucursal revocada: ${fila.nombre} (dispositivo ${id.slice(0, 8)})`,
    });
    return true;
  }
}

/* ------------------------------------------------------------------------ */
/* Una sola instancia por base                                              */
/* ------------------------------------------------------------------------ */

/**
 * Los códigos viven en memoria, así que el que los genera (handler IPC de
 * Configuración) y el que los canjea (LanServer) tienen que ser el MISMO
 * objeto. main.ts arma los handlers dos veces (IPC y LanServer) con los
 * mismos deps: se cachea por base de datos.
 */
const porBase = new WeakMap<object, DispositivosSucursal>();

export function obtenerDispositivos(deps: {
  db: { $client: unknown };
  repos: { audit: { insert(row: { userId: string | null; username: string; channel: string; area: string; description: string }): void } };
}): DispositivosSucursal {
  let d = porBase.get(deps.db);
  if (!d) {
    d = new DispositivosSucursal(deps.db.$client as SqliteLike, {
      auditar: (e) => {
        try {
          deps.repos.audit.insert({ ...e, channel: 'lan:dispositivos', area: 'Sucursales' });
        } catch {
          /* la auditoría nunca rompe la operación */
        }
      },
    });
    porBase.set(deps.db, d);
  }
  return d;
}

/**
 * ¿El comercio tiene la edición Multisucursal? Delegado en la fuente única del
 * backend (`tieneMultisucursal`, electron/license/funciones.ts). Sin licencia
 * o ante cualquier error: edición común.
 */
export function planMultisucursal(
  licenseManager: DepsConLicencia['licenseManager'] | null | undefined,
): boolean {
  return licenseManager ? tieneMultisucursal({ licenseManager }) : false;
}
