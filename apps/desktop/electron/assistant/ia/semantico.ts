/**
 * Índice SEMÁNTICO de Flowy: busca por significado, no por palabras.
 *
 * Cada tema de la base de conocimiento (su pregunta canónica y sus frases de
 * ejemplo) se convierte en un vector con un modelo de embeddings de Ollama.
 * Después, cada pregunta del usuario se convierte en un vector y se compara
 * contra todos: "quiero ver las ventas que hice en un mes" queda cerca de
 * "¿Dónde veo las ventas registradas?" aunque casi no compartan palabras.
 *
 * Compacto: se usan las primeras 256 dimensiones (el modelo está entrenado
 * para eso) y cada número se guarda en un byte. Medido con el examen de
 * Flowy: 1,1 MB en vez de 13 MB, con los mismos aciertos.
 *
 * La app trae un índice BASE ya armado: la PC del cliente sólo calcula las
 * frases nuevas o cambiadas (`reutilizar`) y queda lista en segundos. Sin la
 * base, con el modelo comprimido tardaría alrededor de un minuto en una PC sin
 * placa de video (con el modelo completo eran ~40 minutos: por eso se usa el
 * comprimido). Antes de usar la base se verifica con tres frases TESTIGO que
 * el modelo instalado dé los mismos vectores.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { OllamaClient } from './ollama';

export interface DocSemantico {
  /** Identifica a qué pertenece el vector (p. ej. "i:123" = intent de gidx 123). */
  clave: string;
  texto: string;
}

export interface Coincidencia {
  clave: string;
  score: number;
}

interface IndiceEnDisco {
  v: 2;
  modelo: string;
  digest: string;
  huella: string;
  /** Dimensiones usadas (recortadas). */
  dims: number;
  claves: string[];
  /** Huella del texto de cada documento: permite reutilizar vectores. */
  huellasDocs: string[];
  /** Vectores normalizados, un byte por número (x·127), en base64. */
  vectores: string;
  /** Frases testigo para verificar que otro Ollama da los mismos vectores. */
  testigos: { textos: string[]; vectores: string };
}

/** Frases testigo: si el modelo instalado las vectoriza igual, la base sirve. */
const TESTIGOS = [
  '¿Cómo hago una venta?',
  'No me imprime el ticket de la impresora',
  'Quiero ver cuánto le debe un cliente',
];

/**
 * Cómo se le presenta el texto a cada familia de modelos. Algunos modelos de
 * embeddings rinden mucho mejor si se les dice qué es cada texto.
 */
export interface FormatoEmbedding {
  pregunta: (texto: string) => string;
  documento: (texto: string) => string;
  /** Dimensiones a usar (recorte "Matryoshka"); null = todas. */
  dims: number | null;
}

export function formatoPara(modelo: string): FormatoEmbedding {
  const m = modelo.toLowerCase();
  if (m.startsWith('embeddinggemma')) {
    // Las frases de ejemplo de la base son preguntas de usuarios, igual que la
    // consulta: se comparan como frases parecidas (similitud simétrica).
    // Medido: este formato le gana a "search result" (64 contra 51 aciertos de 72).
    return {
      pregunta: (t) => `task: sentence similarity | query: ${t}`,
      documento: (t) => `task: sentence similarity | query: ${t}`,
      dims: 256,
    };
  }
  if (m.startsWith('qwen3-embedding')) {
    const instruccion =
      'Instruct: Dada la pregunta de un comerciante que usa un sistema de gestión, encontrá la pregunta de ayuda equivalente\nQuery: ';
    return { pregunta: (t) => instruccion + t, documento: (t) => instruccion + t, dims: null };
  }
  return { pregunta: (t) => t, documento: (t) => t, dims: null };
}

/** Recorta a `dims` y normaliza (largo 1) dentro de `destino` desde `desde`. */
function normalizarEn(v: ArrayLike<number>, dims: number, destino: Float32Array, desde: number): void {
  let suma = 0;
  for (let i = 0; i < dims; i++) suma += v[i]! * v[i]!;
  const n = Math.sqrt(suma) || 1;
  for (let i = 0; i < dims; i++) destino[desde + i] = v[i]! / n;
}

function aBytes(m: Float32Array): string {
  const b = Buffer.alloc(m.length);
  for (let i = 0; i < m.length; i++) b.writeInt8(Math.max(-127, Math.min(127, Math.round(m[i]! * 127))), i);
  return b.toString('base64');
}

/** De bytes a vectores normalizados (el redondeo a un byte los desnormaliza apenas). */
function deBytes(base64: string, dims: number): Float32Array {
  const b = Buffer.from(base64, 'base64');
  const m = new Float32Array(b.length);
  for (let d = 0; d < b.length; d += dims) {
    let suma = 0;
    for (let k = 0; k < dims; k++) {
      const x = b.readInt8(d + k) / 127;
      m[d + k] = x;
      suma += x * x;
    }
    const n = Math.sqrt(suma) || 1;
    for (let k = 0; k < dims; k++) m[d + k] = m[d + k]! / n;
  }
  return m;
}

/** Huella corta de un contenido (para saber si la base cambió). */
export function huellaDe(...partes: string[]): string {
  const h = createHash('sha1');
  for (const p of partes) h.update(p).update('\u0000');
  return h.digest('hex').slice(0, 16);
}

/**
 * Huella de un documento para REUTILIZAR su vector: depende sólo del texto
 * (el vector es función del texto). Si dependiera de la clave, agregar una
 * ficha corría el índice de todas las siguientes y obligaba a recalcularlas
 * (pasó: 776 frases en vez de 42).
 */
export function huellaDoc(d: DocSemantico): string {
  return huellaDe(d.texto);
}

async function vectorizar(
  cliente: OllamaClient,
  modelo: string,
  textos: string[],
  dims: number | null,
  opts: { signal?: AbortSignal; lote?: number; alAvanzar?: (hechos: number) => void } = {},
): Promise<{ matriz: Float32Array; dims: number }> {
  const lote = opts.lote ?? 32;
  let d = dims ?? 0;
  let matriz = new Float32Array(0);
  for (let i = 0; i < textos.length; i += lote) {
    if (opts.signal?.aborted) throw new Error('Preparación del índice cancelada');
    const vectores = await cliente.embed(modelo, textos.slice(i, i + lote), {
      signal: opts.signal,
      timeoutMs: 600_000,
      keepAlive: '4h',
    });
    if (!matriz.length) {
      const total = vectores[0]?.length ?? 0;
      if (!total) throw new Error('El modelo de embeddings devolvió vectores vacíos');
      d = dims ? Math.min(dims, total) : total;
      matriz = new Float32Array(textos.length * d);
    }
    vectores.forEach((v, k) => normalizarEn(v, d, matriz, (i + k) * d));
    opts.alAvanzar?.(Math.min(i + lote, textos.length));
  }
  return { matriz, dims: d };
}

export class IndiceSemantico {
  private constructor(
    readonly modelo: string,
    readonly digest: string,
    readonly huella: string,
    readonly dims: number,
    readonly claves: string[],
    private readonly huellasDocs: string[],
    private readonly matriz: Float32Array,
    private readonly testigos: { textos: string[]; matriz: Float32Array },
  ) {}

  get tamaño(): number {
    return this.claves.length;
  }

  /**
   * Arma el índice. Con `reutilizar`, copia los vectores de los documentos que
   * no cambiaron y sólo calcula los nuevos (clave para PCs sin placa de video).
   */
  static async construir(
    cliente: OllamaClient,
    modelo: string,
    digest: string,
    huella: string,
    docs: DocSemantico[],
    opts: {
      reutilizar?: IndiceSemantico | null;
      alProgreso?: (hechos: number, total: number) => void;
      signal?: AbortSignal;
      lote?: number;
    } = {},
  ): Promise<IndiceSemantico> {
    const fmt = formatoPara(modelo);
    const base = opts.reutilizar ?? null;
    const huellas = docs.map(huellaDoc);
    const posBase = new Map<string, number>();
    base?.huellasDocs.forEach((h, i) => posBase.set(h, i));
    const faltan = docs.map((_, i) => i).filter((i) => !posBase.has(huellas[i]!));

    // Testigos: siempre se calculan con el modelo actual (son 3).
    const t = await vectorizar(cliente, modelo, TESTIGOS.map(fmt.documento), base?.dims ?? fmt.dims, { signal: opts.signal });
    const dims = t.dims;
    if (base && base.dims !== dims) throw new Error('La base y el modelo usan dimensiones distintas');

    const nuevos = faltan.length
      ? await vectorizar(
          cliente,
          modelo,
          faltan.map((i) => fmt.documento(docs[i]!.texto)),
          dims,
          {
            signal: opts.signal,
            lote: opts.lote,
            alAvanzar: (hechos) => opts.alProgreso?.(docs.length - faltan.length + hechos, docs.length),
          },
        )
      : { matriz: new Float32Array(0), dims };

    const matriz = new Float32Array(docs.length * dims);
    const posNuevo = new Map<number, number>();
    faltan.forEach((i, k) => posNuevo.set(i, k));
    docs.forEach((_, i) => {
      const k = posNuevo.get(i);
      if (k !== undefined) {
        matriz.set(nuevos.matriz.subarray(k * dims, (k + 1) * dims), i * dims);
      } else {
        const j = posBase.get(huellas[i]!)!;
        matriz.set(base!.matriz.subarray(j * dims, (j + 1) * dims), i * dims);
      }
    });
    opts.alProgreso?.(docs.length, docs.length);
    return new IndiceSemantico(modelo, digest, huella, dims, docs.map((d) => d.clave), huellas, matriz, {
      textos: [...TESTIGOS],
      matriz: t.matriz,
    });
  }

  private centroidesCache: Map<string, Float32Array> | null = null;

  /**
   * Centroide (promedio normalizado) de los vectores de cada clave: representa
   * a la ficha entera y no a una sola frase. Se calcula una vez por índice.
   */
  centroides(): Map<string, Float32Array> {
    if (this.centroidesCache) return this.centroidesCache;
    const sumas = new Map<string, Float32Array>();
    for (let d = 0; d < this.claves.length; d++) {
      const k = this.claves[d]!;
      let acc = sumas.get(k);
      if (!acc) sumas.set(k, (acc = new Float32Array(this.dims)));
      const base = d * this.dims;
      for (let i = 0; i < this.dims; i++) acc[i]! += this.matriz[base + i]!;
    }
    for (const acc of sumas.values()) {
      let n = 0;
      for (let i = 0; i < acc.length; i++) n += acc[i]! * acc[i]!;
      n = Math.sqrt(n) || 1;
      for (let i = 0; i < acc.length; i++) acc[i] = acc[i]! / n;
    }
    this.centroidesCache = sumas;
    return sumas;
  }

  /** Vector normalizado del documento i (para reportes; no copiar en caliente). */
  vectorDe(i: number): Float32Array {
    return this.matriz.subarray(i * this.dims, (i + 1) * this.dims);
  }

  /** Cuántos documentos habría que calcular si se reutiliza este índice. */
  faltantes(docs: DocSemantico[]): number {
    const tengo = new Set(this.huellasDocs);
    return docs.filter((d) => !tengo.has(huellaDoc(d))).length;
  }

  /**
   * ¿El modelo instalado da los mismos vectores que el que armó este índice?
   * (Por ejemplo, si Ollama actualizó el modelo, la base ya no sirve.)
   */
  async esCompatible(cliente: OllamaClient, signal?: AbortSignal): Promise<boolean> {
    const fmt = formatoPara(this.modelo);
    const { matriz, dims } = await vectorizar(cliente, this.modelo, this.testigos.textos.map(fmt.documento), this.dims, { signal });
    if (dims !== this.dims) return false;
    for (let i = 0; i < this.testigos.textos.length; i++) {
      let s = 0;
      for (let k = 0; k < dims; k++) s += matriz[i * dims + k]! * this.testigos.matriz[i * dims + k]!;
      if (s < 0.98) return false;
    }
    return true;
  }

  /** Vector de la pregunta del usuario (con el formato y el recorte que espera el modelo). */
  async vectorPregunta(cliente: OllamaClient, pregunta: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Float32Array> {
    const fmt = formatoPara(this.modelo);
    const [v] = await cliente.embed(this.modelo, [fmt.pregunta(pregunta)], { signal, timeoutMs, keepAlive: '4h' });
    if (!v || v.length < this.dims) throw new Error('El modelo devolvió un vector más corto que el índice');
    const out = new Float32Array(this.dims);
    normalizarEn(v, this.dims, out, 0);
    return out;
  }

  /** Los `topK` documentos más parecidos (similitud coseno, de 1 a -1). */
  buscar(pregunta: Float32Array, topK = 20): Coincidencia[] {
    if (pregunta.length !== this.dims) throw new Error('La pregunta y el índice usan modelos distintos');
    const res: Coincidencia[] = [];
    let peor = -Infinity;
    for (let d = 0; d < this.claves.length; d++) {
      let s = 0;
      const base = d * this.dims;
      for (let k = 0; k < this.dims; k++) s += pregunta[k]! * this.matriz[base + k]!;
      if (res.length < topK) {
        res.push({ clave: this.claves[d]!, score: s });
        if (res.length === topK) {
          res.sort((a, b) => b.score - a.score);
          peor = res[res.length - 1]!.score;
        }
      } else if (s > peor) {
        res[res.length - 1] = { clave: this.claves[d]!, score: s };
        res.sort((a, b) => b.score - a.score);
        peor = res[res.length - 1]!.score;
      }
    }
    return res.sort((a, b) => b.score - a.score);
  }

  guardar(ruta: string): void {
    const datos: IndiceEnDisco = {
      v: 2,
      modelo: this.modelo,
      digest: this.digest,
      huella: this.huella,
      dims: this.dims,
      claves: this.claves,
      huellasDocs: this.huellasDocs,
      vectores: aBytes(this.matriz),
      testigos: { textos: this.testigos.textos, vectores: aBytes(this.testigos.matriz) },
    };
    mkdirSync(dirname(ruta), { recursive: true });
    // Escritura atómica: un corte de luz a mitad no deja un índice roto.
    const tmp = `${ruta}.tmp`;
    writeFileSync(tmp, JSON.stringify(datos));
    renameSync(tmp, ruta);
  }

  /** Carga un índice guardado (o null si no existe, está roto o es de otro formato). */
  static cargar(ruta: string): IndiceSemantico | null {
    try {
      const d = JSON.parse(readFileSync(ruta, 'utf8')) as IndiceEnDisco;
      if (d.v !== 2 || !d.dims || !Array.isArray(d.claves) || d.claves.length !== d.huellasDocs?.length) return null;
      const matriz = deBytes(d.vectores, d.dims);
      if (matriz.length !== d.claves.length * d.dims) return null;
      const testigos = { textos: d.testigos?.textos ?? [], matriz: deBytes(d.testigos?.vectores ?? '', d.dims) };
      if (testigos.matriz.length !== testigos.textos.length * d.dims) return null;
      return new IndiceSemantico(d.modelo, d.digest, d.huella, d.dims, d.claves, d.huellasDocs, matriz, testigos);
    } catch {
      return null;
    }
  }
}
