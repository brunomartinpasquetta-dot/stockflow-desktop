#!/usr/bin/env node
/**
 * Validador de la base de conocimiento de Flowy. Corre en test (`test:kb`) y
 * como paso del build de electron: una KB rota NO llega a un release.
 *
 * ERRORES (exit 1):
 *   - intents.json / sections.json que no parsean o sin la forma esperada;
 *   - intent sin id/canonical/patterns/answer;
 *   - (área, id) duplicado dentro de la misma área;
 *   - `image` que no termina en .png o que no existe en src/assets/sofia-shots/.
 *
 * ADVERTENCIAS (no cortan, se listan):
 *   - ids repetidos entre áreas (el motor resuelve por índice, pero confunden);
 *   - patterns textualmente idénticos compartidos por varios intents (fuerzan
 *     desambiguaciones innecesarias);
 *   - canonicals duplicados.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warns = [];

function parse(path, label) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
  } catch (e) {
    errors.push(`${label} no parsea: ${e.message}`);
    return null;
  }
}

/* ── pageKeys válidos, parseados del registry real (sin lista que driftee) ── */
function registryPageKeys() {
  try {
    const src = readFileSync(join(ROOT, 'src/windows/registry.ts'), 'utf8');
    return new Set([...src.matchAll(/pageKey:\s*'([^']+)'/g)].map((m) => m[1]));
  } catch {
    errors.push('no pude leer src/windows/registry.ts para validar actions');
    return new Set();
  }
}
const PAGE_KEYS = registryPageKeys();

/* ── intents.json ── */
const kb = parse('electron/assistant/intents.json', 'intents.json');
let totalIntents = 0;
if (kb) {
  if (!Array.isArray(kb.areas)) {
    errors.push('intents.json: falta el array raíz `areas`');
  } else {
    let shots = new Set();
    try {
      shots = new Set(readdirSync(join(ROOT, 'src/assets/sofia-shots')));
    } catch {
      errors.push('no pude listar src/assets/sofia-shots/');
    }
    const globalIds = new Map(); // id -> [areas]
    const canonicals = new Map();
    const patternOwners = new Map(); // pattern -> [area/id]
    for (const area of kb.areas) {
      if (!area.area || !Array.isArray(area.intents)) {
        errors.push(`área inválida: ${JSON.stringify(area?.area)}`);
        continue;
      }
      const localIds = new Set();
      for (const it of area.intents) {
        totalIntents++;
        const ref = `${area.area}/${it?.id ?? '?'}`;
        if (!it?.id || !it?.canonical || !Array.isArray(it?.patterns) || !it.patterns.length || typeof it?.answer !== 'string' || !it.answer.trim()) {
          errors.push(`${ref}: faltan campos obligatorios (id/canonical/patterns/answer)`);
          continue;
        }
        if (localIds.has(it.id)) errors.push(`${ref}: id duplicado DENTRO del área`);
        localIds.add(it.id);
        globalIds.set(it.id, [...(globalIds.get(it.id) ?? []), area.area]);
        canonicals.set(it.canonical, (canonicals.get(it.canonical) ?? 0) + 1);
        for (const p of it.patterns) patternOwners.set(p, [...(patternOwners.get(p) ?? []), ref]);
        if (it.image != null) {
          if (!String(it.image).endsWith('.png')) errors.push(`${ref}: image "${it.image}" sin extensión .png`);
          else if (!shots.has(it.image)) errors.push(`${ref}: image "${it.image}" no existe en sofia-shots/`);
        }
        // Acción de navegación (E2): label no vacío + pantalla existente en el registry.
        if (it.action != null) {
          if (typeof it.action.label !== 'string' || !it.action.label.trim() || typeof it.action.screen !== 'string')
            errors.push(`${ref}: action inválida (se espera {label, screen})`);
          else if (PAGE_KEYS.size && !PAGE_KEYS.has(it.action.screen))
            errors.push(`${ref}: action.screen "${it.action.screen}" no existe en el registry de ventanas`);
        }
      }
    }
    const dupIds = [...globalIds.entries()].filter(([, areas]) => areas.length > 1);
    if (dupIds.length) warns.push(`${dupIds.length} ids repetidos entre áreas: ${dupIds.slice(0, 6).map(([id, a]) => `${id} (${a.join(',')})`).join('; ')}${dupIds.length > 6 ? '…' : ''}`);
    const dupCanon = [...canonicals.entries()].filter(([, n]) => n > 1);
    if (dupCanon.length) warns.push(`${dupCanon.length} canonicals duplicados: ${dupCanon.slice(0, 4).map(([c]) => c).join(' | ')}`);
    const dupPatterns = [...patternOwners.entries()].filter(([, owners]) => owners.length > 1);
    if (dupPatterns.length) warns.push(`${dupPatterns.length} patterns idénticos compartidos entre intents (fuerzan desambiguación)`);
  }
}

/* ── flows.json (diagnósticos guiados, E3) ── */
const flowsDoc = parse('electron/assistant/flows.json', 'flows.json');
let totalFlows = 0;
if (flowsDoc) {
  if (!Array.isArray(flowsDoc.flows)) {
    errors.push('flows.json: falta el array raíz `flows`');
  } else {
    for (const f of flowsDoc.flows) {
      totalFlows++;
      const fr = `flow:${f?.id ?? '?'}`;
      if (!f?.id || !f?.title || !Array.isArray(f?.triggers) || f.triggers.length < 3 || !f?.start || !f?.nodes) {
        errors.push(`${fr}: faltan campos (id/title/triggers≥3/start/nodes)`);
        continue;
      }
      const ids = Object.keys(f.nodes);
      if (!f.nodes[f.start]) errors.push(`${fr}: start "${f.start}" no existe en nodes`);
      const referenced = new Set([f.start]);
      for (const [nid, n] of Object.entries(f.nodes)) {
        const nr = `${fr}/${nid}`;
        if (n.kind === 'check') {
          for (const dest of [n.yes, n.no]) {
            if (!f.nodes[dest]) errors.push(`${nr}: rama "${dest}" no existe`);
            else referenced.add(dest);
          }
        } else if (n.kind === 'ask') {
          if (!n.text || !Array.isArray(n.options) || n.options.length < 2) errors.push(`${nr}: ask necesita text y ≥2 options`);
          for (const o of n.options ?? []) {
            if (!o.label || !f.nodes[o.next]) errors.push(`${nr}: opción "${o.label}" apunta a nodo inexistente "${o.next}"`);
            else referenced.add(o.next);
          }
        } else if (n.kind === 'solution') {
          if (!n.text) errors.push(`${nr}: solution sin text`);
          if (n.action != null && n.action !== null) {
            if (!n.action.label || !n.action.screen) errors.push(`${nr}: action inválida`);
            else if (PAGE_KEYS.size && !PAGE_KEYS.has(n.action.screen)) errors.push(`${nr}: action.screen "${n.action.screen}" no existe en el registry`);
          }
        } else if (n.kind === 'escalate') {
          if (!n.text) errors.push(`${nr}: escalate sin text`);
        } else {
          errors.push(`${nr}: kind desconocido "${n?.kind}"`);
        }
      }
      const orphans = ids.filter((i) => !referenced.has(i));
      if (orphans.length) warns.push(`${fr}: nodos inalcanzables: ${orphans.join(', ')}`);
    }
  }
}

/* ── sections.json (manual) ── */
const manual = parse('manual-src/sections.json', 'sections.json');
let totalSubs = 0;
if (manual) {
  if (!Array.isArray(manual.sections)) {
    errors.push('sections.json: falta el array raíz `sections`');
  } else {
    for (const s of manual.sections) {
      if (!s.id || !s.title) errors.push(`sección sin id/title: ${JSON.stringify(s.id ?? s.title)}`);
      for (const sub of s.subsections ?? []) {
        totalSubs++;
        if (!sub.heading) errors.push(`sección ${s.id}: subsección sin heading`);
      }
    }
  }
}

/* ── resultado ── */
for (const w of warns) console.log(`⚠️  ${w}`);
for (const e of errors) console.error(`❌ ${e}`);
console.log(`\nKB: ${totalIntents} intents · ${totalFlows} flujos · ${totalSubs} subsecciones de manual · ${errors.length} errores · ${warns.length} advertencias`);
process.exit(errors.length ? 1 : 0);
