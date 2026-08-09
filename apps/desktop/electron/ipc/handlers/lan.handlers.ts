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

import { requirePermission } from '@stockflow/core';

const execFileP = promisify(execFile);

import { LanManager } from '../../lan/LanManager';
import type { LanConfig, LanMode } from '../../lan/types';
import { DEFAULT_LAN_PORT } from '../../lan/types';
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';

export interface LanTestConnectionInput {
  ip: string;
  port: number;
  token?: string;
}

export interface LanTestConnectionResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

async function pingServer(ip: string, port: number, timeoutMs = 3000): Promise<LanTestConnectionResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(`http://${ip}:${port}/lan/ping`, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
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
  /** Sólo modo client: PIN del servidor. */
  token?: string;
  /** Sólo modo server: puerto (default 7777). */
  port?: number;
}

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

export function buildLanHandlers(deps: HandlerDeps): HandlerMap {
  const extras = deps.lanExtras ?? {};
  return {
    'lan:getConfig': unguarded(deps, async (): Promise<LanConfig & { configured: boolean }> => {
      const mgr = getManager(deps);
      return { ...mgr.getConfig(), configured: mgr.isConfigured() };
    }),
    'lan:getLocalIp': unguarded(deps, async (): Promise<{ ip: string | null }> => {
      return { ip: LanManager.getLocalIp() };
    }),
    'lan:testConnection': unguarded(
      deps,
      async (payload: LanTestConnectionInput): Promise<LanTestConnectionResult> => {
        if (!payload?.ip || !payload?.port) {
          return { ok: false, error: 'Faltan IP y/o puerto' };
        }
        return pingServer(payload.ip, payload.port);
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
      async (): Promise<{ ip: string; lastSeen: number }[]> => {
        return extras.getConnectedClients?.() ?? [];
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
          : cfg.mode === 'client' ? `Puesto conectado a ${cfg.serverIp ?? '?'}:${cfg.serverPort ?? port}`
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

      if (cfg.mode === 'client' && cfg.serverIp) {
        const ping = await pingServer(cfg.serverIp, cfg.serverPort ?? port);
        checks.push({
          id: 'conexion',
          label: 'Conexión con el servidor',
          ok: ping.ok,
          detail: ping.ok ? `Responde en ${ping.latencyMs} ms`
            : `Sin respuesta (${ping.error ?? '—'}). Revisá que el servidor esté encendido y el firewall abierto.`,
        });
      }

      return { checks, allOk: checks.every((c) => c.ok) };
    }),
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

        let next: LanConfig;
        if (payload.mode === 'server') {
          const token = current.mode === 'server' && current.token ? current.token : LanManager.generatePin();
          next = {
            mode: 'server',
            port: payload.port ?? current.port ?? DEFAULT_LAN_PORT,
            token,
          };
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
        return { requiresRestart: true, config: saved };
      },
    ),
  };
}
