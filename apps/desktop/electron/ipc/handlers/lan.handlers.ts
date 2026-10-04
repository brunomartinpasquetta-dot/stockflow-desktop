/**
 * Handlers IPC del modo multi-caja LAN.
 *
 * - `lan:getConfig`  : devuelve la configuración persistida.
 * - `lan:setMode`    : cambia el modo (single/server/client); genera PIN si server.
 *                       Requiere admin. Devuelve `requiresRestart: true`.
 * - `lan:getLocalIp` : primera IPv4 no-loopback de la máquina.
 *
 * El switch de modo NO arranca/detiene el server en caliente — exige reinicio
 * para tomar la nueva config. Es la forma más segura.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import { ValidationError, requirePermission } from '@stockflow/core';

const execFileP = promisify(execFile);

import { altaTunelLocal, leerLlaveLocal } from '../../lan/altaCloudflare';
import {
  emparejarConCentral,
  mensajeDeDireccion,
  MENSAJE_SIN_EDICION,
  revisarCentral,
  verificarCentralRecordando,
} from '../../lan/conexion-central';
import { obtenerDispositivos, planMultisucursal } from '../../lan/dispositivos';
import { LanManager } from '../../lan/LanManager';
import type { LanConfig, LanMode } from '../../lan/types';
import { DEFAULT_LAN_PORT } from '../../lan/types';
import { normalizarUrlServidor, type IdentidadTerminal } from '../../preload-bridge';
import { cajaPorPcActiva, cajaPorPcForzada, compartirCajaDelServidor, hayCajasAbiertasDeOtrasPc } from '../caja-por-pc';
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import type { CodigoEmparejamientoDTO, DispositivoSucursalDTO } from '../types';

export interface LanTestConnectionInput {
  ip?: string;
  port?: number;
  /** Dirección web del servidor (multisucursal); si está, manda sobre ip/port. */
  url?: string;
  token?: string;
}

export interface LanTestConnectionResult {
  ok: boolean;
  /**
   * Lo que informó el servidor en /lan/ping: si acepta PC de sucursal
   * (edición Multisucursal). Ausente = servidor viejo o sin respuesta.
   */
  sucursales?: boolean;
  latencyMs?: number;
  error?: string;
  /** Conecta, pero algo impide emparejar (p. ej. la central sin Multisucursal). */
  aviso?: string;
}

/** Base del servidor de una terminal: la dirección web si la tiene, si no `http://ip:puerto`. */
export function baseDeConfigCliente(cfg: Pick<LanConfig, 'serverUrl' | 'serverIp' | 'serverPort'>): string | null {
  if (cfg.serverUrl) {
    const n = normalizarUrlServidor(cfg.serverUrl);
    return n.ok ? n.url : null;
  }
  if (!cfg.serverIp) return null;
  return `http://${cfg.serverIp}:${cfg.serverPort ?? DEFAULT_LAN_PORT}`;
}

async function pingServer(base: string, timeoutMs = 3000): Promise<LanTestConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/lan/ping`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const latencyMs = Date.now() - start;
    const body = (await res.json().catch(() => null)) as { sucursales?: unknown } | null;
    return typeof body?.sucursales === 'boolean'
      ? { ok: true, latencyMs, sucursales: body.sucursales }
      : { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export interface TerminalConectada {
  ip: string;
  /** Último contacto (ms). Si pasa de un minuto, el puesto se da por caído. */
  lastSeen: number;
  usuario: string | null;
  ultimaAccion: string | null;
  via: 'app' | 'navegador';
  operaciones: number;
}

export interface LanCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Acción que puede arreglarlo desde la app. */
  fix?: 'openFirewall';
}

export interface LanDiagnosis {
  checks: LanCheck[];
  allOk: boolean;
}

export interface LanSetModeInput {
  mode: LanMode;
  /** Sólo modo client: */
  serverIp?: string;
  serverPort?: number;
  /** Sólo modo client, multisucursal: dirección web del servidor. */
  serverUrl?: string;
  /** Sólo modo client por dirección web: código de emparejamiento a canjear. */
  codigoEmparejamiento?: string;
  /** Con el código: nombre con que la casa central va a ver esta PC (sin él, el de Windows). */
  nombrePc?: string;
  /**
   * Modo client: PIN del servidor. Modo server: PIN nuevo (6 dígitos) si se
   * quiere cambiar el vigente; sin él se conserva el actual.
   */
  token?: string;
  /** Sólo modo server: puerto (default 7777). */
  port?: number;
  /** Sólo modo server: descartar el PIN vigente y generar otro al azar. */
  regeneratePin?: boolean;
}

const PIN_VALIDO = /^\d{6}$/;

/**
 * Regla de firewall de Windows para el puerto del servidor.
 *
 * Sin esto los otros puestos NO se conectan: Windows bloquea el puerto entrante
 * por defecto y el aviso de "Permitir acceso" a veces no aparece (o se rechaza
 * sin querer). Es la causa número uno de que una instalación en red no ande.
 */
async function firewallRuleState(port: number): Promise<'present' | 'absent' | 'unsupported'> {
  if (process.platform !== 'win32') return 'unsupported';
  try {
    const { stdout } = await execFileP('netsh', [
      'advfirewall', 'firewall', 'show', 'rule', `name=StockFlow ${port}`,
    ]);
    return /LocalPort/i.test(stdout) ? 'present' : 'absent';
  } catch {
    return 'absent';
  }
}

async function addFirewallRule(port: number): Promise<{ ok: boolean; needsAdmin?: boolean; error?: string }> {
  if (process.platform !== 'win32') return { ok: true };
  try {
    await execFileP('netsh', [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=StockFlow ${port}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`,
    ]);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // netsh devuelve "Acceso denegado" / "requires elevation" sin permisos.
    const needsAdmin = /denegado|denied|elevat|administrador|administrator/i.test(msg);
    return { ok: false, needsAdmin, error: msg };
  }
}

function getManager(deps: HandlerDeps): LanManager {
  return new LanManager(deps.userDataDir);
}

/**
 * Canjea el código de emparejamiento contra la casa central y devuelve el
 * token de PC de sucursal. Corre en el proceso main de la TERMINAL, que no
 * necesita licencia propia: la que cuenta es la de la central. Cada falla
 * llega como un mensaje que dice qué pasó y qué hacer (ver conexion-central.ts).
 */
async function canjearCodigo(base: string, codigo: string, deps: HandlerDeps, nombrePc?: string): Promise<string> {
  // El nombre lo ve la casa central en la lista de PC de sucursal y en sus
  // cajas: "Caja 1 San Carlos" se reconoce; "DESKTOP-7GH2K9P", no.
  // eslint-disable-next-line no-control-regex
  const elegido = (nombrePc ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64);
  const r = await emparejarConCentral(base, codigo, { nombre: elegido || os.hostname() || 'PC de sucursal', machineId: deps.machineId });
  if (!r.ok) throw new ValidationError('codigoEmparejamiento', r.mensaje);
  return r.token;
}

/** Sesión obligatoria y permiso de administración: para lo que toca PC de sucursal. */
function exigirAdministrador(deps: HandlerDeps): { id: string; nombre: string } {
  const session = deps.sessionStore.getSession();
  if (!session) throw new ValidationError('sesion', 'Inicie sesión para administrar las PC de sucursal');
  requirePermission(session.user, 'manage_hardware');
  return { id: session.user.id, nombre: session.user.fullName || session.user.username };
}

export function buildLanHandlers(deps: HandlerDeps): HandlerMap {
  const extras = deps.lanExtras ?? {};
  return {
    'lan:getConfig': unguarded(
      deps,
      async (): Promise<LanConfig & { configured: boolean; emparejada?: boolean; cajaPorPc?: boolean; cajaPorPcForzada?: boolean }> => {
        const mgr = getManager(deps);
        const cfg = mgr.getConfig();
        return {
          ...cfg,
          configured: mgr.isConfigured(),
          // Sólo se informa en una terminal por dirección web: el resto de los
          // comercios recibe exactamente la misma config que antes.
          ...(cfg.mode === 'client' && cfg.serverUrl ? { emparejada: mgr.tieneTokenDispositivo() } : {}),
          // Opción "Una caja por PC": sólo la PC servidor la tiene (es de la
          // red del local). La pantalla la muestra sólo en modo servidor.
          ...(cfg.mode === 'server' ? { cajaPorPc: cajaPorPcActiva(deps), cajaPorPcForzada: cajaPorPcForzada(deps) } : {}),
        };
      },
    ),
    /**
     * Prende o apaga "Una caja por PC" (ver ipc/caja-por-pc.ts). Sólo en la PC
     * servidor y con permiso de administración.
     *  - Al PRENDERLA, la caja que está abierta con el id del servidor (la del
     *    local) pasa a caja compartida heredada (terminal_id NULL, igual que la
     *    migración 0042): todos los puestos siguen vendiendo en ella hasta que
     *    alguien la cierre, y desde ahí cada PC abre la suya. Nadie queda sin
     *    caja a mitad de turno.
     *  - Para APAGARLA no puede haber cajas abiertas de otras PC: quedarían sin
     *    pantalla que las muestre. Se cierran antes desde el Historial de cajas.
     *  - Con la edición Multisucursal no se puede apagar.
     */
    'lan:setCajaPorPc': unguarded(deps, async (payload: { activa?: boolean }): Promise<{ cajaPorPc: boolean }> => {
      const autor = exigirAdministrador(deps);
      const mgr = getManager(deps);
      if (mgr.getConfig().mode !== 'server') {
        throw new ValidationError('modo', 'La caja por PC se configura en la PC servidor');
      }
      const activa = payload?.activa === true;
      if (!activa && cajaPorPcForzada(deps)) {
        throw new ValidationError('cajaPorPc', 'Con la licencia Multisucursal cada PC tiene siempre su caja');
      }
      if (activa) {
        compartirCajaDelServidor(deps);
      } else if (hayCajasAbiertasDeOtrasPc(deps)) {
        throw new ValidationError(
          'cajaPorPc',
          'Hay cajas abiertas en otras PC. Ciérrelas desde el Historial de cajas antes de volver a la caja única.',
        );
      }
      mgr.setCajaPorPc(activa);
      try {
        deps.repos.audit.insert({
          userId: autor.id,
          username: autor.nombre,
          channel: 'lan:setCajaPorPc',
          area: 'Configuración',
          description: activa ? 'Caja por PC activada: cada PC abre y arquea su caja' : 'Caja por PC desactivada: el local vuelve a una caja única',
        });
      } catch {
        /* la auditoría nunca frena la operación */
      }
      return { cajaPorPc: cajaPorPcActiva(deps) };
    }),
    /**
     * Identidad de ESTA PC para el puente (preload): viaja en cada pedido al
     * servidor. Incluye el token de PC de sucursal, por eso NO está en la API
     * que ve la interfaz y el grupo `lan` no cruza la red (lanServerAccepts).
     *
     * PC de sucursal (dirección web + token): ANTES de entregar el token se
     * comprueba que en esa dirección esté SU casa central (conexion-central.ts
     * → `verificarCentral`). Si no, el token no sale de acá y el puente no
     * manda nada, tampoco una contraseña (`central: 'rechazada'`). Se recuerda
     * unos minutos; `verificarCentral: true` (al iniciar sesión) pregunta de nuevo.
     */
    'lan:identidadTerminal': unguarded(
      deps,
      async (payload?: { verificarCentral?: boolean }): Promise<IdentidadTerminal> => {
        const mgr = getManager(deps);
        const cfg = mgr.getConfig();
        const token = cfg.mode === 'client' ? mgr.leerTokenDispositivo() : null;
        const identidad: IdentidadTerminal = {
          terminalId: deps.machineId,
          terminalNombre: os.hostname() || 'PC',
          dispositivoToken: token,
        };
        if (!token || !cfg.serverUrl) return identidad;
        const v = await verificarCentralRecordando(cfg.serverUrl, token, { forzar: payload?.verificarCentral === true });
        if (v.ok) return { ...identidad, central: 'verificada' };
        return { ...identidad, dispositivoToken: null, central: 'rechazada', motivoCentral: v.mensaje };
      },
    ),
    /* --------------------- PC de sucursal (multisucursal) --------------------- */
    'lan:emparejarGenerarCodigo': unguarded(deps, async (): Promise<CodigoEmparejamientoDTO> => {
      const autor = exigirAdministrador(deps);
      // Apagado sin la edición Multisucursal: la pantalla ni lo muestra, y
      // el servidor tampoco lo hace aunque alguien llame al canal.
      if (!planMultisucursal(deps.licenseManager)) {
        throw new ValidationError('plan', 'Las PC de sucursal requieren la licencia Multisucursal');
      }
      if (getManager(deps).getConfig().mode === 'client') {
        throw new ValidationError('modo', 'Los códigos se generan en la PC servidor, no en una terminal');
      }
      return obtenerDispositivos(deps).generarCodigo(autor);
    }),
    'lan:dispositivosListar': unguarded(deps, async (): Promise<DispositivoSucursalDTO[]> => {
      exigirAdministrador(deps);
      if (getManager(deps).getConfig().mode === 'client') return [];
      return obtenerDispositivos(deps).listar();
    }),
    'lan:dispositivoRevocar': unguarded(deps, async (payload: { id?: string }): Promise<{ ok: true }> => {
      const autor = exigirAdministrador(deps);
      if (typeof payload?.id !== 'string' || !payload.id) throw new ValidationError('id', 'Falta la PC a revocar');
      if (!obtenerDispositivos(deps).revocar(payload.id, autor)) {
        throw new ValidationError('id', 'Esa PC no existe o ya estaba revocada');
      }
      return { ok: true };
    }),
    'lan:getLocalIp': unguarded(deps, async (): Promise<{ ip: string | null }> => {
      return { ip: LanManager.getLocalIp() };
    }),
    'lan:testConnection': unguarded(
      deps,
      async (payload: LanTestConnectionInput): Promise<LanTestConnectionResult> => {
        if (payload?.url) {
          // Misma revisión que al emparejar: el error dice qué pasa (dirección
          // mal escrita, sin internet, central apagada o sin Acceso remoto).
          const r = await revisarCentral(payload.url, { timeoutMs: 8000 });
          if (!r.ok) return { ok: false, error: r.mensaje };
          return {
            ok: true,
            latencyMs: r.latencyMs,
            ...(r.sucursales !== null ? { sucursales: r.sucursales } : {}),
            ...(r.sucursales === false ? { aviso: MENSAJE_SIN_EDICION } : {}),
          };
        }
        if (!payload?.ip || !payload?.port) {
          return { ok: false, error: 'Faltan IP y/o puerto' };
        }
        return pingServer(`http://${payload.ip}:${payload.port}`);
      },
    ),
    'lan:scanNetwork': unguarded(
      deps,
      async (): Promise<{ supported: boolean; results: { ip: string; port: number; name?: string }[] }> => {
        // mDNS opcional vía bonjour-service (carga dinámica).
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const mod = require('bonjour-service') as {
            Bonjour?: new () => {
              find: (opts: object, cb: (svc: { addresses?: string[]; port?: number; name?: string }) => void) => { stop: () => void };
              destroy?: () => void;
            };
          };
          if (!mod.Bonjour) return { supported: false, results: [] };
          const instance = new mod.Bonjour();
          const results: { ip: string; port: number; name?: string }[] = [];
          await new Promise<void>((resolve) => {
            const browser = instance.find({ type: 'http' }, (svc) => {
              const ip = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
              if (ip && svc.port) results.push({ ip, port: svc.port, name: svc.name });
            });
            setTimeout(() => {
              browser.stop();
              instance.destroy?.();
              resolve();
            }, 2500);
          });
          return { supported: true, results };
        } catch {
          return { supported: false, results: [] };
        }
      },
    ),
    'lan:getConnectedClients': unguarded(
      deps,
      async (): Promise<TerminalConectada[]> => {
        return (extras.getConnectedClients?.() ?? []) as TerminalConectada[];
      },
    ),
    'lan:applyAndRestart': unguarded(
      deps,
      async (): Promise<{ ok: true }> => {
        // Permitido sin sesión: el wizard de bienvenida lo usa antes del primer
        // login. La operación sólo reinicia la app, no afecta datos.
        setTimeout(() => extras.applyAndRestart?.(), 100);
        return { ok: true };
      },
    ),
    /** Abre el puerto del servidor en el firewall de Windows. */
    'lan:openFirewall': unguarded(
      deps,
      async (): Promise<{ ok: boolean; needsAdmin?: boolean; command?: string; error?: string }> => {
        const cfg = getManager(deps).getConfig();
        const port = cfg.port ?? DEFAULT_LAN_PORT;
        const res = await addFirewallRule(port);
        return {
          ...res,
          command: `netsh advfirewall firewall add rule name="StockFlow ${port}" dir=in action=allow protocol=TCP localport=${port}`,
        };
      },
    ),
    /**
     * Chequeo de red para una instalación multi-puesto: dice qué está bien y
     * qué falta, en criollo, para no tener que adivinar en el local del cliente.
     */
    'lan:diagnose': unguarded(deps, async (): Promise<LanDiagnosis> => {
      const cfg = getManager(deps).getConfig();
      const port = cfg.port ?? DEFAULT_LAN_PORT;
      const checks: LanCheck[] = [];

      checks.push({
        id: 'modo',
        label: 'Modo de esta PC',
        ok: true,
        detail: cfg.mode === 'server' ? 'Servidor (guarda los datos)'
          : cfg.mode === 'client'
            ? `Puesto conectado a ${cfg.serverUrl ?? `${cfg.serverIp ?? '?'}:${cfg.serverPort ?? port}`}`
          : 'PC única (sin red)',
      });

      const ips = Object.values(os.networkInterfaces())
        .flat()
        .filter((n): n is os.NetworkInterfaceInfo => !!n && n.family === 'IPv4' && !n.internal)
        .map((n) => n.address);
      checks.push({
        id: 'ip',
        label: 'Dirección de esta PC en la red',
        ok: ips.length > 0,
        detail: ips.length ? ips.join(', ') : 'Sin red: revisá el cable o el WiFi',
      });

      if (cfg.mode === 'server') {
        const fw = await firewallRuleState(port);
        checks.push({
          id: 'firewall',
          label: `Puerto ${port} habilitado en el firewall`,
          ok: fw !== 'absent',
          detail: fw === 'present' ? 'Habilitado'
            : fw === 'unsupported' ? 'No aplica en este sistema'
            : 'FALTA: los otros puestos no van a poder conectarse',
          fix: fw === 'absent' ? 'openFirewall' : undefined,
        });
        checks.push({
          id: 'pin',
          label: 'PIN para los otros puestos',
          ok: !!cfg.token,
          detail: cfg.token ?? 'Sin PIN: volvé a guardar el modo servidor',
        });
      }

      const base = cfg.mode === 'client' ? baseDeConfigCliente(cfg) : null;
      if (cfg.mode === 'client' && base) {
        // Por internet (PC de sucursal) la falla se explica igual que al
        // conectarla: sin internet, central apagada o sin Acceso remoto, etc.
        // En la red del local, el chequeo de siempre.
        let ping: LanTestConnectionResult;
        if (cfg.serverUrl) {
          const rev = await revisarCentral(base, { timeoutMs: 8000 });
          ping = rev.ok
            ? { ok: true, latencyMs: rev.latencyMs, ...(rev.sucursales !== null ? { sucursales: rev.sucursales } : {}) }
            : { ok: false, error: rev.mensaje };
          checks.push({
            id: 'conexion',
            label: 'Conexión con la casa central',
            ok: ping.ok,
            detail: ping.ok ? `Responde en ${ping.latencyMs} ms` : (ping.error ?? 'Sin respuesta'),
          });
        } else {
          ping = await pingServer(base, 3000);
          checks.push({
            id: 'conexion',
            label: 'Conexión con el servidor',
            ok: ping.ok,
            detail: ping.ok ? `Responde en ${ping.latencyMs} ms`
              : `Sin respuesta (${ping.error ?? '—'}). Revise que el servidor esté encendido y el firewall abierto.`,
          });
        }
        // Sólo en terminales por dirección web (multisucursal).
        if (cfg.serverUrl) {
          const emparejada = getManager(deps).tieneTokenDispositivo();
          // El token se guarda en ESTA PC, pero quien decide es el servidor:
          // si el comercio bajó de edición, el token ya no habilita nada.
          const servidorSinSucursales = ping.ok && ping.sucursales === false;
          checks.push({
            id: 'emparejada',
            label: 'PC de sucursal emparejada',
            ok: emparejada && !servidorSinSucursales,
            detail: !emparejada
              ? 'No: por internet trabaja sin facturación ni Mercado Pago. Cargue un código de emparejamiento.'
              : servidorSinSucursales
                ? 'Emparejada, pero el servidor ya no tiene la licencia Multisucursal: por internet trabaja sin facturación ni Mercado Pago.'
                : 'Sí: factura y cobra con Mercado Pago como una caja del local',
          });
          // ¿En esa dirección está SU casa central? (la misma comprobación que
          // se hace antes de iniciar sesión).
          const token = emparejada && ping.ok ? getManager(deps).leerTokenDispositivo() : null;
          if (token) {
            const v = await verificarCentralRecordando(cfg.serverUrl, token, { forzar: true });
            checks.push({
              id: 'central',
              label: 'Identidad de la casa central',
              ok: v.ok,
              detail: v.ok ? 'Comprobada: es la casa central con la que se conectó esta PC' : v.mensaje,
            });
          }
        }
      }

      return { checks, allOk: checks.every((c) => c.ok) };
    }),
    /* ----------------------- Acceso remoto (túnel) ---------------------- */

    /**
     * Estado del acceso remoto para la pantalla de Configuración. Va sin
     * sesión (como el resto del grupo `lan`, que es local) pero NO viaja por
     * red: `lan` no está en los grupos ruteados.
     */
    'lan:remotoEstado': unguarded(
      deps,
      async (): Promise<{
        disponible: boolean;
        aprovisionado: boolean;
        estado: string;
        direccion: string | null;
        ultimoError: string | null;
      }> => {
        const tunel = deps.lanExtras?.tunel;
        if (!tunel) {
          return { disponible: false, aprovisionado: false, estado: 'apagado', direccion: null, ultimoError: null };
        }
        const e = tunel.estado();
        return {
          disponible: true,
          aprovisionado: tunel.estaAprovisionado(),
          estado: e.estado,
          direccion: e.direccion,
          ultimoError: e.ultimoError,
        };
      },
    ),

    /**
     * Nadie publica su sistema en internet con una clave que se adivina en el
     * primer intento. Con el acceso remoto encendido, un `admin/admin` es la
     * puerta abierta a la caja, los clientes y la facturación del comercio.
     */
    'lan:remotoClavesDebiles': unguarded(deps, async (): Promise<{ usuarios: string[] }> => {
      // La instalación maestra (la del dueño del sistema) no arrastra esta
      // fricción: es la máquina de desarrollo, no un comercio publicado.
      if (deps.licenseManager.esInstalacionMaestra()) return { usuarios: [] };
      const usuarios = await deps.repos.users.usuariosConClaveDebil();
      return { usuarios };
    }),

    /**
     * UN SOLO CLIC: el comercio pide su acceso remoto y queda funcionando.
     * El servidor le crea su dirección y su credencial (con su licencia como
     * identificación), acá se baja el componente si falta, se guarda todo y se
     * enciende el túnel. No hay nada que copiar a mano.
     */
    'lan:remotoConfigurarAutomatico': unguarded(
      deps,
      async (): Promise<{ ok: true; direccion: string; estado: string }> => {
        const session = deps.sessionStore.getSession();
        if (session) requirePermission(session.user, 'manage_hardware');
        const tunel = deps.lanExtras?.tunel;
        if (!tunel) throw new ValidationError('remoto', 'El acceso remoto sólo se activa en la PC que tiene el sistema');
        // 0) Antes que nada: que no haya usuarios con la clave puesta por
        // defecto. Publicar el sistema con `admin/admin` es regalarlo.
        const debiles = deps.licenseManager.esInstalacionMaestra()
          ? []
          : await deps.repos.users.usuariosConClaveDebil();
        if (debiles.length > 0) {
          throw new ValidationError(
            'claves',
            `Antes de activar el acceso remoto hay que cambiar la contraseña de: ${debiles.join(', ')}. ` +
              'Son claves que se adivinan en el primer intento y el sistema va a quedar accesible desde internet. ' +
              'Se cambian en Configuración → Usuarios.',
          );
        }
        // 1) El componente (se descarga una sola vez por PC).
        await tunel.asegurarBinario();
        // 2) El servidor da de alta este comercio y devuelve su dirección.
        //    Los errores del servidor (sin licencia, servicio caído) se
        //    muestran TAL CUAL al comerciante: como error interno no le dicen
        //    nada y no sabe si es él o el sistema.
        let alta: { hostname: string; tunnelId: string; credencial: string };
        // La máquina del DUEÑO no tiene un comercio en el servidor, así que no
        // puede pedirle el alta a nadie: si tiene su propia llave de Cloudflare
        // guardada, crea el túnel ella misma. Un comercio nunca entra por acá.
        const llavePropia = deps.licenseManager.esInstalacionMaestra()
          ? leerLlaveLocal(deps.userDataDir)
          : null;
        try {
          alta = llavePropia ? await altaTunelLocal(llavePropia) : await deps.licenseManager.pedirAltaRemota();
        } catch (e) {
          throw new ValidationError('remoto', e instanceof Error ? e.message : 'No se pudo configurar el acceso remoto');
        }
        // 3) Queda guardado en esta PC y se enciende.
        tunel.aprovisionar(alta.credencial, alta.hostname, alta.tunnelId);
        const mgr = getManager(deps);
        mgr.setConfig({ ...mgr.getConfig(), remotoActivado: true, remotoHostname: alta.hostname });
        const e = tunel.iniciar();
        return { ok: true, direccion: `https://${alta.hostname}`, estado: e.estado };
      },
    ),

    /** Prende o apaga el acceso remoto, sin reiniciar la aplicación. */
    'lan:remotoActivar': unguarded(
      deps,
      async (payload: { activo: boolean }): Promise<{ estado: string; direccion: string | null; ultimoError: string | null }> => {
        const session = deps.sessionStore.getSession();
        if (session) requirePermission(session.user, 'manage_hardware');
        const tunel = deps.lanExtras?.tunel;
        if (!tunel) throw new ValidationError('activo', 'Esta instalación no tiene acceso remoto disponible');
        if (payload?.activo && !deps.licenseManager.esInstalacionMaestra()) {
          const debiles = await deps.repos.users.usuariosConClaveDebil();
          if (debiles.length > 0) {
            throw new ValidationError(
              'claves',
              `Antes de encender el acceso remoto hay que cambiar la contraseña de: ${debiles.join(', ')}.`,
            );
          }
        }
        const mgr = getManager(deps);
        const cfg = mgr.getConfig();
        // Se guarda la INTENCIÓN: si ahora falla por falta de internet, al
        // próximo arranque se vuelve a intentar igual.
        mgr.setConfig({ ...cfg, remotoActivado: Boolean(payload?.activo) });
        const e = payload?.activo ? tunel.iniciar() : tunel.detener();
        return { estado: e.estado, direccion: e.direccion, ultimoError: e.ultimoError };
      },
    ),

    /**
     * Carga la credencial que identifica a ESTA instalación (un archivo por
     * cliente, que entrega el proveedor del sistema). Queda en la carpeta de
     * datos, fuera del directorio de instalación: sobrevive a las
     * actualizaciones, igual que el certificado de ARCA.
     */
    'lan:remotoAprovisionar': unguarded(
      deps,
      async (payload: { credencial: string; hostname: string; tunnelId: string }): Promise<{ ok: true; direccion: string }> => {
        const session = deps.sessionStore.getSession();
        if (session) requirePermission(session.user, 'manage_hardware');
        const tunel = deps.lanExtras?.tunel;
        if (!tunel) throw new ValidationError('credencial', 'Esta instalación no tiene acceso remoto disponible');
        const hostname = (payload?.hostname ?? '').trim().toLowerCase();
        const tunnelId = (payload?.tunnelId ?? '').trim();
        if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) {
          throw new ValidationError('hostname', 'La dirección del acceso remoto no es válida');
        }
        if (!/^[0-9a-f-]{36}$/.test(tunnelId)) {
          throw new ValidationError('tunnelId', 'El identificador del túnel no es válido');
        }
        try {
          JSON.parse(payload.credencial);
        } catch {
          throw new ValidationError('credencial', 'El archivo de credencial no es válido');
        }
        tunel.aprovisionar(payload.credencial, hostname, tunnelId);
        const mgr = getManager(deps);
        mgr.setConfig({ ...mgr.getConfig(), remotoHostname: hostname });
        return { ok: true, direccion: `https://${hostname}` };
      },
    ),

    'lan:setMode': unguarded(
      deps,
      async (payload: LanSetModeInput): Promise<{ requiresRestart: true; config: LanConfig }> => {
        // Si hay sesión activa exigimos el permiso; si no hay sesión (wizard
        // primera ejecución), permitimos la operación porque sólo escribe el
        // archivo de config y requiere restart manual.
        const session = deps.sessionStore.getSession();
        if (session) requirePermission(session.user, 'manage_hardware');
        const mgr = getManager(deps);
        const current = mgr.getConfig();
        // La PC SERVIDOR (la que tiene la base y atiende a las cajas del
        // local) no cambia de red sin un administrador: desde la Activación
        // (licencia vencida o revocada) cualquiera podía convertirla en PC de
        // sucursal de otro comercio y dejar sin servidor a las otras cajas. El
        // wizard de primera ejecución nunca llega acá con una PC servidor, y
        // en una terminal (que no tiene sesión local) esto no aplica.
        if (!session && current.mode === 'server') {
          throw new ValidationError(
            'sesion',
            'Esta PC es la caja principal de este local. Para cambiar cómo trabaja en red, un administrador tiene que ingresar y hacerlo en Configuración → Red local.',
          );
        }

        let next: LanConfig;
        if (payload.mode === 'server') {
          const vigente = current.mode === 'server' && current.token ? current.token : null;
          if (payload.token !== undefined && payload.token !== '' && !PIN_VALIDO.test(payload.token)) {
            throw new ValidationError('token', 'El PIN debe tener exactamente 6 dígitos');
          }
          const pedido = payload.token && PIN_VALIDO.test(payload.token) ? payload.token : null;
          const token = payload.regeneratePin
            ? LanManager.generatePin()
            : (pedido ?? vigente ?? LanManager.generatePin());
          // PIN nuevo → secreto de firma nuevo: las sesiones que las terminales
          // tenían abiertas dejan de valer y tienen que volver a ingresar con
          // el PIN nuevo. Si el PIN no cambió, nadie se entera.
          if (token !== vigente) mgr.rotateJwtSecret();
          next = {
            mode: 'server',
            port: payload.port ?? current.port ?? DEFAULT_LAN_PORT,
            token,
          };
        } else if (payload.mode === 'client' && payload.serverUrl) {
          // TERMINAL POR DIRECCIÓN WEB (multisucursal). El PIN es opcional:
          // por el túnel no se pide; con `http://IP:puerto` en la red, sí.
          const n = normalizarUrlServidor(payload.serverUrl);
          if (!n.ok) throw new ValidationError('serverUrl', mensajeDeDireccion(n.error));
          if (payload.token && !PIN_VALIDO.test(payload.token)) {
            throw new ValidationError('token', 'El PIN debe tener exactamente 6 dígitos');
          }
          // El código se canjea ANTES de guardar: si falla, la PC queda como estaba.
          const codigo = (payload.codigoEmparejamiento ?? '').trim();
          const tokenDispositivo = codigo ? await canjearCodigo(n.url, codigo, deps, payload.nombrePc) : null;
          const u = new URL(n.url);
          next = {
            mode: 'client',
            serverUrl: n.url,
            serverIp: u.hostname,
            serverPort: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
            token: payload.token || undefined,
          };
          // Cambió de servidor sin código nuevo: el token viejo es de otro servidor.
          const cambioDeServidor = current.serverUrl !== n.url;
          const saved = mgr.setConfig(next);
          if (tokenDispositivo) mgr.guardarTokenDispositivo(tokenDispositivo);
          else if (cambioDeServidor) mgr.guardarTokenDispositivo(null);
          return { requiresRestart: true, config: saved };
        } else if (payload.mode === 'client') {
          if (!payload.serverIp || !payload.token) {
            throw new Error('Para modo cliente se requieren serverIp y token (PIN)');
          }
          next = {
            mode: 'client',
            serverIp: payload.serverIp,
            serverPort: payload.serverPort ?? DEFAULT_LAN_PORT,
            token: payload.token,
          };
        } else {
          next = { mode: 'single' };
        }
        const saved = mgr.setConfig(next);
        // Volver a la red local por IP: el token de PC de sucursal no aplica.
        if (next.mode === 'client' && current.serverUrl) mgr.guardarTokenDispositivo(null);
        return { requiresRestart: true, config: saved };
      },
    ),
  };
}
