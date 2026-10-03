/**
 * Lector de hojas de factura: le pasa la foto a un modelo local de lectura de
 * documentos (Ollama, `glm-ocr`) y devuelve el texto de la tabla.
 *
 * Reglas:
 *  - De a UNA hoja por vez y con `keep_alive: '2m'`: el modelo se descarga de
 *    la memoria solo apenas termina la factura (hay PC con 8 GB).
 *  - Siempre en streaming: estos modelos a veces entran en un bucle y repiten
 *    el último renglón hasta que Ollama corta ("token repeat limit"). Lo leído
 *    hasta ahí sirve, así que se conserva lo acumulado y se recorta la cola
 *    repetida (`cortarRepeticion`).
 *  - No interpreta nada: del texto a los renglones se encarga `parser.ts`.
 */
import { OllamaError, type OllamaClient } from '../assistant/ia/ollama';

export const MODELO_LECTOR_POR_DEFECTO = 'glm-ocr:q8_0';
const PEDIDO = 'Table Recognition:';
const TIEMPO_MAXIMO_MS = 10 * 60_000;

export interface OpcionesLector {
  cliente: OllamaClient;
  modelo?: string;
  /** Tiempo máximo por hoja (default 10 minutos: sin GPU una hoja tarda ~2). */
  timeoutMs?: number;
}

export class LectorFacturas {
  private readonly cliente: OllamaClient;
  private readonly modelo: string;
  private readonly timeoutMs: number;

  constructor(opts: OpcionesLector) {
    this.cliente = opts.cliente;
    this.modelo = opts.modelo ?? MODELO_LECTOR_POR_DEFECTO;
    this.timeoutMs = opts.timeoutMs ?? TIEMPO_MAXIMO_MS;
  }

  /**
   * Texto leído de una hoja. Lanza `OllamaError` si Ollama no está, falta el
   * modelo o no llegó a leer nada; si se cortó a mitad de camino devuelve lo
   * que había leído.
   */
  async leerHoja(jpeg: Buffer, opts: { signal?: AbortSignal } = {}): Promise<string> {
    let acumulado = '';
    try {
      await this.cliente.chat(
        this.modelo,
        [{ role: 'user', content: PEDIDO, images: [jpeg.toString('base64')] }],
        {
          opciones: { temperature: 0, num_ctx: 8192, num_predict: 6000 },
          keepAlive: '2m',
          timeoutMs: this.timeoutMs,
          signal: opts.signal,
          alToken: (pedazo) => {
            acumulado += pedazo;
          },
        },
      );
    } catch (e) {
      // La canceló quien llamó (factura descartada, la app se cierra): no hay
      // nada que conservar.
      if (opts.signal?.aborted) throw e;
      // Sin Ollama o sin modelo no hay lectura posible.
      if (e instanceof OllamaError && (e.tipo === 'no-disponible' || e.tipo === 'modelo-faltante')) throw e;
      // Cortó a mitad de camino (límite de repetición, conexión, tiempo): lo
      // leído hasta ahí sirve. Si no había leído nada, es un error.
      if (!acumulado.trim()) throw e;
    }
    return cortarRepeticion(acumulado);
  }
}

/** Un renglón de factura nunca es tan corto: por debajo de esto no se considera bucle. */
const LARGO_MINIMO_REPETIDO = 20;

/**
 * Saca la cola repetida que deja el modelo cuando entra en bucle.
 *
 *  - Por líneas: si un bloque de 1 a 6 líneas (de 20 caracteres o más en
 *    total) aparece TRES veces seguidas, se conserva la primera y se corta el
 *    resto del texto. Dos renglones iguales seguidos pueden ser legítimos (dos
 *    promociones idénticas); tres, no.
 *  - Dentro de una línea (las tablas HTML llegan sin saltos): si el texto
 *    termina con el mismo tramo repetido cuatro veces o más, queda una sola.
 */
export function cortarRepeticion(texto: string): string {
  if (!texto) return '';
  const lineas = texto.split('\n');
  const igual = (a: number, b: number, k: number): boolean => {
    for (let j = 0; j < k; j++) {
      if ((lineas[a + j] ?? '').trim() !== (lineas[b + j] ?? '').trim()) return false;
    }
    return true;
  };
  let corte = -1;
  buscar: for (let i = 0; i < lineas.length; i++) {
    for (let k = 1; k <= 6 && i + 3 * k <= lineas.length; k++) {
      let largo = 0;
      for (let j = 0; j < k; j++) largo += (lineas[i + j] ?? '').trim().length;
      if (largo < LARGO_MINIMO_REPETIDO) continue;
      if (igual(i, i + k, k) && igual(i, i + 2 * k, k)) {
        corte = i + k;
        break buscar;
      }
    }
  }
  const sinBloques = corte >= 0 ? lineas.slice(0, corte).join('\n') : texto;
  return cortarColaRepetida(sinBloques);
}

/** El final del texto es un mismo tramo repetido 4+ veces → se deja una sola. */
function cortarColaRepetida(texto: string): string {
  const t = texto.replace(/\s+$/, '');
  const n = t.length;
  for (let p = LARGO_MINIMO_REPETIDO; p <= 400 && p * 4 <= n; p++) {
    const tramo = t.slice(n - p);
    let veces = 1;
    while (n - (veces + 1) * p >= 0 && t.slice(n - (veces + 1) * p, n - veces * p) === tramo) veces++;
    if (veces >= 4) {
      // Puede quedar un resto parcial del tramo antes de la primera vuelta
      // completa; no molesta al parser (es un renglón más, igual al anterior).
      return t.slice(0, n - (veces - 1) * p);
    }
  }
  // El corte de Ollama suele caer a mitad del tramo: se prueba también
  // ignorando una cola parcial de hasta un tramo.
  for (let p = LARGO_MINIMO_REPETIDO; p <= 400 && p * 5 <= n; p++) {
    for (let resto = 1; resto < p; resto++) {
      const fin = n - resto;
      const tramo = t.slice(fin - p, fin);
      if (!tramo.startsWith(t.slice(fin))) continue;
      let veces = 1;
      while (fin - (veces + 1) * p >= 0 && t.slice(fin - (veces + 1) * p, fin - veces * p) === tramo) veces++;
      if (veces >= 4) return t.slice(0, fin - (veces - 1) * p);
    }
  }
  return texto;
}
