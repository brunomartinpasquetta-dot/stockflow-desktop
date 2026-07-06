/**
 * Motor CONVERSACIONAL del chatbot interno de StockFlow ("Sofía") — 100% offline,
 * sin IA externa, sin clave, sin costo. Vive en el main process.
 *
 * A diferencia de un buscador de FAQ, mantiene una CONVERSACIÓN:
 *  - memoria de contexto por charla (última área/intent, pasos mostrados);
 *  - resuelve seguimientos cortos y referenciales ("¿y cómo lo cambio?", "¿y después?");
 *  - reexplica más simple, ayuda paso por paso, ofrece próximos temas;
 *  - desambigua ("¿te referís a X o a Y?") cuando hay empate;
 *  - tolera errores de tipeo (fuzzy) y sinónimos coloquiales;
 *  - charla humana (saludos, gracias, "¿sos un robot?", "no entendí").
 *
 * Fuentes: intents curados (intents.json, generados leyendo el manual Y el código
 * real de cada pantalla) + el manual completo como red de contención.
 */
import manualData from '../../manual-src/sections.json';
import intentsData from './intents.json';

/* ------------------------------- tipos ------------------------------- */

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
interface Intent {
  id: string;
  canonical: string;
  patterns: string[];
  answer: string;
  steps: string[];
}
interface Synonym {
  term: string;
  aliases: string[];
}
interface AreaKB {
  area: string;
  synonyms: Synonym[];
  intents: Intent[];
}

export interface AssistantAnswer {
  reply: string;
  suggestions: string[];
}

/* --------------------------- normalización --------------------------- */

const STOPWORDS = new Set(
  (
    'a al algo alguna algunas alguno algunos ante antes aca aqui asi como con contra cual cuales cuando de del desde donde dos el ella ellas ellos en entre era eran es esa esas ese eso esos esta estan estas este esto estos estoy fue fui ha hace hacer hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos o os para pero poco por porque que quien quienes se ser si sin sobre solo son soy su sus tan te tener tengo ti tu tus un una uno unos unas y ya yo mio tuyo necesito quiero puedo podes hago haces hacen tiene tienen usar usa uso porfa porfavor favor'
  ).split(/\s+/),
);

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(text: string): string[] {
  return stripAccents((text || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Tokens crudos (sin sacar stopwords) — para detectar frases de charla. */
function rawTokens(text: string): string[] {
  return stripAccents((text || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

const DERIV_SUFFIXES = [
  'aciones', 'uciones', 'amiento', 'imiento', 'acion', 'ucion',
  'arles', 'arlos', 'arlas', 'erles', 'irles',
  'arle', 'arlo', 'arla', 'arme', 'arte', 'arse',
  'erle', 'erlo', 'erla', 'erme', 'erte', 'erse',
  'irle', 'irlo', 'irla', 'irme', 'irte', 'irse',
  'ando', 'iendo', 'ados', 'idos', 'adas', 'idas',
  'ado', 'ada', 'ido', 'ida', 'ar', 'er', 'ir', 'o', 'a', 'e',
];

function stem(token: string): string {
  let t = token;
  if (t.length > 5 && t.endsWith('es')) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith('s')) t = t.slice(0, -1);
  for (const suf of DERIV_SUFFIXES) {
    if (!t.endsWith(suf)) continue;
    const root = t.slice(0, -suf.length);
    const minRoot = suf.length >= 3 ? 3 : 4;
    if (root.length >= minRoot) return root;
  }
  return t;
}

function phraseNorm(text: string): string {
  return tokenize(text).map(stem).join(' ');
}

/** Distancia de Levenshtein acotada (para corrección de typos). */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/* --------------------- léxico base de sinónimos --------------------- */
const BASE_SYNONYMS: Synonym[] = [
  { term: 'articulo', aliases: ['producto', 'item', 'mercaderia', 'productos', 'articulos'] },
  { term: 'recibo', aliases: ['comprobante', 'ticket', 'tirilla', 'factura'] },
  { term: 'venta', aliases: ['vender', 'cobrar', 'facturar', 'pdv', 'cobro'] },
  { term: 'cliente', aliases: ['comprador'] },
  { term: 'proveedor', aliases: ['distribuidor'] },
  { term: 'caja', aliases: ['arqueo'] },
  { term: 'stock', aliases: ['inventario', 'existencia'] },
  { term: 'precio', aliases: ['valor', 'costo'] },
  { term: 'usuario', aliases: ['empleado', 'vendedor', 'cajero'] },
  { term: 'configuracion', aliases: ['configurar', 'ajustes', 'setear'] },
  { term: 'imprimir', aliases: ['impresora', 'impresion', 'imprime'] },
  { term: 'presupuesto', aliases: ['cotizacion'] },
  { term: 'cuenta', aliases: ['ctacte', 'corriente', 'fiado', 'deuda', 'saldo'] },
];

/* ------------------- detección de charla (meta) --------------------- */

const has = (toks: string[], set: Set<string>): boolean => toks.some((t) => set.has(t));
const phraseHas = (norm: string, arr: string[]): boolean => arr.some((p) => norm.includes(p));

const GREETING = new Set(['hola', 'holaa', 'buenas', 'buen', 'buenos', 'ola', 'hey', 'holis', 'buenass']);
const THANKS_PH = ['gracias', 'muchas gracias', 'genial', 'perfecto', 'buenisimo', 'de diez', 'copado', 'joya', 'barbaro'];
const BYE_PH = ['chau', 'adios', 'nada mas', 'listo gracias', 'eso era todo', 'ya esta gracias'];
const REEXPLAIN_PH = [
  'no entend', 'no entiend', 'no me qued', 'mas simple', 'mas facil', 'mas basic', 'mas sencill',
  'explicame mejor', 'explica de nuevo', 'de nuevo', 'otra vez', 'no cazo', 'no capto', 'mas despacio',
  'no se de computadora', 'no soy experto', 'no se nada de', 'no se entiende', 'explicalo bien',
];
const NEXT_PH = ['y despues', 'y ahora', 'que sigue', 'siguiente', 'y luego', 'continua', 'segui', 'y eso', 'proximo paso'];
const AFFIRM = new Set(['si', 'sii', 'dale', 'ok', 'oka', 'okey', 'obvio', 'correcto', 'exacto', 'claro', 'sisi', 'buenisimo']);
const DENY_PH = ['no era eso', 'nada que ver', 'no es eso', 'no, ', 'tampoco'];
const HUMAN_PH = ['hablar con una persona', 'con un humano', 'llamar al tecnico', 'un tecnico', 'una persona real', 'atencion humana', 'hablar con alguien'];
const WHOAREYOU_PH = ['sos un robot', 'sos un bot', 'quien sos', 'que sos', 'con quien hablo', 'sos una maquina', 'sos real', 'sos humana'];
const WHATCANDO_PH = ['que sabes hacer', 'que podes hacer', 'en que me ayudas', 'para que servis', 'que haces', 'ayuda', 'que puedo preguntar'];
const FRUSTRATION_PH = ['no funciona nada', 'estoy perdido', 'no se que hacer', 'no me sale nada', 'socorro', 'auxilio', 'todo mal'];
const OFFTOPIC_PH = ['que hora es', 'como estas', 'contame un chiste', 'que dia es', 'como te llamas tu vida'];
const ORDINAL_FIRST = ['el primero', 'la primera', 'primero', 'primera', ' 1', 'uno', 'el uno', 'opcion 1', 'la de arriba'];
const ORDINAL_SECOND = ['el segundo', 'la segunda', 'segundo', 'segunda', ' 2', 'dos', 'el dos', 'opcion 2', 'la otra', 'la de abajo'];
const REFERENTIAL = new Set([
  'cambiar', 'cambiarlo', 'cambiarla', 'modificar', 'modificarlo', 'editar', 'editarlo', 'sacar', 'sacarlo',
  'borrar', 'borrarlo', 'ahi', 'eso', 'esa', 'ese', 'lo', 'la', 'ahi', 'donde', 'como', 'y', 'despues',
]);

/* ------------------------------ índice ------------------------------ */

interface IntentDoc {
  kind: 'intent';
  area: string;
  id: string;
  canonical: string;
  answer: string;
  steps: string[];
  patternTokens: Set<string>;
  canonicalTokens: Set<string>;
  answerTokens: Set<string>;
  patternNorms: string[];
  allTokens: string[];
  relatedIdx: number[];
}
interface ManualDoc {
  kind: 'manual';
  title: string;
  heading: string;
  body: string;
  headingNorm: string;
  headingTokens: Set<string>;
  bodyTokens: Set<string>;
  allTokens: string[];
}

interface Index {
  intents: IntentDoc[];
  manual: ManualDoc[];
  idf: Map<string, number>;
  aliasToTerm: Map<string, string>;
  vocab: string[];
  metaById: Map<string, IntentDoc>;
  topSuggestions: string[];
}

let INDEX: Index | null = null;

function buildAliasMap(areaSyn: Synonym[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { term, aliases } of [...BASE_SYNONYMS, ...areaSyn]) {
    const t = tokenize(term)[0];
    if (!t) continue;
    const canon = stem(t);
    map.set(t, canon);
    map.set(canon, canon);
    for (const a of aliases ?? []) {
      const at = tokenize(a)[0];
      if (!at) continue;
      map.set(at, canon);
      map.set(stem(at), canon);
    }
  }
  return map;
}

function expand(tokens: string[], aliasToTerm: Map<string, string>): string[] {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    const st = stem(t);
    out.add(st);
    const canon = aliasToTerm.get(t) ?? aliasToTerm.get(st);
    if (canon) out.add(canon);
  }
  return [...out];
}

function buildIndex(): Index {
  const sections = (manualData as { sections?: Section[] }).sections ?? [];
  const kb = (intentsData as { areas?: AreaKB[] }).areas ?? [];
  const aliasToTerm = buildAliasMap(kb.flatMap((a) => a.synonyms ?? []));

  const intents: IntentDoc[] = [];
  const metaById = new Map<string, IntentDoc>();
  for (const area of kb) {
    for (const it of area.intents ?? []) {
      const patternTokens = new Set(expand(tokenize(it.patterns.join(' ')), aliasToTerm));
      const canonicalTokens = new Set(expand(tokenize(it.canonical), aliasToTerm));
      const answerTokens = new Set(expand(tokenize(it.answer), aliasToTerm));
      const doc: IntentDoc = {
        kind: 'intent',
        area: area.area,
        id: it.id,
        canonical: it.canonical,
        answer: it.answer,
        steps: it.steps ?? [],
        patternTokens,
        canonicalTokens,
        answerTokens,
        patternNorms: [it.canonical, ...it.patterns].map(phraseNorm),
        allTokens: [...new Set([...patternTokens, ...canonicalTokens, ...answerTokens])],
        relatedIdx: [],
      };
      if (area.area === 'meta') metaById.set(it.id, doc);
      intents.push(doc);
    }
  }

  // Relacionados: por área, top solapamiento de tokens canónicos.
  intents.forEach((d, i) => {
    if (d.area === 'meta') return;
    const scored = intents
      .map((o, j) => ({ j, s: j === i || o.area !== d.area ? -1 : overlap(d.canonicalTokens, o.canonicalTokens) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    d.relatedIdx = scored.map((x) => x.j);
  });

  const manual: ManualDoc[] = [];
  for (const s of sections) {
    for (const sub of s.subsections ?? []) {
      const body = [...(sub.paragraphs ?? []), ...(sub.steps ?? []), ...(sub.tips ?? [])].join('\n');
      const heading = sub.heading ?? s.title ?? '';
      const headingTokens = new Set(expand(tokenize(`${s.title ?? ''} ${heading}`), aliasToTerm));
      const bodyTokens = new Set(expand(tokenize(body), aliasToTerm));
      manual.push({
        kind: 'manual',
        title: s.title ?? '',
        heading,
        body,
        headingNorm: phraseNorm(`${s.title ?? ''} ${heading}`),
        headingTokens,
        bodyTokens,
        allTokens: [...new Set([...headingTokens, ...bodyTokens])],
      });
    }
  }

  // IDF + vocab.
  const df = new Map<string, number>();
  const docs = [...intents.map((d) => d.allTokens), ...manual.map((d) => d.allTokens)];
  for (const toks of docs) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length || 1;
  const idf = new Map<string, number>();
  for (const [t, c] of df) idf.set(t, Math.log(1 + N / (1 + c)));
  const vocab = [...new Set(intents.filter((d) => d.area !== 'meta').flatMap((d) => [...d.patternTokens, ...d.canonicalTokens]))].filter((t) => t.length >= 3);

  const realIntents = intents.filter((d) => d.area !== 'meta');
  const topSuggestions = realIntents.length
    ? dedupe(kb.filter((a) => a.area !== 'meta').flatMap((a) => (a.intents ?? []).slice(0, 1).map((i) => i.canonical))).slice(0, 6)
    : ['¿Cómo hago una venta?', '¿Cómo cargo un artículo?', '¿Cómo abro la caja?'];

  return { intents, manual, idf, aliasToTerm, vocab, metaById, topSuggestions };
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
function getIndex(): Index {
  if (!INDEX) INDEX = buildIndex();
  return INDEX;
}

/* ------------------------- corrección de typos ------------------------ */

const fuzzyCache = new Map<string, string>();
function correctTokens(tokens: string[], idx: Index): string[] {
  const vocabSet = new Set(idx.vocab);
  return tokens.map((t) => {
    if (t.length < 4 || vocabSet.has(t) || vocabSet.has(stem(t))) return t;
    if (fuzzyCache.has(t)) return fuzzyCache.get(t)!;
    const max = t.length >= 6 ? 2 : 1;
    let best = t;
    let bestD = max + 1;
    for (const v of idx.vocab) {
      if (Math.abs(v.length - t.length) > max) continue;
      const d = editDistance(t, v, max);
      if (d < bestD) {
        bestD = d;
        best = v;
        if (d === 0) break;
      }
    }
    fuzzyCache.set(t, best);
    return best;
  });
}

/* ------------------------------ scoring ------------------------------ */

function idfOf(idx: Index, t: string): number {
  return idx.idf.get(t) ?? Math.log(1 + idx.intents.length + idx.manual.length);
}

function scoreIntent(idx: Index, qTokens: string[], qNorm: string, d: IntentDoc, ctxArea: string | null): number {
  let score = 0;
  let matchedCanon = 0;
  for (const t of qTokens) {
    const w = idfOf(idx, t);
    if (d.canonicalTokens.has(t)) matchedCanon++;
    if (d.patternTokens.has(t)) score += w * 3;
    else if (d.canonicalTokens.has(t)) score += w * 2.2;
    else if (d.answerTokens.has(t)) score += w * 1;
  }
  if (matchedCanon >= 2 && d.canonicalTokens.size > 0) score += 14 * (matchedCanon / d.canonicalTokens.size);
  let phraseBoost = 0;
  for (const pn of d.patternNorms) {
    if (!pn) continue;
    if (pn === qNorm) {
      phraseBoost = 120;
      break;
    }
    if (pn.length >= 4 && qNorm.length >= 4) {
      const contained =
        (qNorm.includes(pn) && pn.length >= qNorm.length * 0.6) || (pn.includes(qNorm) && qNorm.length >= pn.length * 0.6);
      if (contained) phraseBoost = Math.max(phraseBoost, 25);
    }
  }
  score += phraseBoost;
  // Bonus de contexto: seguir en el área de la que venimos hablando.
  if (ctxArea && d.area === ctxArea) score += 4;
  return score / Math.sqrt(qTokens.length || 1);
}

function scoreManual(idx: Index, qTokens: string[], qNorm: string, d: ManualDoc): number {
  let score = 0;
  for (const t of qTokens) {
    const w = idfOf(idx, t);
    if (d.headingTokens.has(t)) score += w * 2.5;
    else if (d.bodyTokens.has(t)) score += w * 1;
  }
  if (d.headingNorm && qNorm && d.headingNorm.includes(qNorm) && qNorm.length >= 4) score += 15;
  return score / Math.sqrt(qTokens.length || 1);
}

/* ------------------------- estado de charla -------------------------- */

interface Convo {
  lastArea: string | null;
  lastIntentIdx: number | null;
  lastSteps: string[];
  offeredIdx: number[]; // relacionados ofrecidos ("¿querés ver X?")
  clarify: string[]; // dos ids en desambiguación
  turn: number;
}
const SESSIONS = new Map<string, Convo>();
function convo(id: string): Convo {
  let c = SESSIONS.get(id);
  if (!c) {
    c = { lastArea: null, lastIntentIdx: null, lastSteps: [], offeredIdx: [], clarify: [], turn: 0 };
    SESSIONS.set(id, c);
  }
  // Poda simple para no crecer sin límite.
  if (SESSIONS.size > 200) {
    const first = SESSIONS.keys().next().value;
    if (first && first !== id) SESSIONS.delete(first);
  }
  return c;
}

/* ------------------------------ render ------------------------------ */

const LEAD_INS = ['Dale, ', 'Mirá, ', 'Buenísimo. ', 'Tranqui, ', 'Genial. ', ''];
function leadIn(turn: number): string {
  return LEAD_INS[turn % LEAD_INS.length]!;
}

function renderIntent(idx: Index, d: IntentDoc, c: Convo): string {
  let out = d.answer.trim();
  if (d.steps.length) out += '\n\n' + d.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  // Ofrecer un tema relacionado, como charla.
  c.offeredIdx = d.relatedIdx.slice(0, 2);
  if (c.offeredIdx.length) {
    const names = c.offeredIdx.map((j) => `«${idx.intents[j]!.canonical.replace(/^¿|\?$/g, '')}»`);
    out += `\n\n¿Querés que también te muestre ${names.join(' o ')}? Decime "sí" y seguimos.`;
  }
  return out;
}

function suggestionsFor(idx: Index, d: IntentDoc): string[] {
  return dedupe(d.relatedIdx.map((j) => idx.intents[j]!.canonical)).slice(0, 3);
}

function metaReply(idx: Index, id: string, fallback: string): { reply: string; suggestions: string[] } {
  const m = idx.metaById.get(id);
  return { reply: m ? m.answer : fallback, suggestions: idx.topSuggestions };
}

/* ------------------------------ API ------------------------------ */

const INTENT_THRESHOLD = 6;
const MANUAL_THRESHOLD = 5;

/** Responde manteniendo el hilo de la charla `convId`. */
export function answerQuestion(question: string, convId = 'default'): AssistantAnswer {
  const idx = getIndex();
  const c = convo(convId);
  c.turn++;

  const raw = rawTokens(question);
  const norm = phraseNorm(question);
  const content = tokenize(question);
  // Texto plano (sin acentos, sin stemming) para detectar frases de charla.
  const low = ' ' + stripAccents(question.toLowerCase()).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

  // ── 0) Saludo / vacío ──
  if (content.length === 0 || (raw.length <= 2 && has(raw, GREETING))) {
    if (raw.length && has(raw, GREETING)) c.lastArea = null;
    return metaReply(idx, 'saludo', '¡Hola! Soy Sofía 👋 Te ayudo a usar StockFlow. Contame qué necesitás o elegí un tema.');
  }

  // ── 1) Desambiguación pendiente ──
  if (c.clarify.length === 2) {
    const opts = c.clarify;
    c.clarify = [];
    if (phraseHas(low, ORDINAL_SECOND)) return answerIntent(idx, opts[1]!, c);
    if (has(raw, AFFIRM) || phraseHas(low, ORDINAL_FIRST)) return answerIntent(idx, opts[0]!, c);
    // Si no eligió, seguimos con el flujo normal (quizá reformuló).
  }

  // ── 2) Charla / meta ──
  if (phraseHas(low, THANKS_PH) && content.length <= 3) return metaReply(idx, 'agradecimiento', '¡De nada! Si te surge otra duda, acá estoy 😊');
  if (phraseHas(low, BYE_PH)) return metaReply(idx, 'despedida', '¡Listo! Cualquier cosa me abrís de nuevo. Éxitos con el negocio 💪');
  if (phraseHas(low, WHOAREYOU_PH)) return metaReply(idx, 'quien-sos', 'Soy Sofía, la asistente de StockFlow 🤖 Te enseño a usar cada parte del sistema, paso a paso.');
  if (phraseHas(low, WHATCANDO_PH)) return metaReply(idx, 'que-podes-hacer', 'Te ayudo con todo el sistema: ventas, caja, artículos, clientes, precios, presupuestos y más. Preguntame lo que quieras.');
  if (phraseHas(low, HUMAN_PH)) return metaReply(idx, 'pedir-humano', 'Puedo ayudarte con casi todo del uso del sistema. Si es algo que no logro resolver, anotá la duda y consultala con quien te instaló StockFlow.');
  if (phraseHas(low, FRUSTRATION_PH)) return metaReply(idx, 'frustracion', '¡Tranqui, respirá que lo resolvemos juntos! Contame qué estabas haciendo y en qué momento se trabó, y lo vemos paso a paso.');
  if (phraseHas(low, OFFTOPIC_PH)) return metaReply(idx, 'charla-fuera-de-tema', '¡Jaja! De eso no sé, yo soy para ayudarte con StockFlow 😊 ¿Con qué parte del sistema te doy una mano?');

  // ── 3) Reexplicar / próximo paso (necesitan lo último) ──
  const last = c.lastIntentIdx != null ? idx.intents[c.lastIntentIdx] : null;
  if (phraseHas(low, NEXT_PH) && last) {
    if (c.lastSteps.length) {
      return {
        reply: `Ya te dejé todos los pasos arriba 👆. Si te trabaste en alguno, decime el número (por ejemplo "el paso 3") y te lo explico más despacio. Y si ya está, ¡terminaste! 🎉`,
        suggestions: suggestionsFor(idx, last),
      };
    }
  }
  if (phraseHas(low, REEXPLAIN_PH)) {
    if (last) {
      // ¿Pidió un paso puntual? ("el paso 3", "el 2")
      const num = question.match(/\b([1-9])\b/);
      if (num && c.lastSteps.length) {
        const i = Number(num[1]) - 1;
        if (i >= 0 && i < c.lastSteps.length)
          return { reply: `Paso ${i + 1}, bien despacio:\n\n${c.lastSteps[i]}\n\n¿Se entiende así o te lo digo de otra forma?`, suggestions: [] };
      }
      let out = `Dale, vamos tranqui con «${last.canonical.replace(/^¿|\?$/g, '')}»:\n\n${last.answer.trim()}`;
      if (c.lastSteps.length) out += '\n\n' + c.lastSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n\n¿En qué paso te trabaste? Decime el número y lo vemos.';
      return { reply: out, suggestions: suggestionsFor(idx, last) };
    }
    return metaReply(idx, 'no-entendi', 'Perdoná, no te entendí. ¿Lo podés decir con otras palabras? O decime de qué parte del sistema es la duda (ventas, caja, artículos…).');
  }

  // ── 4) "sí/dale" → tomar el tema relacionado ofrecido ──
  if (raw.length <= 2 && has(raw, AFFIRM) && c.offeredIdx.length) {
    return answerIntent(idx, idx.intents[c.offeredIdx[0]!]!.id, c);
  }

  // ── 5) Búsqueda de intent (con typos y contexto) ──
  const qTokens = expand(correctTokens(content, idx), idx.aliasToTerm);
  const qNorm = norm;
  const referential = raw.every((t) => REFERENTIAL.has(t) || STOPWORDS.has(t));
  const ctxArea = c.lastArea;

  const ranked = idx.intents
    .filter((d) => d.area !== 'meta')
    .map((d) => ({ d, s: scoreIntent(idx, qTokens, qNorm, d, ctxArea) }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0];
  const second = ranked[1];

  // Seguimiento referencial muy corto sin match fuerte → pedir precisión en contexto.
  if (referential && best && best.s < INTENT_THRESHOLD * 1.5 && last) {
    return {
      reply: `Se me perdió un poco el hilo 😅 ¿Sobre «${last.canonical.replace(/^¿|\?$/g, '')}» querés otra cosa, o es de otro tema? Decímelo completo y te ayudo.`,
      suggestions: suggestionsFor(idx, last),
    };
  }

  if (best && best.s >= INTENT_THRESHOLD) {
    // ¿Es un match CONFIADO? (frase exacta, score alto, o clara ventaja sobre el 2º)
    const exact = best.d.patternNorms.includes(qNorm);
    const gap = second ? best.s - second.s : 999;
    const confident = exact || best.s >= 45 || gap >= 12 || !second;
    // Solo desambiguar en la "zona gris": nada confiado y el 2º pisa los talones.
    if (!confident && second && second.s >= INTENT_THRESHOLD && second.s >= best.s * 0.85 && second.d.id !== best.d.id) {
      c.clarify = [best.d.id, second.d.id];
      c.lastArea = best.d.area;
      c.lastIntentIdx = null;
      return {
        reply: `Para no mandarte cualquiera: ¿te referís a **${best.d.canonical}** o a **${second.d.canonical}**? Decime "el primero" o "el segundo".`,
        suggestions: [best.d.canonical, second.d.canonical],
      };
    }
    return answerIntent(idx, best.d.id, c);
  }

  // ── 6) Red de contención: manual ──
  const bestManual = idx.manual.map((d) => ({ d, s: scoreManual(idx, qTokens, qNorm, d) })).sort((a, b) => b.s - a.s)[0];
  const sugg = dedupe(ranked.slice(0, 3).map((r) => r.d.canonical)).filter(Boolean);
  if (bestManual && bestManual.s >= MANUAL_THRESHOLD) {
    const body = bestManual.d.body.length > 650 ? bestManual.d.body.slice(0, 650).trimEnd() + '…' : bestManual.d.body;
    return { reply: `${leadIn(c.turn)}sobre «${bestManual.d.heading}», el manual dice:\n\n${body}`, suggestions: sugg.length ? sugg : idx.topSuggestions };
  }

  // ── 7) No sé (honesto) + sugerencias ──
  return {
    reply: 'Uy, eso no lo tengo claro y no quiero mandarte cualquiera. ¿Alguna de estas te sirve? Si no, escribímelo con otras palabras.',
    suggestions: sugg.length ? sugg : idx.topSuggestions,
  };
}

function answerIntent(idx: Index, id: string, c: Convo): AssistantAnswer {
  const j = idx.intents.findIndex((d) => d.id === id && d.area !== 'meta');
  const d = idx.intents[j];
  if (!d) return { reply: 'Perdón, no encontré eso. ¿Lo reformulás?', suggestions: idx.topSuggestions };
  c.lastArea = d.area;
  c.lastIntentIdx = j;
  c.lastSteps = d.steps;
  return { reply: renderIntent(idx, d, c), suggestions: suggestionsFor(idx, d) };
}

/* --------------------------- utilidades test --------------------------- */

/** Sólo para tests: id del intent que resolvería (o 'meta:*'/'clarify'/'manual'/'fallback'). */
export function resolveIntentId(question: string, convId = 'default'): string {
  const before = SESSIONS.get(convId);
  const idx = getIndex();
  const c = convo(convId);
  // Snapshot para no romper el estado real si se usa en assert.
  const ans = answerQuestion(question, convId);
  const cur = SESSIONS.get(convId);
  void before;
  if (cur?.clarify.length === 2) return 'clarify';
  if (cur?.lastIntentIdx != null && !ans.reply.startsWith('Uy,') && !ans.reply.startsWith('Se me perdió'))
    return idx.intents[cur.lastIntentIdx]!.id;
  if (ans.reply.startsWith('Uy, eso no')) return 'fallback';
  return 'meta-or-manual';
}

export function newConvId(): string {
  return 'test-' + Math.round(performance.now()) + '-' + INDEX!.intents.length;
}
