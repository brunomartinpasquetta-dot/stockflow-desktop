/**
 * Registro LOCAL de las decisiones de Flowy (no sale de la PC).
 *
 * Anota cada respuesta (qué ficha eligió y con qué parecido) y, lo más
 * valioso, las CORRECCIONES: cuando el usuario toca otro botón de sugerencia
 * justo después de una respuesta, ese par "pregunta original → ficha que
 * eligió" es exactamente la frase que hay que agregar a la base. Hoy sólo se
 * anotaban los "no sé"; una respuesta equivocada pero segura no dejaba rastro.
 *
 * Archivo: <userData>/flowy-ia-decisiones.jsonl, con rotación a 512 KB (como
 * el registro de preguntas sin respuesta). Es la materia prima del futuro
 * envío anónimo (que borrará nombres, números y montos antes de enviar).
 */
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TOPE_BYTES = 512 * 1024;

export interface EventoRespuesta {
  t: 'respuesta';
  q: string;
  pantalla: string | null;
  via: 'ia' | 'motor' | 'charla';
  elegido: string | null;
  top?: { id: string; score: number }[];
}

export interface EventoCorreccion {
  t: 'correccion';
  preguntaOriginal: string;
  mostrado: string | null;
  elegido: string;
}

export class RegistroDecisiones {
  private readonly archivo: string;

  constructor(
    userDataDir: string,
    private readonly version: string,
  ) {
    this.archivo = join(userDataDir, 'flowy-ia-decisiones.jsonl');
  }

  anotar(evento: EventoRespuesta | EventoCorreccion): void {
    try {
      try {
        if (statSync(this.archivo).size > TOPE_BYTES) renameSync(this.archivo, `${this.archivo}.1`);
      } catch {
        /* todavía no existe */
      }
      appendFileSync(this.archivo, `${JSON.stringify({ ts: new Date().toISOString(), v: this.version, ...evento })}\n`);
    } catch {
      /* el registro nunca rompe una respuesta */
    }
  }
}

/** Lo último que Flowy le mostró a cada charla: para detectar el clic en "otro" botón. */
export class UltimaRespuestaPorCharla {
  private readonly mapa = new Map<string, { pregunta: string; mostrado: string | null; sugerencias: string[] }>();

  recordar(convId: string, pregunta: string, mostrado: string | null, sugerencias: string[]): void {
    this.mapa.set(convId, { pregunta, mostrado, sugerencias });
    if (this.mapa.size > 300) {
      const primera = this.mapa.keys().next().value;
      if (primera !== undefined) this.mapa.delete(primera);
    }
  }

  /** Si `pregunta` es uno de los botones ofrecidos en la respuesta anterior, devuelve esa respuesta. */
  esClicEnSugerencia(convId: string, pregunta: string): { pregunta: string; mostrado: string | null } | null {
    const previa = this.mapa.get(convId);
    if (!previa) return null;
    const limpia = pregunta.trim();
    return previa.sugerencias.some((s) => s.trim() === limpia) ? { pregunta: previa.pregunta, mostrado: previa.mostrado } : null;
  }
}
