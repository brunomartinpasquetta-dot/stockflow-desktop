/**
 * FLUJOS GUIADOS DE DIAGNÓSTICO (E3) — árboles de decisión declarativos.
 *
 * Los flujos viven en flows.json (agregar uno = agregar datos, no código):
 *  - "check": pregunta que el sistema puede responder SOLO (¿hay impresora
 *    configurada?) — nunca se le pregunta al usuario lo que el main ya sabe;
 *  - "ask": pregunta al usuario con opciones-botón (viajan como suggestions,
 *    los chips del panel ya las muestran clickeables);
 *  - "solution": instrucción concreta que cierra el flujo (puede traer un
 *    botón de navegación);
 *  - "escalate": Flowy reconoce su límite y deriva a soporte con los datos
 *    ya relevados — sin inventar.
 *
 * El estado es por conversación (convId), separado del motor. Si el usuario
 * contesta cualquier cosa que no es una opción, el flujo se suelta en
 * silencio y la pregunta sigue su camino normal (motor de conocimiento).
 */
import { flowsData } from './kbLoader';

export interface FlowAction {
  label: string;
  screen: string;
}
interface FlowNodeCheck {
  kind: 'check';
  check: string;
  yes: string;
  no: string;
}
interface FlowNodeAsk {
  kind: 'ask';
  text: string;
  options: { label: string; next: string }[];
}
interface FlowNodeSolution {
  kind: 'solution';
  text: string;
  action?: FlowAction | null;
}
interface FlowNodeEscalate {
  kind: 'escalate';
  text: string;
}
type FlowNode = FlowNodeCheck | FlowNodeAsk | FlowNodeSolution | FlowNodeEscalate;

interface Flow {
  id: string;
  title: string;
  triggers: string[];
  start: string;
  nodes: Record<string, FlowNode>;
}

/** Checks automáticos que inyecta el handler (leen estado real del sistema). */
export type FlowChecks = Record<string, () => Promise<boolean>>;

export interface FlowReply {
  reply: string;
  suggestions: string[];
  actions: FlowAction[];
  /** true = el flujo terminó (solución o derivación). */
  done: boolean;
  kind: 'flow';
}

const FLOWS: Flow[] = ((flowsData as { flows?: Flow[] }).flows ?? []).filter(
  (f) => f && f.id && f.start && f.nodes,
);

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const EXIT_PH = ['salir', 'cancelar', 'dejalo', 'deja', 'olvidalo', 'no importa', 'despues sigo', 'chau'];

interface FlowState {
  flowId: string;
  nodeId: string;
}
const FLOW_SESSIONS = new Map<string, FlowState>();
function prune(): void {
  if (FLOW_SESSIONS.size > 200) {
    const first = FLOW_SESSIONS.keys().next().value;
    if (first) FLOW_SESSIONS.delete(first);
  }
}

/** ¿La pregunta dispara un flujo? Devuelve el id o null. Gana el trigger más largo. */
export function detectFlow(question: string): string | null {
  const n = norm(question);
  if (!n) return null;
  let best: { id: string; len: number } | null = null;
  for (const f of FLOWS) {
    for (const t of f.triggers ?? []) {
      const tn = norm(t);
      if (tn && n.includes(tn) && (!best || tn.length > best.len)) best = { id: f.id, len: tn.length };
    }
  }
  return best?.id ?? null;
}

function render(flow: Flow, node: Exclude<FlowNode, FlowNodeCheck>, convId: string): FlowReply {
  if (node.kind === 'ask') {
    return {
      reply: node.text + '\n\n(Tocá una opción o escribime la respuesta. Si querés dejarlo, decime "salir".)',
      suggestions: node.options.map((o) => o.label),
      actions: [],
      done: false,
      kind: 'flow',
    };
  }
  FLOW_SESSIONS.delete(convId); // solution / escalate cierran el flujo
  return {
    reply: node.text,
    suggestions: [],
    actions: node.kind === 'solution' && node.action ? [node.action] : [],
    done: true,
    kind: 'flow',
  };
}

/** Avanza por los nodos "check" (automáticos) hasta llegar a algo que mostrar. */
async function advance(flow: Flow, nodeId: string, convId: string, checks: FlowChecks): Promise<FlowReply> {
  let cur = flow.nodes[nodeId];
  let curId = nodeId;
  let hops = 0;
  while (cur && cur.kind === 'check' && hops < 10) {
    hops++;
    let ok = false;
    try {
      ok = checks[cur.check] ? await checks[cur.check]!() : false;
    } catch {
      ok = false; // ante la duda, la rama "no" (la que revisa/configura)
    }
    curId = ok ? cur.yes : cur.no;
    cur = flow.nodes[curId];
  }
  if (!cur || cur.kind === 'check') {
    // Nodo inexistente o cadena de checks sin salida (>10 saltos): abortar honesto.
    FLOW_SESSIONS.delete(convId);
    return { reply: 'Uy, este diagnóstico tiene un paso que no encuentro. Contame el problema con tus palabras y te ayudo igual.', suggestions: [], actions: [], done: true, kind: 'flow' };
  }
  FLOW_SESSIONS.set(convId, { flowId: flow.id, nodeId: curId });
  prune();
  return render(flow, cur, convId);
}

export async function startFlow(convId: string, flowId: string, checks: FlowChecks): Promise<FlowReply | null> {
  const flow = FLOWS.find((f) => f.id === flowId);
  if (!flow) return null;
  return advance(flow, flow.start, convId, checks);
}

/**
 * Si hay un flujo activo para la conversación, interpreta la respuesta.
 * Devuelve null cuando NO debe manejarla (sin flujo activo, o el usuario
 * cambió de tema → se suelta el flujo y la pregunta sigue al motor).
 */
export async function handleFlowAnswer(convId: string, question: string, checks: FlowChecks): Promise<FlowReply | null> {
  const st = FLOW_SESSIONS.get(convId);
  if (!st) return null;
  const flow = FLOWS.find((f) => f.id === st.flowId);
  const node = flow?.nodes[st.nodeId];
  if (!flow || !node || node.kind !== 'ask') {
    FLOW_SESSIONS.delete(convId);
    return null;
  }
  const n = norm(question);
  if (EXIT_PH.some((p) => n === norm(p) || n.startsWith(norm(p) + ' '))) {
    FLOW_SESSIONS.delete(convId);
    return { reply: 'Dale, lo dejamos acá. Si querés retomarlo, escribime el problema de nuevo y arrancamos donde haga falta.', suggestions: [], actions: [], done: true, kind: 'flow' };
  }
  // Match de la opción: label exacto normalizado, contención, o número de opción.
  let elegida: { label: string; next: string } | null = null;
  const byNumber = n.match(/^(?:opcion\s*)?([1-9])$/);
  if (byNumber) elegida = node.options[Number(byNumber[1]) - 1] ?? null;
  if (!elegida) {
    for (const o of node.options) {
      const on = norm(o.label);
      if (n === on || n.includes(on) || (on.includes(n) && n.length >= 2)) {
        elegida = o;
        break;
      }
    }
  }
  // "sí"/"no" pelados: si hay UNA sola opción afirmativa/negativa clara, tomarla.
  if (!elegida && (n === 'si' || n === 'no')) {
    const afirm = node.options.filter((o) => norm(o.label).startsWith('si'));
    const neg = node.options.filter((o) => norm(o.label).startsWith('no'));
    if (n === 'si' && afirm.length === 1) elegida = afirm[0]!;
    if (n === 'no' && neg.length === 1) elegida = neg[0]!;
  }
  if (!elegida) {
    // Cambió de tema: soltar el flujo sin ruido y dejar que responda el motor.
    FLOW_SESSIONS.delete(convId);
    return null;
  }
  return advance(flow, elegida.next, convId, checks);
}

/** Sólo para tests. */
export function flowStateOf(convId: string): { flowId: string; nodeId: string } | null {
  return FLOW_SESSIONS.get(convId) ?? null;
}
