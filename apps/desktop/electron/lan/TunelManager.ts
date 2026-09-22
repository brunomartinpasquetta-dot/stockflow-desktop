/**
 * ACCESO REMOTO — el túnel que publica esta PC en internet.
 *
 * El comercio prende un interruptor en Configuración y su sistema queda
 * accesible desde afuera en `https://<cliente>.<dominio>`: la tablet del dueño
 * entra con el navegador, con su usuario y su clave de siempre.
 *
 * Cómo funciona, en una línea: esta PC abre una conexión SALIENTE hacia el
 * borde (Cloudflare) y la deja viva; las visitas entran por ahí. No se abre
 * ningún puerto en el router del comercio ni se publica su IP.
 *
 * Decisiones que vienen de la experiencia con el túnel de Alpha Gestión
 * (`docs/PLAN_TUNEL_REMOTO.md`, sección 6), donde cada una costó tiempo:
 *
 *  - **La credencial NUNCA viaja en el instalador.** El repositorio de
 *    releases es público: una credencial adentro del `.exe` es una credencial
 *    regalada. Vive en `{userData}/remoto/`, igual que el certificado de ARCA,
 *    y por eso sobrevive a las actualizaciones (el instalador borra y rehace
 *    la carpeta del programa, no la de datos).
 *  - **Una credencial por instalación.** Dar de baja a un cliente no puede
 *    obligar a cambiarles la llave a todos los demás.
 *  - **Un solo temporizador de reintento y nunca con un proceso vivo.** Dos
 *    procesos peleando la misma credencial dan errores falsos y ensucian el
 *    log.
 *  - **Se persiste la INTENCIÓN, no el resultado.** Si el primer intento falla
 *    (sin internet al arrancar), el interruptor queda prendido igual y se
 *    sigue reintentando: al volver la conexión, el acceso vuelve solo.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * De dónde se baja el componente del túnel cuando la instalación no lo tiene.
 * Se descarga UNA vez por PC, a la carpeta de datos: no viaja en el instalador
 * (son ~50 MB que la mayoría de los comercios no usa) ni necesita permisos de
 * administrador para escribirse.
 */
const DESCARGAS: Record<string, string> = {
  'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'win32-ia32': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe',
  'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
};
/** Un ejecutable sano pesa decenas de MB; menos que esto es una página de error. */
const TAMANO_MINIMO = 5_000_000;

/** Estado visible en la pantalla de Configuración. */
export type EstadoTunel = 'apagado' | 'conectando' | 'conectado' | 'error';

export interface TunelInfo {
  estado: EstadoTunel;
  /** Dirección pública, cuando está configurada. */
  direccion: string | null;
  /** Último error, para mostrarlo en pantalla sin ir al log. */
  ultimoError: string | null;
  /** Momento del último cambio de estado. */
  desde: number;
}

export interface TunelOpciones {
  /** Carpeta de datos del usuario (`app.getPath('userData')`). */
  userDataDir: string;
  /**
   * Dónde está el ejecutable del túnel. Es una FUNCIÓN y no una ruta fija
   * porque el componente puede aparecer después de que arrancó la aplicación
   * (se descarga la primera vez que el comercio prende el acceso remoto).
   */
  binario: () => string;
  /** Puerto local del servidor LAN al que se le entregan las visitas. */
  puertoLocal: number;
  /** Para los tests: reemplaza el lanzador de procesos. */
  spawnImpl?: typeof spawn;
  log?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/** Reintento con espera creciente y tope, para no golpear al borde. */
const ESPERAS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

export class TunelManager {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private intentos = 0;
  private quiereCorrer = false;
  private info: TunelInfo = { estado: 'apagado', direccion: null, ultimoError: null, desde: Date.now() };

  constructor(private readonly opts: TunelOpciones) {
    // La dirección asignada se relee de la configuración guardada: tras
    // reiniciar la PC, la pantalla tiene que seguir mostrándola.
    this.info.direccion = this.hostnameGuardado();
  }

  /** Dirección pública de esta instalación, leída de la configuración local. */
  private hostnameGuardado(): string | null {
    try {
      if (!existsSync(this.rutaConfig)) return null;
      const m = /^\s*-\s*hostname:\s*(\S+)\s*$/m.exec(readFileSync(this.rutaConfig, 'utf8'));
      return m?.[1] ? `https://${m[1]}` : null;
    } catch {
      return null;
    }
  }

  private get log() {
    return this.opts.log ?? { info: console.info, warn: console.warn, error: console.error };
  }

  /** Carpeta de la credencial: fuera del directorio de instalación, a propósito. */
  private get carpeta(): string {
    return path.join(this.opts.userDataDir, 'remoto');
  }

  private get rutaCredencial(): string {
    return path.join(this.carpeta, 'credencial.json');
  }

  private get rutaConfig(): string {
    return path.join(this.carpeta, 'config.yml');
  }

  /** ¿Esta instalación tiene credencial cargada? */
  estaAprovisionado(): boolean {
    return existsSync(this.rutaCredencial);
  }

  /** ¿Está el componente del túnel en esta PC? */
  tieneBinario(): boolean {
    try {
      return existsSync(this.opts.binario()) && statSync(this.opts.binario()).size > TAMANO_MINIMO;
    } catch {
      return false;
    }
  }

  /**
   * Se asegura de que el componente esté disponible, bajándolo si falta. Es lo
   * que permite que el instalador no engorde 50 MB para todos los comercios:
   * sólo lo descarga el que enciende el acceso remoto, una única vez.
   *
   * Se baja a un archivo temporal y recién al terminar se renombra: una
   * descarga cortada a la mitad no deja un ejecutable roto que después falle
   * de una forma incomprensible.
   */
  async asegurarBinario(): Promise<void> {
    if (this.tieneBinario()) return;
    const clave = `${process.platform}-${process.arch}`;
    const url = DESCARGAS[clave];
    if (!url) throw new Error(`El acceso remoto no está disponible para este equipo (${clave})`);
    if (!existsSync(this.carpeta)) mkdirSync(this.carpeta, { recursive: true });

    const destino = path.join(this.carpeta, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    const tmp = `${destino}.descargando`;
    this.log.info(`[remoto] descargando el componente (${clave})`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`No se pudo descargar el componente (${res.status})`);
    const datos = Buffer.from(await res.arrayBuffer());
    if (datos.length < TAMANO_MINIMO) throw new Error('La descarga del componente llegó incompleta');

    if (url.endsWith('.tgz')) {
      // macOS lo publica comprimido; se descomprime con la herramienta del sistema.
      const tgz = `${destino}.tgz`;
      writeFileSync(tgz, datos);
      await new Promise<void>((resolve, reject) => {
        const p = spawn('tar', ['xzf', tgz, '-C', this.carpeta]);
        p.on('error', reject);
        p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('No se pudo descomprimir el componente'))));
      });
      try {
        unlinkSync(tgz);
      } catch {
        /* no importa */
      }
    } else {
      writeFileSync(tmp, datos);
      renameSync(tmp, destino);
    }
    try {
      chmodSync(destino, 0o755);
    } catch {
      /* en Windows no hace falta */
    }
    if (!this.tieneBinario()) throw new Error('El componente se descargó pero no quedó utilizable');
    this.log.info('[remoto] componente listo');
  }

  /**
   * Guarda la credencial que entrega el proveedor del sistema (un archivo por
   * cliente) y arma la configuración local. Se llama una sola vez por PC.
   * `hostname` es la dirección pública que le corresponde a ese cliente.
   */
  aprovisionar(credencialJson: string, hostname: string, tunnelId: string): void {
    if (!existsSync(this.carpeta)) mkdirSync(this.carpeta, { recursive: true });
    writeFileSync(this.rutaCredencial, credencialJson, 'utf8');
    // Permisos cerrados: en Alpha, una credencial legible por todos hacía que
    // el cliente de SSH la descartara y el túnel moría sin explicación.
    try {
      chmodSync(this.rutaCredencial, 0o600);
    } catch {
      /* en Windows los permisos van por ACL; no es fatal */
    }
    const yml = [
      `tunnel: ${tunnelId}`,
      `credentials-file: ${this.rutaCredencial}`,
      'ingress:',
      `  - hostname: ${hostname}`,
      `    service: http://127.0.0.1:${this.opts.puertoLocal}`,
      '  - service: http_status:404',
      '',
    ].join('\n');
    writeFileSync(this.rutaConfig, yml, 'utf8');
    this.info = { ...this.info, direccion: `https://${hostname}` };
    // Si ya había un túnel corriendo, está sirviendo la configuración VIEJA:
    // hay que reiniciarlo o la dirección nueva devuelve error 1033 mientras la
    // pantalla dice "conectado" (pasó en la primera prueba de punta a punta).
    if (this.proc) {
      const seguia = this.quiereCorrer;
      this.detener();
      this.quiereCorrer = seguia;
      if (seguia) this.lanzar();
    }
  }

  estado(): TunelInfo {
    return { ...this.info };
  }

  /** Prende el acceso remoto. Idempotente. */
  iniciar(): TunelInfo {
    this.quiereCorrer = true;
    if (!this.estaAprovisionado()) {
      return this.marcar('error', 'Esta instalación todavía no tiene la credencial del acceso remoto');
    }
    if (!existsSync(this.opts.binario())) {
      return this.marcar('error', 'Falta el componente del acceso remoto en esta instalación');
    }
    if (this.proc) return this.estado();
    this.lanzar();
    return this.estado();
  }

  /** Apaga el acceso remoto AHORA, sin reiniciar la aplicación. */
  detener(): TunelInfo {
    this.quiereCorrer = false;
    this.cancelarReintento();
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      try {
        p.kill();
      } catch {
        /* ya estaba muerto */
      }
    }
    return this.marcar('apagado', null);
  }

  private marcar(estado: EstadoTunel, error: string | null): TunelInfo {
    this.info = { ...this.info, estado, ultimoError: error, desde: Date.now() };
    return this.estado();
  }

  private cancelarReintento(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private programarReintento(): void {
    // Un solo temporizador, y nunca con un proceso vivo: dos cloudflared
    // peleando la misma credencial es el error clásico.
    this.cancelarReintento();
    if (!this.quiereCorrer || this.proc) return;
    const espera = ESPERAS_MS[Math.min(this.intentos, ESPERAS_MS.length - 1)]!;
    this.intentos += 1;
    this.log.info(`[remoto] reintento en ${Math.round(espera / 1000)}s`);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.quiereCorrer && !this.proc) this.lanzar();
    }, espera);
  }

  private lanzar(): void {
    const lanzador = this.opts.spawnImpl ?? spawn;
    this.marcar('conectando', null);
    const proc = lanzador(
      this.opts.binario(),
      ['tunnel', '--config', this.rutaConfig, '--no-autoupdate', 'run'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    this.proc = proc;

    const mirar = (chunk: unknown): void => {
      const texto = String(chunk);
      // cloudflared escribe todo por la salida de error; el éxito se reconoce
      // por el registro de la conexión con el borde.
      if (texto.includes('Registered tunnel connection')) {
        this.intentos = 0;
        this.marcar('conectado', null);
      } else if (/ERR |error=/i.test(texto) && this.info.estado !== 'conectado') {
        const linea = texto.split('\n').find((l) => /ERR |error=/i.test(l)) ?? texto;
        this.marcar('conectando', linea.slice(0, 200).trim());
      }
    };
    proc.stdout?.on('data', mirar);
    proc.stderr?.on('data', mirar);

    proc.on('error', (e) => {
      this.log.error(`[remoto] no se pudo ejecutar el componente: ${e.message}`);
      this.proc = null;
      this.marcar('error', e.message);
      this.programarReintento();
    });

    proc.on('exit', (code) => {
      this.proc = null;
      if (!this.quiereCorrer) {
        this.marcar('apagado', null);
        return;
      }
      this.log.warn(`[remoto] el túnel se cortó (código ${code ?? '—'}); se reintenta`);
      this.marcar('conectando', this.info.ultimoError);
      this.programarReintento();
    });
  }
}
