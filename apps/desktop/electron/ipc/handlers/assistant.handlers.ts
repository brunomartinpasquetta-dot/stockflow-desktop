/**
 * Handler del Asistente virtual de StockFlow ("Flowy").
 *
 * Chatbot INTERNO: responde 100% offline, sin IA externa, sin clave y sin costo.
 * La lógica de búsqueda vive en `electron/assistant/engine.ts` (intents curados +
 * manual). Este handler solo toma el último mensaje del usuario y devuelve la
 * respuesta + sugerencias.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import { responderConDatos } from '../../assistant/consultas';
import { answerQuestion } from '../../assistant/engine';

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface AssistantAskResult {
  reply: string;
  suggestions: string[];
  image?: string | null;
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
function logMiss(userDataDir: string, question: string): void {
  try {
    const line = JSON.stringify({ q: question }) + '\n';
    appendFileSync(join(userDataDir, 'flowy-preguntas-sin-respuesta.jsonl'), line);
  } catch {
    /* logging best-effort; no rompe la respuesta */
  }
}

export function buildAssistantHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'assistant:ask': unguarded(
      deps,
      async (
        payload: { messages: AssistantMessage[]; conversationId?: string },
        d,
      ): Promise<AssistantAskResult> => {
        const question = lastUserMessage(payload?.messages ?? []);

        // Primero: ¿es una pregunta por datos del negocio? ("cuánto vendí hoy",
        // "tengo stock de X"). Se contesta con el número real en vez de
        // explicar dónde mirarlo.
        const repos = d.repos;
        if (repos && question.trim()) {
          try {
            const dato = await responderConDatos({ repos }, question);
            if (dato) return { reply: dato, suggestions: [], image: null };
          } catch {
            /* si falla, sigue el motor de conocimiento */
          }
        }

        const ans = answerQuestion(question, payload?.conversationId ?? 'default');
        if (ans.kind === 'fallback' && question.trim()) logMiss(d.userDataDir, question.trim());
        return { reply: ans.reply, suggestions: ans.suggestions, image: ans.image };
      },
    ),
  };
}
