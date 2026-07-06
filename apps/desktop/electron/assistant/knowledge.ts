/**
 * Base de conocimiento del Asistente virtual.
 *
 * Toma el manual de usuario versionado (`manual-src/sections.json`) y lo aplana a
 * texto plano para pasarlo como contexto (cacheado) al modelo. esbuild inlinea el
 * JSON dentro del bundle del main process, así no dependemos de rutas en runtime
 * ni de copiar archivos al `.asar`.
 *
 * El manual es la ÚNICA fuente de verdad del asistente: si algo no está acá, el
 * asistente no lo sabe y deriva a soporte humano.
 */
import manualData from '../../manual-src/sections.json';

interface Subsection {
  heading?: string;
  paragraphs?: string[];
  steps?: string[];
  tips?: string[];
}
interface Section {
  id?: string;
  title?: string;
  overview?: string;
  subsections?: Subsection[];
}

let cached: string | null = null;

/** Devuelve el manual completo como texto plano (memoizado). */
export function getManualKnowledge(): string {
  if (cached !== null) return cached;

  const sections = (manualData as { sections?: Section[] }).sections ?? [];
  const parts: string[] = [];

  for (const s of sections) {
    parts.push(`## ${s.title ?? s.id ?? 'Sección'}`);
    if (s.overview) parts.push(s.overview);

    for (const sub of s.subsections ?? []) {
      if (sub.heading) parts.push(`### ${sub.heading}`);
      for (const p of sub.paragraphs ?? []) parts.push(p);
      if (sub.steps?.length) {
        parts.push('Pasos:');
        sub.steps.forEach((step, i) => parts.push(`${i + 1}. ${step}`));
      }
      for (const tip of sub.tips ?? []) parts.push(`Tip: ${tip}`);
    }
    parts.push('');
  }

  cached = parts.join('\n');
  return cached;
}
