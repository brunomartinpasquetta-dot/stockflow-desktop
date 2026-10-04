/**
 * Handler del Asistente virtual de StockFlow ("Flowy").
 *
 * Responde sin salir a internet. Dos cerebros:
 *  - el motor de siempre (`electron/assistant/engine.ts`: fichas curadas +
 *    manual, búsqueda por palabras);
 *  - opcional, la IA LOCAL con Ollama (`electron/assistant/ia/`): entiende la
 *    pregunta por su significado y, si la PC da, redacta la respuesta. Es
 *    gratis y corre en la misma PC. Si no está o falla, contesta el motor.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { requirePermission } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import { responderConDatos } from '../../assistant/consultas';
import { resolveScreenArea } from '../../assistant/context';
import { answerChat, answerQuestion, answerTopic, lastResolved, type AssistantAnswer } from '../../assistant/engine';
import { detectFlow, handleFlowAnswer, startFlow, type FlowChecks } from '../../assistant/flows';
import { limpiarRespuesta, type ConfigIA, type EstadoIA } from '../../assistant/ia/flowyIA';
import type { EstadoInstalacion } from '../../assistant/ia/instalador';
import { RegistroDecisiones, UltimaRespuestaPorCharla } from '../../assistant/ia/registro';
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
  /**
   * La respuesta la está escribiendo la IA: el panel pide el resto con
   * `assistant:seguir` y la muestra mientras se escribe (anda igual en los
   * puestos de la red, que no reciben eventos del servidor).
   */
  pendiente?: string;
  /** true = la contestó la IA local. */
  ia?: boolean;
}

export interface AssistantSeguirResult extends AssistantAskResult {
  listo: boolean;
}

/** Respuestas que la IA está escribiendo, por id. Se limpian solas a los 5 minutos. */
interface TrabajoIA {
  texto: string;
  listo: boolean;
  resultado: AssistantAskResult | null;
  creado: number;
}
const TRABAJOS = new Map<string, TrabajoIA>();
function limpiarTrabajos(): void {
  const ahora = Date.now();
  for (const [id, t] of TRABAJOS) if (ahora - t.creado > 5 * 60_000) TRABAJOS.delete(id);
}

/** `ia` en la respuesta = el texto lo redactó la IA (el panel lo aclara debajo). */
function aResultado(a: AssistantAnswer): AssistantAskResult {
  return { reply: a.reply, suggestions: a.suggestions, image: a.image ?? null, actions: a.actions ?? [], ia: Boolean(a.generated) };
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
  // Registro local de decisiones de la IA y de correcciones (clic en otro botón).
  const registro = new RegistroDecisiones(deps.userDataDir, deps.appVersion);
  const ultimas = new UltimaRespuestaPorCharla();
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
            const dato = await responderConDatos({ repos: ctx.repos, user: ctx.currentUser, terminalId: ctx.terminalId ?? null }, question);
            if (dato) return { reply: dato, suggestions: [], image: null };
          } catch {
            /* si falla, sigue el motor de conocimiento */
          }
        }

        // IA local (Ollama), si está activada y lista en esta PC.
        const ia = deps.flowyIA;
        if (ia?.activa() && question.trim()) {
          // La charla (saludos, "guiame", "no entendí", "la primera"…) la sigue
          // manejando el motor: es rápida y ya está afinada.
          const charla = answerChat(question, convId);
          if (charla) return aResultado(charla);

          // ¿Tocó otro botón de la respuesta anterior? Eso es una corrección.
          const clic = ultimas.esClicEnSugerencia(convId, question);
          const cerrar = (r: AssistantAnswer | null): AssistantAskResult => {
            const final = r ?? answerTopic(question, convId, screenArea);
            if (final.kind === 'fallback') logMiss(deps.userDataDir, deps.appVersion, question.trim());
            const resuelto = final.kind === 'intent' ? lastResolved(convId) : null;
            const elegido = resuelto ? `${resuelto.area}/${resuelto.id}` : null;
            registro.anotar({ t: 'respuesta', q: question.trim(), pantalla: screenArea, via: r ? 'ia' : 'motor', elegido, top: ia.ultimosCandidatos() });
            if (clic && elegido && elegido !== clic.mostrado) {
              registro.anotar({ t: 'correccion', preguntaOriginal: clic.pregunta, mostrado: clic.mostrado, elegido });
            }
            ultimas.recordar(convId, question.trim(), elegido, final.suggestions);
            return aResultado(final);
          };

          if (ia.redacta()) {
            // Redactar tarda: se devuelve un id y el panel va mostrando el texto.
            limpiarTrabajos();
            const id = randomUUID();
            const trabajo: TrabajoIA = { texto: '', listo: false, resultado: null, creado: Date.now() };
            TRABAJOS.set(id, trabajo);
            void (async () => {
              let r: AssistantAnswer | null;
              try {
                r = await ia.responder(question, convId, screenArea, (t) => {
                  trabajo.texto = t;
                });
              } catch {
                r = null;
              }
              try {
                trabajo.resultado = cerrar(r);
              } catch {
                trabajo.resultado = { reply: 'Uy, algo falló. Probá de nuevo.', suggestions: [] };
              }
              trabajo.listo = true;
            })();
            return { reply: '', suggestions: [], pendiente: id, ia: true };
          }

          let r: AssistantAnswer | null;
          try {
            r = await ia.responder(question, convId, screenArea);
          } catch {
            r = null;
          }
          return cerrar(r);
        }

        const ans = answerQuestion(question, convId, screenArea);
        if (ans.kind === 'fallback' && question.trim()) logMiss(deps.userDataDir, deps.appVersion, question.trim());
        return { reply: ans.reply, suggestions: ans.suggestions, image: ans.image, actions: ans.actions ?? [] };
      },
    ),

    /** Lo que lleva escrito la IA de una respuesta pendiente (el panel pregunta cada ~300 ms). */
    'assistant:seguir': withSession(deps, (payload: { id?: string }): AssistantSeguirResult => {
      const id = payload?.id ?? '';
      const t = TRABAJOS.get(id);
      if (!t) return { listo: true, reply: 'Se me perdió la respuesta. ¿Me lo preguntás de nuevo?', suggestions: [] };
      if (t.listo && t.resultado) {
        TRABAJOS.delete(id);
        return { listo: true, ...t.resultado };
      }
      return { listo: false, reply: limpiarRespuesta(t.texto), suggestions: [], ia: true };
    }),

    /* ───────────── IA local (Ollama): estado y configuración ───────────── */

    'assistant:iaEstado': withSession(deps, async (): Promise<EstadoIA & { instalacion: EstadoInstalacion | null }> => {
      if (!deps.flowyIA) throw new Error('La IA de Flowy no está disponible en esta instalación.');
      return { ...(await deps.flowyIA.estado()), instalacion: deps.ollamaInstalador?.estado() ?? null };
    }),

    'assistant:iaConfigurar': withSession(deps, async (payload: Partial<ConfigIA>, ctx): Promise<EstadoIA> => {
      requirePermission(ctx.currentUser, 'manage_hardware');
      if (!deps.flowyIA) throw new Error('La IA de Flowy no está disponible en esta instalación.');
      return deps.flowyIA.configurar(payload ?? {});
    }),

    'assistant:iaDescargar': withSession(deps, async (_payload: unknown, ctx): Promise<EstadoIA> => {
      requirePermission(ctx.currentUser, 'manage_hardware');
      if (!deps.flowyIA) throw new Error('La IA de Flowy no está disponible en esta instalación.');
      deps.flowyIA.descargarModelos();
      return deps.flowyIA.estado();
    }),

    'assistant:iaInstalarOllama': withSession(deps, async (_payload: unknown, ctx): Promise<EstadoInstalacion> => {
      requirePermission(ctx.currentUser, 'manage_hardware');
      if (!deps.ollamaInstalador) throw new Error('La instalación automática de Ollama no está disponible en esta PC.');
      return deps.ollamaInstalador.iniciar();
    }),

    /** Carga los modelos en memoria al abrir el panel: la primera respuesta sale más rápido. */
    'assistant:iaPrecalentar': withSession(deps, async (): Promise<{ ok: true }> => {
      void deps.flowyIA?.precalentar();
      return { ok: true };
    }),

    /** Pregunta de prueba para ver si la PC da: cuánto tarda y qué contesta. */
    'assistant:iaProbar': withSession(deps, async (_payload: unknown, ctx): Promise<{ ms: number; ia: boolean; reply: string }> => {
      requirePermission(ctx.currentUser, 'manage_hardware');
      const inicio = Date.now();
      const r = deps.flowyIA?.activa()
        ? await deps.flowyIA.responder('¿Cómo hago una venta?', `prueba-${inicio}`, null).catch(() => null)
        : null;
      return { ms: Date.now() - inicio, ia: Boolean(r), reply: r?.reply ?? '' };
    }),
  };
}
