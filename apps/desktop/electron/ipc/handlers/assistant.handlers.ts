/**
 * Handler del Asistente virtual de StockFlow ("Sofía").
 *
 * Chatbot INTERNO: responde 100% offline, sin IA externa, sin clave y sin costo.
 * La lógica de búsqueda vive en `electron/assistant/engine.ts` (intents curados +
 * manual). Este handler solo toma el último mensaje del usuario y devuelve la
 * respuesta + sugerencias.
 */
import { type HandlerDeps, type HandlerMap, unguarded } from '../handler-context';
import { answerQuestion } from '../../assistant/engine';

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}
export interface AssistantAskResult {
  reply: string;
  suggestions: string[];
}

function lastUserMessage(messages: AssistantMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && m.content?.trim()) return m.content;
  }
  return '';
}

export function buildAssistantHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'assistant:ask': unguarded(
      deps,
      (payload: { messages: AssistantMessage[]; conversationId?: string }): AssistantAskResult => {
        const question = lastUserMessage(payload?.messages ?? []);
        return answerQuestion(question, payload?.conversationId ?? 'default');
      },
    ),
  };
}
