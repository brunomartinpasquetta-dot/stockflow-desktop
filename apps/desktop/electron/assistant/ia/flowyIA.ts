/**
 * FLOWY CON IA LOCAL (Ollama) — gratis, sin clave y sin internet.
 *
 * Dos niveles, que se eligen en Configuración:
 *  - "entender": un modelo chico de embeddings busca el tema por SIGNIFICADO
 *    y Flowy responde con la ficha curada de ese tema. Liviano: anda en
 *    cualquier PC.
 *  - "conversar": además, un modelo de lenguaje chico redacta la respuesta
 *    con sus palabras, usando SÓLO las fichas encontradas. Necesita una PC
 *    con más memoria y es más lento.
 *
 * Regla de oro: la IA nunca rompe a Flowy. Si Ollama no está, no tiene los
 * modelos, tarda demasiado o falla, `responder()` devuelve null y contesta el
 * motor de siempre. Todo queda en la PC: nada sale a internet.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aclararTemas,
  equivalenciasKB,
  fijarTemaCharla,
  manualKB,
  ofrecerTemas,
  rankingPalabras,
  responderTema,
  temaActual,
  temaPorGidx,
  temasKB,
  type AssistantAnswer,
  type TemaKB,
} from '../engine';
import { OLLAMA_URL_POR_DEFECTO, OllamaClient, OllamaError, type ChatMensaje, type ProgresoDescarga } from './ollama';
import { huellaDe, IndiceSemantico, type DocSemantico } from './semantico';

export type ModoIA = 'apagado' | 'entender' | 'conversar';

export interface ConfigIA {
  modo: ModoIA;
  url: string;
  modeloEmbeddings: string;
  modeloChat: string;
}

export const CONFIG_IA_POR_DEFECTO: ConfigIA = {
  modo: 'apagado',
  url: OLLAMA_URL_POR_DEFECTO,
  // Versión comprimida (8 bits): 338 MB y 20 ms por pregunta sólo con
  // procesador, contra 622 MB y 450 ms de la completa (medido 30-sep-2026),
  // con casi los mismos aciertos (63 contra 65 de 72 en el examen).
  modeloEmbeddings: 'embeddinggemma:300m-qat-q8_0',
  modeloChat: 'qwen3:1.7b',
};

export interface EstadoIA {
  modo: ModoIA;
  ollama: { disponible: boolean; version: string | null; url: string };
  modelos: {
    embeddings: { nombre: string; descargado: boolean };
    chat: { nombre: string; descargado: boolean; necesario: boolean };
  };
  indice: { estado: 'sin-armar' | 'armando' | 'listo' | 'error'; progreso: number; vectores: number };
  descarga: { modelo: string; estado: string; fraccion: number | null; bytes: number; total: number } | null;
  /** true = en este momento Flowy responde con IA. */
  activa: boolean;
  ultimoError: string | null;
  /** Duración de la última respuesta con IA (ms), para mostrar si la PC da. */
  ultimaRespuestaMs: number | null;
}

/** Umbrales de similitud (coseno), propios de cada modelo de embeddings. */
export interface Umbrales {
  /** A partir de acá el tema es claro: en "conversar" se muestran sus botones y su captura. */
  seguro: number;
  /**
   * Ventaja mínima sobre el segundo tema para no repreguntar. En 0 no
   * repregunta nunca: medido con el examen (30-sep-2026), repreguntar con
   * ventaja 0,03 pedía aclaración 26 veces de 72 para rescatar sólo 2 errores.
   */
  ventaja: number;
  /** Por debajo de esto no hay nada parecido en la base: responde el motor ("no sé" / manual). */
  minimo: number;
}

/**
 * Calibrados con el examen de Flowy (electron/__tests__/fixtures/flowy-examen.json)
 * y 14 preguntas fuera de tema, con embeddinggemma recortado a 256 dimensiones
 * (30-sep-2026): los aciertos dan 0,81 o más; con mínimo 0,80 se descartan 9 de
 * las 14 ajenas ("cómo hago un asado", "la capital de Francia") sin perder
 * ningún acierto. El 10% más bajo de los aciertos está en 0,86.
 */
const UMBRALES_POR_MODELO: { prefijo: string; umbrales: Umbrales }[] = [
  { prefijo: 'embeddinggemma', umbrales: { seguro: 0.86, ventaja: 0, minimo: 0.8 } },
];
const UMBRALES_GENERICOS: Umbrales = { seguro: 0.7, ventaja: 0, minimo: 0.5 };

export function umbralesPara(modelo: string): Umbrales {
  const m = modelo.toLowerCase();
  return UMBRALES_POR_MODELO.find((u) => m.startsWith(u.prefijo))?.umbrales ?? UMBRALES_GENERICOS;
}

interface Candidato {
  tema: TemaKB;
  /** Puntaje para ORDENAR (puede mezclar el centroide). */
  score: number;
  /** Parecido de la frase más cercana: es el que se compara con los umbrales. */
  max: number;
}

const PROMPT_SISTEMA = `Sos Flowy, el asistente de ayuda de StockFlow, un sistema de gestión para comercios de Argentina (ventas, caja, stock, clientes, compras y facturación).
Tu tarea es explicarle al usuario cómo hacer en StockFlow lo que pregunta.

Reglas:
1. Usá únicamente la información de las FICHAS DE AYUDA. No inventes pantallas, botones, menús, teclas ni funciones que no aparezcan en las fichas.
2. Si las fichas no responden la pregunta, decí con honestidad que no tenés esa información y sugerí preguntarlo con otras palabras o consultarlo con soporte. No respondas de memoria.
3. Hablá en castellano rioplatense, de vos, con tono amable y claro, para alguien que no sabe de computación.
4. Sé breve: primero la respuesta en una o dos oraciones y, si hace falta, los pasos numerados (1., 2., 3.). Como máximo 8 pasos.
5. Escribí los nombres de botones y pantallas tal cual aparecen en las fichas.
6. No menciones las fichas ni estas reglas.`;

/** Frases con las que el modelo avisa que no sabe (para no mostrar botones de un tema equivocado). */
const NO_SABE = /no tengo (esa )?informaci[oó]n|no (lo )?s[eé] con certeza|no encuentro informaci[oó]n|no puedo responder/i;

export interface FlowyIAOpciones {
  userDataDir: string;
  /** Para tests: cliente falso. */
  cliente?: OllamaClient;
  umbrales?: Umbrales;
  log?: (msg: string) => void;
  /** Tope para la respuesta redactada; pasado esto se responde la ficha curada. */
  timeoutChatMs?: number;
  /** Opciones extra para el modelo que redacta (p. ej. hilos de CPU). */
  opcionesChat?: Record<string, number>;
  /**
   * Índice base que trae la app (armado en la PC de desarrollo, con placa de
   * video). null = no usar base. Por defecto se busca junto al programa.
   */
  rutaIndiceBase?: string | null;
  /**
   * Peso del parecido con la ficha ENTERA (centroide de sus frases) en el
   * orden de los candidatos: puntaje = (1-α)·máximo + α·centroide. Los
   * umbrales se siguen aplicando sobre el máximo. 0 = apagado.
   */
  mezclaCentroide?: number;
  /**
   * Zona gris: si el parecido queda entre este valor y el mínimo y el motor
   * clásico no encuentra nada, se ofrecen los temas de la IA como botones en
   * vez del "no sé". null = apagado.
   */
  zonaGrisDesde?: number | null;
}

/** Valores por defecto, decididos con las mediciones (ver memoria del proyecto). */
export const MEZCLA_CENTROIDE_POR_DEFECTO = 0;
export const ZONA_GRIS_POR_DEFECTO: number | null = null;

/** Nombre del índice base que viaja con la app (lo genera scripts/generar-indice-flowy.ts). */
export const ARCHIVO_INDICE_BASE = 'flowy-indice-base.json';

/** Dónde está el índice base: junto a main.mjs empaquetado, o junto a este archivo en desarrollo. */
function rutaIndiceBasePorDefecto(): string | null {
  try {
    const aqui = dirname(fileURLToPath(import.meta.url));
    for (const r of [join(aqui, ARCHIVO_INDICE_BASE), join(aqui, 'ia', ARCHIVO_INDICE_BASE)]) {
      if (existsSync(r)) return r;
    }
  } catch {
    /* sin base: se arma en la PC */
  }
  return null;
}

export class FlowyIA {
  private config: ConfigIA;
  private cliente: OllamaClient;
  private readonly rutaConfig: string;
  private readonly rutaIndice: string;
  private readonly umbralesFijos: Umbrales | null;
  private readonly log: (msg: string) => void;
  private readonly timeoutChatMs: number;
  private readonly opcionesChat: Record<string, number>;
  private readonly rutaIndiceBase: string | null;
  private readonly mezclaCentroide: number;
  private readonly zonaGrisDesde: number | null;

  private indice: IndiceSemantico | null = null;
  /** Hasta cuándo sabemos que cada modelo está cargado en memoria (ms). */
  private cargadoHasta = new Map<string, number>();
  private cargando = new Map<string, Promise<void>>();
  private estadoIndice: EstadoIA['indice'] = { estado: 'sin-armar', progreso: 0, vectores: 0 };
  private armando: Promise<void> | null = null;
  private cancelarArmado: AbortController | null = null;
  private descarga: EstadoIA['descarga'] = null;
  private descargando: Promise<void> | null = null;
  private ollamaVersion: string | null = null;
  private modelosPresentes = new Map<string, string>(); // nombre → digest
  private ultimoError: string | null = null;
  private ultimaRespuestaMs: number | null = null;
  private ultimoTop: { id: string; score: number }[] = [];
  private temas: TemaKB[] | null = null;

  constructor(opts: FlowyIAOpciones) {
    this.rutaConfig = join(opts.userDataDir, 'flowy-ia.json');
    this.rutaIndice = join(opts.userDataDir, 'flowy-ia-indice.json');
    this.config = this.leerConfig();
    this.cliente = opts.cliente ?? new OllamaClient({ baseUrl: this.config.url });
    this.umbralesFijos = opts.umbrales ?? null;
    this.log = opts.log ?? ((m) => console.log(`[flowy-ia] ${m}`));
    this.timeoutChatMs = opts.timeoutChatMs ?? 90_000;
    this.opcionesChat = opts.opcionesChat ?? {};
    this.rutaIndiceBase = opts.rutaIndiceBase === undefined ? rutaIndiceBasePorDefecto() : opts.rutaIndiceBase;
    this.mezclaCentroide = opts.mezclaCentroide ?? MEZCLA_CENTROIDE_POR_DEFECTO;
    this.zonaGrisDesde = opts.zonaGrisDesde === undefined ? ZONA_GRIS_POR_DEFECTO : opts.zonaGrisDesde;
  }

  /* ----------------------------- configuración ----------------------------- */

  private leerConfig(): ConfigIA {
    try {
      if (existsSync(this.rutaConfig)) {
        const j = JSON.parse(readFileSync(this.rutaConfig, 'utf8')) as Partial<ConfigIA>;
        const modo: ModoIA = j.modo === 'entender' || j.modo === 'conversar' ? j.modo : 'apagado';
        return {
          modo,
          url: typeof j.url === 'string' && j.url ? j.url : CONFIG_IA_POR_DEFECTO.url,
          modeloEmbeddings: typeof j.modeloEmbeddings === 'string' && j.modeloEmbeddings ? j.modeloEmbeddings : CONFIG_IA_POR_DEFECTO.modeloEmbeddings,
          modeloChat: typeof j.modeloChat === 'string' && j.modeloChat ? j.modeloChat : CONFIG_IA_POR_DEFECTO.modeloChat,
        };
      }
    } catch {
      /* config rota: se usa la de fábrica (IA apagada) */
    }
    return { ...CONFIG_IA_POR_DEFECTO };
  }

  private guardarConfig(): void {
    mkdirSync(dirname(this.rutaConfig), { recursive: true });
    writeFileSync(this.rutaConfig, `${JSON.stringify(this.config, null, 2)}\n`, 'utf8');
  }

  getConfig(): ConfigIA {
    return { ...this.config };
  }

  private get umbrales(): Umbrales {
    return this.umbralesFijos ?? umbralesPara(this.config.modeloEmbeddings);
  }

  /** true = en este momento las preguntas de temas pasan por la IA. */
  activa(): boolean {
    return this.config.modo !== 'apagado' && this.indice !== null;
  }

  /** Los 3 temas que consideró la IA en la última respuesta (para el registro local). */
  ultimosCandidatos(): { id: string; score: number }[] {
    return [...this.ultimoTop];
  }

  /** true = la respuesta se redacta con el modelo de lenguaje (tarda: conviene mostrarla mientras se escribe). */
  redacta(): boolean {
    return this.activa() && this.config.modo === 'conversar' && this.tieneModelo(this.config.modeloChat);
  }

  /** Cambia el modo (y opcionalmente los modelos). Prepara todo en segundo plano. */
  async configurar(cambios: Partial<ConfigIA>): Promise<EstadoIA> {
    const antes = this.config;
    const modo: ModoIA = cambios.modo === 'entender' || cambios.modo === 'conversar' || cambios.modo === 'apagado' ? cambios.modo : antes.modo;
    this.config = {
      modo,
      url: cambios.url?.trim() || antes.url,
      modeloEmbeddings: cambios.modeloEmbeddings?.trim() || antes.modeloEmbeddings,
      modeloChat: cambios.modeloChat?.trim() || antes.modeloChat,
    };
    if (this.config.url !== antes.url) this.cliente = new OllamaClient({ baseUrl: this.config.url });
    if (this.config.modeloEmbeddings !== antes.modeloEmbeddings || this.config.url !== antes.url) {
      this.cancelarArmado?.abort();
      this.indice = null;
      this.estadoIndice = { estado: 'sin-armar', progreso: 0, vectores: 0 };
    }
    this.guardarConfig();
    this.ultimoError = null;
    if (this.config.modo !== 'apagado') void this.preparar();
    return this.estado();
  }

  /* -------------------------------- estado -------------------------------- */

  private async refrescarOllama(): Promise<void> {
    this.ollamaVersion = await this.cliente.version();
    this.modelosPresentes.clear();
    if (!this.ollamaVersion) return;
    try {
      for (const m of await this.cliente.modelos()) this.modelosPresentes.set(m.nombre, m.digest);
    } catch {
      /* se reintenta en la próxima consulta */
    }
  }

  private tieneModelo(nombre: string): boolean {
    if (this.modelosPresentes.has(nombre)) return true;
    // "modelo" sin etiqueta equivale a "modelo:latest".
    return !nombre.includes(':') && this.modelosPresentes.has(`${nombre}:latest`);
  }

  private digestDe(nombre: string): string {
    return this.modelosPresentes.get(nombre) ?? this.modelosPresentes.get(`${nombre}:latest`) ?? '';
  }

  async estado(): Promise<EstadoIA> {
    await this.refrescarOllama();
    const necesitaChat = this.config.modo === 'conversar';
    return {
      modo: this.config.modo,
      ollama: { disponible: Boolean(this.ollamaVersion), version: this.ollamaVersion, url: this.config.url },
      modelos: {
        embeddings: { nombre: this.config.modeloEmbeddings, descargado: this.tieneModelo(this.config.modeloEmbeddings) },
        chat: { nombre: this.config.modeloChat, descargado: this.tieneModelo(this.config.modeloChat), necesario: necesitaChat },
      },
      indice: { ...this.estadoIndice },
      descarga: this.descarga ? { ...this.descarga } : null,
      activa: this.config.modo !== 'apagado' && this.indice !== null && Boolean(this.ollamaVersion),
      ultimoError: this.ultimoError,
      ultimaRespuestaMs: this.ultimaRespuestaMs,
    };
  }

  /* ------------------------------ preparación ------------------------------ */

  /**
   * Deja todo listo en segundo plano: verifica Ollama y los modelos, y carga o
   * arma el índice. Nunca lanza; los problemas quedan en `ultimoError`.
   */
  async preparar(): Promise<void> {
    if (this.config.modo === 'apagado') return;
    if (this.armando) return this.armando;
    this.armando = (async () => {
      try {
        await this.refrescarOllama();
        if (!this.ollamaVersion) {
          this.ultimoError = 'Ollama no está instalado o no está abierto en esta PC.';
          return;
        }
        const modelo = this.config.modeloEmbeddings;
        if (!this.tieneModelo(modelo)) {
          this.ultimoError = `Falta descargar el modelo ${modelo}.`;
          return;
        }
        await this.cargarOArmarIndice(modelo, this.digestDe(modelo));
        this.ultimoError = null;
      } catch (e) {
        this.ultimoError = (e as Error).message;
        this.log(`preparar: ${this.ultimoError}`);
      } finally {
        this.armando = null;
      }
    })();
    return this.armando;
  }

  /** Documentos del índice (frases de cada ficha + títulos del manual), en el orden del índice. */
  static documentos(): { docs: DocSemantico[]; huella: string } {
    return FlowyIA.armarDocs(temasKB());
  }

  private docsBase(): { docs: DocSemantico[]; huella: string } {
    this.temas = temasKB();
    return FlowyIA.armarDocs(this.temas);
  }

  private static armarDocs(temas: TemaKB[]): { docs: DocSemantico[]; huella: string } {
    const docs: DocSemantico[] = [];
    for (const t of temas) {
      const vistos = new Set<string>();
      const frases = [t.canonical, ...t.patterns];
      for (const f of frases) {
        const limpia = f.replace(/\s+/g, ' ').trim();
        const clave = limpia.toLowerCase();
        if (!limpia || vistos.has(clave)) continue;
        vistos.add(clave);
        docs.push({ clave: `i:${t.gidx}`, texto: limpia });
        // Tope de seguridad: hoy ningún tema pasa de 26 frases (con 16 se cortaban las frases nuevas).
        if (vistos.size >= 40) break;
      }
    }
    for (const m of manualKB()) {
      const titulo = [m.title, m.heading].filter(Boolean).join(' — ');
      if (titulo) docs.push({ clave: `m:${m.idx}`, texto: titulo });
    }
    const huella = huellaDe(...docs.map((d) => `${d.clave}\u0001${d.texto}`));
    return { docs, huella };
  }

  /**
   * Deja el índice listo haciendo el menor trabajo posible en esta PC:
   *  1. su propio índice guardado, si es del mismo modelo y de la misma base;
   *  2. si no, reutiliza vectores (del índice propio o del índice BASE que
   *     trae la app, verificado con frases testigo) y calcula sólo lo que
   *     cambió. Sin base, una PC sin placa de video tardaría unos minutos.
   */
  private async cargarOArmarIndice(modelo: string, digest: string): Promise<void> {
    const { docs, huella } = this.docsBase();
    const propio = IndiceSemantico.cargar(this.rutaIndice);
    const propioSirve = Boolean(propio && propio.modelo === modelo && propio.digest === digest);
    if (propio && propioSirve && propio.huella === huella) {
      this.indice = propio;
      this.estadoIndice = { estado: 'listo', progreso: 1, vectores: propio.tamaño };
      return;
    }
    this.estadoIndice = { estado: 'armando', progreso: 0, vectores: 0 };
    this.cancelarArmado = new AbortController();
    const signal = this.cancelarArmado.signal;
    const inicio = Date.now();
    try {
      let reutilizar: IndiceSemantico | null = propioSirve ? propio : null;
      if (this.rutaIndiceBase) {
        const base = IndiceSemantico.cargar(this.rutaIndiceBase);
        if (base && base.modelo === modelo && (!reutilizar || base.faltantes(docs) < reutilizar.faltantes(docs))) {
          if (await base.esCompatible(this.cliente, signal)) reutilizar = base;
          else this.log('el índice base no coincide con el modelo instalado: se arma en esta PC');
        }
      }
      const faltan = reutilizar ? reutilizar.faltantes(docs) : docs.length;
      this.log(`preparando índice: ${faltan} frase(s) a calcular de ${docs.length}`);
      const nuevo = await IndiceSemantico.construir(this.cliente, modelo, digest, huella, docs, {
        reutilizar,
        signal,
        alProgreso: (hechos, total) => {
          this.estadoIndice = { estado: 'armando', progreso: total ? hechos / total : 0, vectores: hechos };
        },
      });
      nuevo.guardar(this.rutaIndice);
      this.indice = nuevo;
      this.estadoIndice = { estado: 'listo', progreso: 1, vectores: nuevo.tamaño };
      this.log(`índice armado: ${nuevo.tamaño} vectores en ${Math.round((Date.now() - inicio) / 1000)} s`);
    } catch (e) {
      this.estadoIndice = { estado: 'error', progreso: 0, vectores: 0 };
      throw e;
    } finally {
      this.cancelarArmado = null;
    }
  }

  /** Descarga los modelos que falten para el modo elegido (en segundo plano). */
  descargarModelos(): EstadoIA['descarga'] {
    if (this.descargando) return this.descarga;
    const faltan = [this.config.modeloEmbeddings, ...(this.config.modo === 'conversar' ? [this.config.modeloChat] : [])];
    this.descargando = (async () => {
      try {
        await this.refrescarOllama();
        if (!this.ollamaVersion) throw new Error('Ollama no está instalado o no está abierto en esta PC.');
        for (const modelo of faltan) {
          if (this.tieneModelo(modelo)) continue;
          this.descarga = { modelo, estado: 'Preparando…', fraccion: null, bytes: 0, total: 0 };
          // Con internet lento la descarga a veces se corta: Ollama guarda lo
          // bajado, así que reintentar retoma desde donde quedó.
          for (let intento = 1; ; intento++) {
            try {
              await this.cliente.descargar(modelo, (p: ProgresoDescarga) => {
                this.descarga = { modelo, estado: p.estado, fraccion: p.fraccion, bytes: p.completado, total: p.total };
              });
              break;
            } catch (e) {
              if (intento >= 5) throw e;
              this.log(`descarga de ${modelo} cortada (intento ${intento}): ${(e as Error).message}`);
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          await this.refrescarOllama();
        }
        this.descarga = null;
        this.ultimoError = null;
        await this.preparar();
      } catch (e) {
        this.ultimoError = (e as Error).message;
        this.descarga = null;
      } finally {
        this.descargando = null;
      }
    })();
    return this.descarga ?? { modelo: faltan[0] ?? '', estado: 'Preparando…', fraccion: null, bytes: 0, total: 0 };
  }

  /** Carga los modelos en memoria (al abrir el panel) para que la primera respuesta no tarde. */
  async precalentar(): Promise<void> {
    if (this.config.modo === 'apagado' || !this.indice) return;
    const cargas = [this.cargarEnSegundoPlano(this.config.modeloEmbeddings)];
    if (this.redacta()) cargas.push(this.cargarEnSegundoPlano(this.config.modeloChat));
    await Promise.all(cargas);
  }

  /**
   * ¿El modelo ya está en memoria? Si no, lo empieza a cargar en segundo plano
   * y devuelve false: esa pregunta la contesta el motor de siempre al instante.
   * Cargar puede tardar más de 20 segundos en una PC con poca memoria libre, y
   * si se cortaba la espera, Ollama abortaba la carga y volvía a empezar en
   * cada pregunta (pasó en las pruebas del 30-sep-2026).
   */
  private async enMemoria(modelo: string): Promise<boolean> {
    if (Date.now() < (this.cargadoHasta.get(modelo) ?? 0)) return true;
    try {
      const cargados = await this.cliente.cargados();
      if (cargados.includes(modelo) || cargados.includes(`${modelo}:latest`)) {
        this.cargadoHasta.set(modelo, Date.now() + 60_000);
        return true;
      }
    } catch (e) {
      this.anotarFalla(e);
      return false;
    }
    void this.cargarEnSegundoPlano(modelo);
    return false;
  }

  private cargarEnSegundoPlano(modelo: string): Promise<void> {
    const enCurso = this.cargando.get(modelo);
    if (enCurso) return enCurso;
    const esChat = modelo === this.config.modeloChat && modelo !== this.config.modeloEmbeddings;
    const p = (async () => {
      try {
        if (esChat) {
          await this.cliente.chat(modelo, [{ role: 'user', content: 'hola' }], {
            opciones: { num_predict: 1, num_ctx: 4096, ...this.opcionesChat },
            keepAlive: '30m',
            timeoutMs: 300_000,
          });
        } else {
          await this.cliente.embed(modelo, ['hola'], { keepAlive: '4h', timeoutMs: 300_000 });
        }
        this.cargadoHasta.set(modelo, Date.now() + 60_000);
      } catch (e) {
        this.log(`no se pudo cargar ${modelo}: ${(e as Error).message}`);
      } finally {
        this.cargando.delete(modelo);
      }
    })();
    this.cargando.set(modelo, p);
    return p;
  }

  /* ------------------------------ respuesta ------------------------------ */

  private grupos: Map<string, number> | null = null;

  /** "area/id" → número de grupo de fichas equivalentes (intents.json → equivalencias). */
  private gruposEquivalentes(): Map<string, number> {
    if (!this.grupos) {
      this.grupos = new Map();
      equivalenciasKB().forEach((g, i) => g.forEach((f) => this.grupos!.set(f, i)));
    }
    return this.grupos;
  }

  /** Temas candidatos por significado (y un refuerzo por palabras). */
  async buscarTemas(pregunta: string, convId: string, pantalla: string | null): Promise<Candidato[]> {
    if (!this.indice) return [];
    const temas = this.temas ?? temasKB();
    const porGidx = new Map(temas.map((t) => [t.gidx, t]));

    const actual = temaActual(convId);
    const areaPreferida = actual?.area ?? pantalla;

    // 1) Clic en un botón de sugerencia: el panel manda la pregunta canónica
    //    tal cual. Se responde esa ficha directo (antes se buscaba como texto
    //    libre y, en una charla ya empezada, acertaba 43%: medido 1-oct-2026).
    const exacta = normalizarTexto(pregunta);
    const iguales = temas.filter((t) => normalizarTexto(t.canonical) === exacta);
    if (iguales.length) {
      const elegida = iguales.find((t) => t.area === areaPreferida) ?? iguales[0]!;
      return [{ tema: elegida, score: 1, max: 1 }];
    }

    // 2) Seguimiento referencial ("¿y para borrarlo?"): sólo ESOS se buscan
    //    junto con el tema de la charla, y el tema anterior queda afuera (no se
    //    contesta lo mismo dos veces). Antes TODA pregunta de ≤4 palabras se
    //    pegaba al tema anterior y la canónica dominaba el vector: "cómo cierro
    //    el día" después de una venta respondía otra vez la venta.
    const referencial = Boolean(actual) && esSeguimientoReferencial(pregunta);
    const consulta = referencial ? `${actual!.canonical} ${pregunta}` : pregunta;

    const vector = await this.indice.vectorPregunta(this.cliente, consulta);
    this.cargadoHasta.set(this.config.modeloEmbeddings, Date.now() + 60_000);
    const mejores = new Map<number, number>();
    for (const c of this.indice.buscar(vector, 80)) {
      if (!c.clave.startsWith('i:')) continue;
      const gidx = Number(c.clave.slice(2));
      if (!porGidx.has(gidx)) continue;
      if (referencial && gidx === actual!.gidx) continue;
      if (c.score > (mejores.get(gidx) ?? -Infinity)) mejores.set(gidx, c.score);
    }
    // Refuerzo chico por palabras, SÓLO a temas que ya aparecieron por
    // significado: un tema que sólo coincide en palabras sueltas no puede
    // pasar el mínimo (si no, una pregunta ajena terminaba respondida).
    const palabrasTop = rankingPalabras(pregunta, actual?.area ?? pantalla, 3);
    palabrasTop.forEach((r, i) => {
      if (r.score < 6) return;
      const prev = mejores.get(r.gidx);
      if (prev === undefined) return;
      mejores.set(r.gidx, prev + (i === 0 ? 0.03 : 0.015));
    });
    const centroides = this.mezclaCentroide > 0 ? this.indice.centroides() : null;
    const ordenados: Candidato[] = [...mejores.entries()]
      .map(([gidx, score]) => {
        const tema = porGidx.get(gidx)!;
        const enPantalla = pantalla && tema.area === pantalla ? 0.01 : 0;
        let orden = score;
        const cen = centroides?.get(`i:${gidx}`);
        if (cen) {
          let dot = 0;
          for (let k = 0; k < cen.length; k++) dot += vector[k]! * cen[k]!;
          orden = (1 - this.mezclaCentroide) * score + this.mezclaCentroide * dot;
        }
        return { tema, score: orden + enPantalla, max: score + enPantalla };
      })
      .sort((a, b) => b.score - a.score);
    // 3) Fichas gemelas (mismo id o misma pregunta en otra área, p. ej.
    //    descuento-global en Ventas, Presupuestos y Compras): ocupan UN solo
    //    lugar, así los botones muestran temas distintos; entre gemelas gana
    //    la del área de la charla o de la pantalla.
    const grupo = this.gruposEquivalentes();
    const resultado: Candidato[] = [];
    const lugar = new Map<string, number>(); // "id:…", "canon:…" o "grupo:…" → posición en resultado
    for (const c of ordenados) {
      const g = grupo.get(`${c.tema.area}/${c.tema.id}`);
      const claves = [`id:${c.tema.id}`, `canon:${normalizarTexto(c.tema.canonical)}`, ...(g !== undefined ? [`grupo:${g}`] : [])];
      const pos = claves.map((k) => lugar.get(k)).find((p) => p !== undefined);
      if (pos === undefined) {
        claves.forEach((k) => lugar.set(k, resultado.length));
        resultado.push(c);
      } else if (areaPreferida && c.tema.area === areaPreferida && resultado[pos]!.tema.area !== areaPreferida) {
        // La gemela del área preferida toma el lugar (y el puntaje) de la otra.
        resultado[pos] = { tema: c.tema, score: resultado[pos]!.score, max: resultado[pos]!.max };
        claves.forEach((k) => lugar.set(k, pos));
      }
    }
    return resultado.slice(0, 5);
  }

  /**
   * Responde con IA, o devuelve null para que conteste el motor de siempre.
   * `alPedazo`: recibe el texto a medida que el modelo lo escribe.
   */
  async responder(
    pregunta: string,
    convId: string,
    pantalla: string | null,
    alPedazo?: (textoHastaAhora: string) => void,
  ): Promise<AssistantAnswer | null> {
    this.ultimoTop = [];
    if (this.config.modo === 'apagado' || !this.indice || !pregunta.trim()) return null;
    // Modelo todavía sin cargar: contesta el motor ya, y la IA se carga para la próxima.
    if (!(await this.enMemoria(this.config.modeloEmbeddings))) return null;
    const inicio = Date.now();
    let candidatos: Candidato[];
    try {
      candidatos = await this.buscarTemas(pregunta, convId, pantalla);
    } catch (e) {
      this.anotarFalla(e);
      return null;
    }
    this.ultimoTop = candidatos.slice(0, 3).map((c) => ({ id: `${c.tema.area}/${c.tema.id}`, score: Math.round(c.score * 1000) / 1000 }));
    const [primero, segundo] = candidatos;
    if (!primero) return null;
    if (primero.max < this.umbrales.minimo) {
      // Zona gris: la IA duda y el motor clásico no tiene nada → ofrecer los temas de la IA.
      if (this.zonaGrisDesde !== null && primero.max >= this.zonaGrisDesde) {
        const motorTiene = rankingPalabras(pregunta, temaActual(convId)?.area ?? pantalla, 1)[0];
        if (!motorTiene || motorTiene.score < 6) {
          return {
            reply: 'No estoy seguro de haber entendido. ¿Es alguna de estas? Tocá la que corresponda, o escribímelo con otras palabras.',
            suggestions: candidatos.slice(0, 3).map((c) => c.tema.canonical),
            kind: 'fallback',
          };
        }
      }
      return null; // nada parecido: que responda el motor (manual / "no sé")
    }

    const seguro = primero.max >= this.umbrales.seguro && (!segundo || primero.score - segundo.score >= this.umbrales.ventaja);

    if (this.redacta() && (await this.enMemoria(this.config.modeloChat))) {
      const redactada = await this.redactar(pregunta, convId, candidatos, seguro, alPedazo);
      if (redactada) {
        this.ultimaRespuestaMs = Date.now() - inicio;
        this.cargadoHasta.set(this.config.modeloChat, Date.now() + 60_000);
        return redactada;
      }
      // Si el modelo no pudo (lento, error), se cae a la ficha curada.
    }

    this.ultimaRespuestaMs = Date.now() - inicio;
    // Dudoso (sólo si se configuró una ventaja mínima): se pregunta entre los dos.
    if (!seguro && segundo && primero.score - segundo.score < this.umbrales.ventaja) {
      const aclaracion = aclararTemas(primero.tema.gidx, segundo.tema.gidx, convId);
      if (aclaracion) return aclaracion;
    }
    return this.conAlternativas(responderTema(primero.tema.gidx, convId), candidatos, convId);
  }

  /**
   * Los botones de sugerencia muestran PRIMERO los otros temas que encontró la
   * IA. Medido con preguntas nuevas (30-sep-2026): el primer tema acierta 20
   * de 30, pero el correcto está entre los tres primeros en 27 de 30; así,
   * cuando la primera respuesta no era, la buena queda a un clic.
   */
  private conAlternativas(r: AssistantAnswer, candidatos: Candidato[], convId = 'default'): AssistantAnswer {
    const otros = candidatos.slice(1, 4).filter((c) => c.max >= this.umbrales.minimo);
    if (!otros.length) return r;
    // Los botones y la oferta "decime sí" muestran SÓLO temas que encontró la
    // IA: los "relacionados" por palabras ofrecían cosas sin relación.
    return {
      ...r,
      reply: ofrecerTemas(r.reply, otros.map((c) => c.tema.gidx), convId),
      suggestions: otros.map((c) => c.tema.canonical).slice(0, 3),
    };
  }

  private anotarFalla(e: unknown): void {
    const err = e as Error;
    this.ultimoError = err instanceof OllamaError && err.tipo === 'no-disponible' ? 'Ollama dejó de responder en esta PC.' : err.message;
    this.log(`responder: ${this.ultimoError}`);
  }

  private fichas(candidatos: Candidato[]): string {
    return candidatos
      .slice(0, 3)
      .map((c, i) => {
        const t = c.tema;
        const pasos = t.steps.length ? `\nPasos:\n${t.steps.map((s, k) => `${k + 1}. ${s}`).join('\n')}` : '';
        return `[${i + 1}] ${t.canonical}\n${t.answer.trim()}${pasos}`;
      })
      .join('\n\n');
  }

  private async redactar(
    pregunta: string,
    convId: string,
    candidatos: Candidato[],
    seguro: boolean,
    alPedazo?: (textoHastaAhora: string) => void,
  ): Promise<AssistantAnswer | null> {
    const actual = temaActual(convId);
    const contexto = actual ? `\n\nEl usuario venía preguntando sobre: ${actual.canonical}` : '';
    const mensajes: ChatMensaje[] = [
      { role: 'system', content: PROMPT_SISTEMA },
      {
        role: 'user',
        content: `FICHAS DE AYUDA:\n${this.fichas(candidatos)}${contexto}\n\nPREGUNTA DEL USUARIO: ${pregunta.trim()}`,
      },
    ];
    let acumulado = '';
    try {
      const r = await this.cliente.chat(this.config.modeloChat, mensajes, {
        opciones: { temperature: 0.2, top_p: 0.9, num_ctx: 4096, num_predict: 450, ...this.opcionesChat },
        keepAlive: '30m',
        timeoutMs: this.timeoutChatMs,
        alToken: alPedazo
          ? (p) => {
              acumulado += p;
              alPedazo(acumulado);
            }
          : undefined,
      });
      const texto = limpiarRespuesta(r.texto);
      if (!texto) return null;
      const primero = candidatos[0]!.tema;
      const noSabe = NO_SABE.test(texto);
      if (noSabe) {
        return { reply: texto, suggestions: candidatos.slice(0, 3).map((c) => c.tema.canonical), kind: 'fallback', generated: true };
      }
      fijarTemaCharla(primero.gidx, convId);
      const relacionados = candidatos.slice(1, 4).map((c) => c.tema.canonical);
      return {
        reply: texto,
        suggestions: relacionados,
        image: seguro ? primero.image : null,
        actions: seguro && primero.action ? [primero.action] : [],
        kind: 'intent',
        generated: true,
      };
    } catch (e) {
      this.anotarFalla(e);
      return null;
    }
  }

  /** Para tests y para el examen: tema elegido por significado (sin redactar). */
  async elegirTema(pregunta: string, convId = 'examen', pantalla: string | null = null): Promise<{ id: string; score: number; segundo: number } | null> {
    const c = await this.buscarTemas(pregunta, convId, pantalla);
    if (!c[0]) return null;
    return { id: c[0].tema.id, score: c[0].max, segundo: c[1]?.max ?? 0 };
  }

  /** Tema por índice (para el examen). */
  static tema(gidx: number): TemaKB | null {
    return temaPorGidx(gidx);
  }
}

/** Minúsculas, sin acentos ni signos: para comparar una pregunta con una canónica. */
export function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MARCAS_REFERENCIALES = new Set([
  'eso', 'esa', 'ese', 'esto', 'esta', 'este', 'ahi', 'alli', 'aca', 'despues', 'tambien', 'mismo', 'misma', 'lo', 'la', 'los', 'las', 'le', 'les',
]);

/**
 * ¿La pregunta corta se refiere al tema anterior? ("¿y para borrarlo?",
 * "¿y eso dónde está?", "¿y después?"). Sin una marca así se busca sola:
 * "cómo cierro el día" es un tema nuevo aunque sea corta.
 */
export function esSeguimientoReferencial(pregunta: string): boolean {
  const t = normalizarTexto(pregunta);
  const palabras = t.split(' ').filter(Boolean);
  if (!palabras.length || palabras.length > 5) return false;
  if (palabras[0] === 'y' || palabras[0] === 'e') return true;
  if (palabras.some((p) => MARCAS_REFERENCIALES.has(p))) return true;
  // Pronombre pegado al verbo: modificarlo, borrarla, cambiarlos, sacarle…
  return palabras.some((p) => p.length > 5 && /(ar|er|ir)(lo|la|los|las|le|les)$/.test(p));
}

/** Saca restos que los modelos chicos a veces agregan (etiquetas de pensamiento, referencias a fichas). */
export function limpiarRespuesta(texto: string): string {
  return texto
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    // Sólo referencias NUMERADAS a las fichas ("[2]", "según la ficha 1"): "la
    // ficha del cliente" es una pantalla real de StockFlow y no se toca.
    .replace(/\s?\[\d\]/g, '')
    .replace(/\b(seg[uú]n|en|como dice) la ficha \d+,?\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
