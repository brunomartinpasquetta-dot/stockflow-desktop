/**
 * Instalación de OLLAMA desde StockFlow (Configuración → Flowy con IA).
 *
 * Windows: baja el instalador oficial de ollama.com y lo corre en modo
 * SILENCIOSO, con los mismos parámetros que usa el instalador oficial por
 * línea de comandos (install.ps1): `/VERYSILENT /NORESTART /SUPPRESSMSGBOXES`.
 * Es Inno Setup con `PrivilegesRequired=lowest`: se instala para el usuario de
 * Windows, sin pedir permisos de administrador, en %LOCALAPPDATA%\Programs\Ollama,
 * y arranca solo con la PC. Es una descarga grande (≈1,5 GB: trae soporte para
 * placas de video), por eso se muestra el avance.
 *
 * Antes de instalar se dejan dos archivos, como hace install.ps1 y la
 * documentación de Ollama:
 *  - %LOCALAPPDATA%\Ollama\upgraded → la bandeja de Ollama arranca oculta
 *    (sin ventanas que asusten al cliente);
 *  - %USERPROFILE%\.ollama\server.json con disable_ollama_cloud → Ollama no
 *    consulta los modelos "en la nube" de ollama.com. Las preguntas nunca
 *    salen de la PC de todos modos.
 *
 * Mac: se abre la página oficial de descarga (instalación a mano).
 */
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const ARGUMENTOS_INSTALACION_SILENCIOSA = ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'];

/** Deja listos los archivos que hacen que Ollama arranque oculto y sin funciones de nube. */
export function prepararArchivosOllama(entorno: { localAppData?: string; home?: string } = {}): void {
  const localAppData = entorno.localAppData ?? process.env.LOCALAPPDATA;
  const home = entorno.home ?? homedir();
  try {
    if (localAppData) {
      const dir = join(localAppData, 'Ollama');
      mkdirSync(dir, { recursive: true });
      const marca = join(dir, 'upgraded');
      if (!existsSync(marca)) writeFileSync(marca, '');
    }
  } catch {
    /* si no se pudo, la bandeja de Ollama se ve al arrancar: no es grave */
  }
  try {
    const dir = join(home, '.ollama');
    mkdirSync(dir, { recursive: true });
    const conf = join(dir, 'server.json');
    // Sólo si no existe: nunca se pisa una configuración que alguien haya hecho.
    if (!existsSync(conf)) writeFileSync(conf, `${JSON.stringify({ disable_ollama_cloud: true }, null, 2)}\n`);
  } catch {
    /* sin esto Ollama consulta su catálogo en la nube: no afecta a Flowy */
  }
}

export interface EstadoInstalacion {
  estado: 'inactivo' | 'descargando' | 'instalando' | 'listo' | 'error' | 'no-soportado';
  fraccion: number | null;
  mensaje: string;
}

export const URL_INSTALADOR_WINDOWS = 'https://ollama.com/download/OllamaSetup.exe';
export const URL_DESCARGA_MAC = 'https://ollama.com/download/mac';

export interface InstaladorOpciones {
  plataforma?: NodeJS.Platform;
  /** Abre una página en el navegador (en Electron: shell.openExternal). */
  abrirEnlace: (url: string) => Promise<void> | void;
  /** ¿Ya responde Ollama? (para saber cuándo terminó la instalación). */
  ollamaDisponible: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  carpetaTemporal?: string;
  log?: (msg: string) => void;
}

export class InstaladorOllama {
  private e: EstadoInstalacion = { estado: 'inactivo', fraccion: null, mensaje: '' };
  private enCurso: Promise<void> | null = null;
  private readonly plataforma: NodeJS.Platform;

  constructor(private readonly opts: InstaladorOpciones) {
    this.plataforma = opts.plataforma ?? process.platform;
  }

  estado(): EstadoInstalacion {
    return { ...this.e };
  }

  async iniciar(): Promise<EstadoInstalacion> {
    if (this.enCurso) return this.estado();
    if (await this.opts.ollamaDisponible()) {
      this.e = { estado: 'listo', fraccion: 1, mensaje: 'Ollama ya está instalado y funcionando.' };
      return this.estado();
    }
    if (this.plataforma !== 'win32') {
      await this.opts.abrirEnlace(URL_DESCARGA_MAC);
      this.e = {
        estado: 'no-soportado',
        fraccion: null,
        mensaje: 'Se abrió la página de Ollama: descárguelo, instálelo y ábralo. Después vuelva a esta pantalla.',
      };
      return this.estado();
    }
    this.enCurso = this.instalarWindows().finally(() => {
      this.enCurso = null;
    });
    return this.estado();
  }

  private async instalarWindows(): Promise<void> {
    const carpeta = this.opts.carpetaTemporal ?? tmpdir();
    const destino = join(carpeta, 'OllamaSetup.exe');
    const parcial = `${destino}.descargando`;
    try {
      this.e = { estado: 'descargando', fraccion: 0, mensaje: 'Descargando Ollama…' };
      const res = await (this.opts.fetchImpl ?? fetch)(URL_INSTALADOR_WINDOWS, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`No se pudo descargar Ollama (${res.status}).`);
      const total = Number(res.headers.get('content-length') ?? 0);
      let bajado = 0;
      const archivo = createWriteStream(parcial);
      const lector = res.body.getReader();
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        bajado += value.byteLength;
        if (!archivo.write(value)) await new Promise<void>((r) => archivo.once('drain', () => r()));
        this.e = {
          estado: 'descargando',
          fraccion: total ? bajado / total : null,
          mensaje: `Descargando Ollama… ${Math.round(bajado / 1048576)} MB${total ? ` de ${Math.round(total / 1048576)} MB` : ''}`,
        };
      }
      await new Promise<void>((resolve, reject) => archivo.end((err?: Error | null) => (err ? reject(err) : resolve())));
      if (total && bajado < total) throw new Error('La descarga de Ollama quedó incompleta. Pruebe de nuevo.');
      if (existsSync(destino)) unlinkSync(destino);
      renameSync(parcial, destino);

      // Instalación silenciosa, sin permisos de administrador.
      prepararArchivosOllama();
      this.e = { estado: 'instalando', fraccion: null, mensaje: 'Instalando Ollama… (puede tardar unos minutos)' };
      const hijo = spawn(destino, ARGUMENTOS_INSTALACION_SILENCIOSA, { detached: true, stdio: 'ignore' });
      hijo.unref();

      // Esperar (hasta 20 minutos) a que Ollama responda.
      const limite = Date.now() + 20 * 60_000;
      while (Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 3000));
        if (await this.opts.ollamaDisponible()) {
          this.e = { estado: 'listo', fraccion: 1, mensaje: 'Ollama quedó instalado y funcionando.' };
          return;
        }
      }
      this.e = {
        estado: 'error',
        fraccion: null,
        mensaje: 'Ollama no respondió después de instalarlo. Ábralo desde el menú Inicio y vuelva a esta pantalla.',
      };
    } catch (err) {
      try {
        if (existsSync(parcial)) unlinkSync(parcial);
      } catch {
        /* no importa */
      }
      this.e = { estado: 'error', fraccion: null, mensaje: (err as Error).message };
      this.opts.log?.(`instalar Ollama: ${(err as Error).message}`);
    }
  }
}
