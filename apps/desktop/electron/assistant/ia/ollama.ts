/**
 * Cliente mínimo de OLLAMA (IA local y gratuita) para Flowy.
 *
 * Ollama corre en la misma PC (o en la PC servidor, que es donde se contestan
 * las preguntas de Flowy en modo red) y atiende en http://127.0.0.1:11434.
 * Nada sale a internet: ni la pregunta ni la respuesta.
 *
 * Reglas de este módulo:
 *  - Sin dependencias: usa el `fetch` de Node/Electron.
 *  - Todo con tiempo máximo: si Ollama no está o se cuelga, el que llama se
 *    entera enseguida y Flowy sigue con su motor de siempre.
 *  - No decide nada de negocio: sólo habla el protocolo.
 */

export const OLLAMA_URL_POR_DEFECTO = 'http://127.0.0.1:11434';

export interface OllamaModelo {
  /** Nombre con etiqueta, p. ej. "qwen3:1.7b". */
  nombre: string;
  bytes: number;
  digest: string;
}

export interface ChatMensaje {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResultado {
  texto: string;
  /** Tokens generados y leídos (para medir velocidad). */
  tokensSalida: number;
  tokensEntrada: number;
  ms: number;
}

export interface ProgresoDescarga {
  estado: string;
  /** 0..1 cuando Ollama informa tamaño; null mientras prepara. */
  fraccion: number | null;
  completado: number;
  total: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly tipo: 'no-disponible' | 'tiempo' | 'modelo-faltante' | 'respuesta',
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

type FetchLike = typeof fetch;

function unirSeñales(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}

export class OllamaClient {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { baseUrl?: string; fetchImpl?: FetchLike } = {}) {
    this.baseUrl = (opts.baseUrl ?? OLLAMA_URL_POR_DEFECTO).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async pedir(ruta: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs, signal, ...resto } = init;
    const señal = unirSeñales(signal ?? undefined, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${ruta}`, { ...resto, signal: señal });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new OllamaError(`Ollama no respondió a tiempo (${ruta})`, 'tiempo');
      }
      throw new OllamaError(`Ollama no está disponible en ${this.baseUrl}`, 'no-disponible');
    }
    if (!res.ok) {
      let detalle = '';
      try {
        detalle = ((await res.json()) as { error?: string }).error ?? '';
      } catch {
        /* sin cuerpo */
      }
      if (res.status === 404 || /not found/i.test(detalle)) {
        throw new OllamaError(detalle || `Modelo no encontrado (${ruta})`, 'modelo-faltante');
      }
      throw new OllamaError(`Ollama respondió ${res.status}${detalle ? `: ${detalle}` : ''}`, 'respuesta');
    }
    return res;
  }

  /** Versión de Ollama, o null si no está corriendo. Nunca lanza. */
  async version(timeoutMs = 1500): Promise<string | null> {
    try {
      const res = await this.pedir('/api/version', { timeoutMs });
      const j = (await res.json()) as { version?: string };
      return j.version ?? null;
    } catch {
      return null;
    }
  }

  /** Modelos descargados en esta PC. */
  async modelos(timeoutMs = 4000): Promise<OllamaModelo[]> {
    const res = await this.pedir('/api/tags', { timeoutMs });
    const j = (await res.json()) as { models?: { name?: string; model?: string; size?: number; digest?: string }[] };
    return (j.models ?? []).map((m) => ({
      nombre: m.name ?? m.model ?? '',
      bytes: m.size ?? 0,
      digest: m.digest ?? '',
    }));
  }

  /** Modelos cargados en memoria ahora mismo (los que responden sin demora). */
  async cargados(timeoutMs = 2000): Promise<string[]> {
    const res = await this.pedir('/api/ps', { timeoutMs });
    const j = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (j.models ?? []).map((m) => m.name ?? m.model ?? '').filter(Boolean);
  }

  /**
   * Vectores de significado (embeddings) para uno o varios textos.
   * `keepAlive`: cuánto queda el modelo cargado en memoria después.
   */
  async embed(
    modelo: string,
    textos: string[],
    opts: { keepAlive?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<number[][]> {
    const res = await this.pedir('/api/embed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, input: textos, truncate: true, keep_alive: opts.keepAlive ?? '10m' }),
      timeoutMs: opts.timeoutMs ?? 60_000,
      signal: opts.signal,
    });
    const j = (await res.json()) as { embeddings?: number[][] };
    if (!Array.isArray(j.embeddings) || j.embeddings.length !== textos.length) {
      throw new OllamaError('Ollama devolvió embeddings incompletos', 'respuesta');
    }
    return j.embeddings;
  }

  /**
   * Chat. Si se pasa `alToken`, pide la respuesta en streaming y la va
   * entregando de a pedazos (para mostrarla mientras se escribe).
   */
  async chat(
    modelo: string,
    mensajes: ChatMensaje[],
    opts: {
      opciones?: Record<string, number | boolean | string>;
      keepAlive?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      alToken?: (pedazo: string) => void;
    } = {},
  ): Promise<ChatResultado> {
    const inicio = Date.now();
    const streaming = Boolean(opts.alToken);
    const res = await this.pedir('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelo,
        messages: mensajes,
        stream: streaming,
        // Los modelos "que piensan" (qwen3) contestan directo: más rápido.
        think: false,
        keep_alive: opts.keepAlive ?? '10m',
        options: opts.opciones ?? {},
      }),
      timeoutMs: opts.timeoutMs ?? 120_000,
      signal: opts.signal,
    });

    if (!streaming) {
      const j = (await res.json()) as {
        message?: { content?: string };
        eval_count?: number;
        prompt_eval_count?: number;
      };
      return {
        texto: j.message?.content ?? '',
        tokensSalida: j.eval_count ?? 0,
        tokensEntrada: j.prompt_eval_count ?? 0,
        ms: Date.now() - inicio,
      };
    }

    let texto = '';
    let tokensSalida = 0;
    let tokensEntrada = 0;
    await leerLineas(res, (linea) => {
      const j = JSON.parse(linea) as {
        message?: { content?: string };
        done?: boolean;
        eval_count?: number;
        prompt_eval_count?: number;
        error?: string;
      };
      if (j.error) throw new OllamaError(j.error, 'respuesta');
      const pedazo = j.message?.content ?? '';
      if (pedazo) {
        texto += pedazo;
        opts.alToken?.(pedazo);
      }
      if (j.done) {
        tokensSalida = j.eval_count ?? 0;
        tokensEntrada = j.prompt_eval_count ?? 0;
      }
    });
    return { texto, tokensSalida, tokensEntrada, ms: Date.now() - inicio };
  }

  /** Descarga un modelo (se puede cortar y retomar: Ollama guarda lo bajado). */
  async descargar(modelo: string, alProgreso: (p: ProgresoDescarga) => void, signal?: AbortSignal): Promise<void> {
    const res = await this.pedir('/api/pull', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelo, stream: true }),
      signal,
    });
    let exito = false;
    await leerLineas(res, (linea) => {
      const j = JSON.parse(linea) as { status?: string; total?: number; completed?: number; error?: string };
      if (j.error) throw new OllamaError(j.error, 'respuesta');
      const total = j.total ?? 0;
      const completado = j.completed ?? 0;
      alProgreso({
        estado: j.status ?? '',
        fraccion: total > 0 ? Math.min(1, completado / total) : null,
        completado,
        total,
      });
      if (j.status === 'success') exito = true;
    });
    if (!exito) throw new OllamaError(`La descarga de ${modelo} no terminó`, 'respuesta');
  }
}

/** Lee un cuerpo NDJSON (una respuesta JSON por línea) a medida que llega. */
async function leerLineas(res: Response, alLeer: (linea: string) => void): Promise<void> {
  if (!res.body) throw new OllamaError('Ollama respondió sin contenido', 'respuesta');
  const lector = res.body.getReader();
  const decoder = new TextDecoder();
  let resto = '';
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    resto += decoder.decode(value, { stream: true });
    let corte = resto.indexOf('\n');
    while (corte >= 0) {
      const linea = resto.slice(0, corte).trim();
      resto = resto.slice(corte + 1);
      if (linea) alLeer(linea);
      corte = resto.indexOf('\n');
    }
  }
  const final = resto.trim();
  if (final) alLeer(final);
}
