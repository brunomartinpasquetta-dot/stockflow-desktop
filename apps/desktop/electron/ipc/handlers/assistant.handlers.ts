/**
 * Handler del Asistente virtual de StockFlow ("Flowy").
 *
 * Chatbot INTERNO: responde 100% offline, sin IA externa, sin clave y sin costo.
 * La lógica de búsqueda vive en `electron/assistant/engine.ts` (intents curados +
 * manual). Este handler solo toma el último mensaje del usuario y devuelve la
 * respuesta + sugerencias.
 */
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import { responderConDatos } from '../../assistant/consultas';
import { resolveScreenArea } from '../../assistant/context';
import { answerQuestion } from '../../assistant/engine';
import { detectFlow, handleFlowAnswer, startFlow, type FlowChecks } from '../../assistant/flows';
import { kbLoadError } from '../../assistant/kbLoader';

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface AssistantAskResult {
  reply: string;
  suggestions: string[];
  image?: string | null;
  /** Botones de navegación; el renderer los oculta si el rol no tiene permiso. */
  actions?: { label: string; screen: string }[];
}

function lastUserMessage(messages: AssistantMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && m.content?.trim()) return m.content;
  }
  return '';
}

/**
 * Registra las preguntas que Flowy NO supo responder, en un archivo local
 * (`<userData>/flowy-preguntas-sin-respuesta.jsonl`). Sirve para descubrir qué
 * le falta con el uso real y alimentar futuras versiones. No sale de la máquina.
 */
const MISS_LOG_MAX_BYTES = 512 * 1024;

function logMiss(userDataDir: string, appVersion: string, question: string): void {
  try {
    const file = join(userDataDir, 'flowy-preguntas-sin-respuesta.jsonl');
    // Rotación simple: al superar el tope pasa a .1 (pisando la rotación
    // anterior) — el archivo no crece sin límite en años de uso.
    try {
      if (statSync(file).size > MISS_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
    } catch {
      /* no existe todavía */
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), v: appVersion, q: question }) + '\n';
    appendFileSync(file, line);
  } catch {
    /* logging best-effort; no rompe la respuesta */
  }
}

export function buildAssistantHandlers(deps: HandlerDeps): HandlerMap {
  return {
    // withSession: el asistente responde con los MISMOS límites que la UI.
    // Antes era `unguarded` y consultas.ts devolvía ventas/caja/deudores a
    // cualquier rol (incluso sin sesión, y a cualquier puesto en modo LAN).
    'assistant:ask': withSession(
      deps,
      async (
        payload: { messages: AssistantMessage[]; conversationId?: string; screen?: string },
        ctx,
      ): Promise<AssistantAskResult> => {
        const question = lastUserMessage(payload?.messages ?? []);
        // Contexto de pantalla (E1): pageKey de la ventana donde está el usuario.
        const screenArea = resolveScreenArea(payload?.screen);

        // KB rota/ausente: el asistente se degrada con honestidad (la app ya
        // arrancó igual — ver kbLoader).
        if (kbLoadError) {
          return {
            reply:
              'El asistente no está disponible en esta instalación: no se pudo cargar su base de conocimiento. ' +
              'El resto de StockFlow funciona con normalidad. Avisá a soporte para repararlo.',
            suggestions: [],
            image: null,
          };
        }

        // Flujos de diagnóstico (E3). Los checks automáticos leen el estado
        // REAL del sistema: no se le pregunta al usuario lo que el main ya sabe.
        const convId = payload?.conversationId ?? 'default';
        const checks: FlowChecks = {
          'printer-configured': async () => Boolean(deps.hardware.getConfig().printer),
          'scale-configured': async () => Boolean(deps.hardware.getConfig().scale),
        };
        if (question.trim()) {
          // ¿Hay un flujo activo esperando esta respuesta?
          const enCurso = await handleFlowAnswer(convId, question, checks);
          if (enCurso) return { reply: enCurso.reply, suggestions: enCurso.suggestions, image: null, actions: enCurso.actions };
          // ¿La pregunta dispara un diagnóstico guiado?
          const flowId = detectFlow(question);
          if (flowId) {
            const inicio = await startFlow(convId, flowId, checks);
            if (inicio) return { reply: inicio.reply, suggestions: inicio.suggestions, image: null, actions: inicio.actions };
          }
        }

        // Después: ¿es una pregunta por datos del negocio? ("cuánto vendí hoy",
        // "tengo stock de X"). Se contesta con el número real en vez de
        // explicar dónde mirarlo — respetando los permisos del rol.
        if (question.trim()) {
          try {
            const dato = await responderConDatos({ repos: ctx.repos, user: ctx.currentUser }, question);
            if (dato) return { reply: dato, suggestions: [], image: null };
          } catch {
            /* si falla, sigue el motor de conocimiento */
          }
        }

        const ans = answerQuestion(question, convId, screenArea);
        if (ans.kind === 'fallback' && question.trim()) logMiss(deps.userDataDir, deps.appVersion, question.trim());
        return { reply: ans.reply, suggestions: ans.suggestions, image: ans.image, actions: ans.actions ?? [] };
      },
    ),
  };
}
