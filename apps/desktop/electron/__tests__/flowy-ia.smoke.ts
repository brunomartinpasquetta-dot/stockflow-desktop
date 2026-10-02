/**
 * Pruebas de la IA local de Flowy (Ollama) contra un Ollama FALSO: corren en
 * cualquier máquina y en CI, sin descargar modelos. Uso:
 *   pnpm --filter @stockflow/desktop test:flowy-ia
 *
 * Qué se cuida:
 *  - Apagada (lo que viene de fábrica), Flowy responde igual que siempre.
 *  - "entender": elige el tema por significado y responde la ficha curada.
 *  - El índice se guarda y se reutiliza (no se recalcula en cada arranque).
 *  - "conversar": redacta, entrega el texto de a pedazos y deja la charla en
 *    el tema (después "guiame" funciona).
 *  - Si Ollama falla o no está, NUNCA rompe: responde el motor.
 *  - Configurar/descargar/instalar exige permiso y no pasa desde la red ni desde internet.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { answerChat, lastResolved, temasKB } from '../assistant/engine';
import { esSeguimientoReferencial, FlowyIA, limpiarRespuesta } from '../assistant/ia/flowyIA';
import { ARGUMENTOS_INSTALACION_SILENCIOSA, prepararArchivosOllama } from '../assistant/ia/instalador';
import { OllamaClient } from '../assistant/ia/ollama';
import { IndiceSemantico } from '../assistant/ia/semantico';
import type { HandlerDeps } from '../ipc/handler-context';
import { buildAssistantHandlers } from '../ipc/handlers/assistant.handlers';
import { lanServerAccepts, remotoAccepts } from '../preload-bridge';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

/* ─────────────────────────── Ollama falso ─────────────────────────── */

const DIMS = 4096;
function sinAcentos(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
/** "Embedding" de juguete: bolsa de palabras (raíz de 5 letras) repartida en 4096 casillas. */
function vectorFalso(texto: string): number[] {
  const sinPrefijo = texto.includes('query: ') ? texto.slice(texto.lastIndexOf('query: ') + 7) : texto;
  const v = new Array<number>(DIMS).fill(0);
  for (const w of sinAcentos(sinPrefijo).split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    const raiz = w.slice(0, 5);
    let h = 0;
    for (const ch of raiz) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS]! += 1;
  }
  return v;
}

interface OllamaFalso {
  url: string;
  modelos: Set<string>;
  cargados: Set<string>;
  llamadasEmbed: number;
  textosEmbebidos: number;
  chatFalla: boolean;
  cerrar: () => Promise<void>;
}

async function leerCuerpo(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const ch of req) s += ch;
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

async function levantarOllamaFalso(modelos: string[]): Promise<OllamaFalso> {
  const estado = { modelos: new Set(modelos), cargados: new Set<string>(), llamadasEmbed: 0, textosEmbebidos: 0, chatFalla: false };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const json = (obj: unknown, code = 200): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/version') return json({ version: '0.35.0' });
      if (req.url === '/api/ps') return json({ models: [...estado.cargados].map((m) => ({ name: m, model: m })) });
      if (req.url === '/api/tags') {
        return json({ models: [...estado.modelos].map((m) => ({ name: m, model: m, size: 1000, digest: `sha-${m}` })) });
      }
      const body = await leerCuerpo(req);
      const modelo = String(body.model ?? '');
      if (req.url === '/api/embed') {
        if (!estado.modelos.has(modelo)) return json({ error: `model "${modelo}" not found` }, 404);
        const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input)];
        estado.llamadasEmbed++;
        estado.textosEmbebidos += input.length;
        estado.cargados.add(modelo);
        return json({ model: modelo, embeddings: input.map(vectorFalso) });
      }
      if (req.url === '/api/chat') {
        if (!estado.modelos.has(modelo)) return json({ error: `model "${modelo}" not found` }, 404);
        if (estado.chatFalla) return json({ error: 'se quedó sin memoria' }, 500);
        estado.cargados.add(modelo);
        const msgs = (body.messages as { role: string; content: string }[]) ?? [];
        const ultimo = msgs[msgs.length - 1]?.content ?? '';
        const titulo = /\[1\] (.+)/.exec(ultimo)?.[1] ?? 'sin ficha';
        const pedazos = ['Respuesta de prueba ', `sobre «${titulo}».`, '\n\n1. Primer paso.\n2. Segundo paso.'];
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          for (const p of pedazos) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n');
            await new Promise((r) => setTimeout(r, 30));
          }
          res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 20, prompt_eval_count: 300 }) + '\n');
          return;
        }
        return json({ message: { role: 'assistant', content: pedazos.join('') }, done: true, eval_count: 20, prompt_eval_count: 300 });
      }
      if (req.url === '/api/pull') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 50 }) + '\n');
        await new Promise((r) => setTimeout(r, 30));
        res.write(JSON.stringify({ status: 'downloading', total: 100, completed: 100 }) + '\n');
        estado.modelos.add(modelo);
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      json({ error: 'ruta desconocida' }, 404);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    get modelos() {
      return estado.modelos;
    },
    get cargados() {
      return estado.cargados;
    },
    get llamadasEmbed() {
      return estado.llamadasEmbed;
    },
    get textosEmbebidos() {
      return estado.textosEmbebidos;
    },
    get chatFalla() {
      return estado.chatFalla;
    },
    set chatFalla(v: boolean) {
      estado.chatFalla = v;
    },
    cerrar: () => new Promise<void>((r) => server.close(() => r())),
  } as OllamaFalso;
}

/* ──────────────────────────────── pruebas ──────────────────────────────── */

const EMB = 'embed-falso:1';
const CHAT = 'qwen3:1.7b';
// Umbrales para el embedding de juguete (los reales están calibrados para embeddinggemma).
const UMBRALES = { seguro: 0.6, ventaja: 0, minimo: 0.3 };
const dirs: string[] = [];
const nuevoDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'flowy-ia-'));
  dirs.push(d);
  return d;
};

async function main(): Promise<void> {
  console.log('── Limpieza de respuestas ──');
  check(limpiarRespuesta('Abrí la ficha del cliente [2] y listo.') === 'Abrí la ficha del cliente y listo.', 'conserva "la ficha del cliente" y saca "[2]"');
  check(limpiarRespuesta('<think>mmm</think>Hola') === 'Hola', 'saca el bloque de pensamiento');
  check(limpiarRespuesta('Según la ficha 1, tocá Guardar.') === 'tocá Guardar.', 'saca "según la ficha 1"');

  const falso = await levantarOllamaFalso([EMB, CHAT]);
  const cliente = new OllamaClient({ baseUrl: falso.url });

  console.log('\n── Apagada (de fábrica) ──');
  {
    const ia = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    check(ia.getConfig().modo === 'apagado', 'viene apagada');
    check(!ia.activa(), 'no está activa');
    check((await ia.responder('donde veo las ventas registradas', 'a1', null)) === null, 'responder() devuelve null: contesta el motor');
  }

  console.log('\n── Modo "entender" ──');
  const dirEntender = nuevoDir();
  {
    const ia = new FlowyIA({ userDataDir: dirEntender, cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.configurar({ modo: 'entender', url: falso.url, modeloEmbeddings: EMB });
    await ia.preparar();
    const e = await ia.estado();
    check(e.indice.estado === 'listo' && e.indice.vectores > 400, 'arma el índice', `${e.indice.estado}, ${e.indice.vectores} vectores`);
    check(ia.activa() && !ia.redacta(), 'activa y sin redactar');
    const r = await ia.responder('donde veo las ventas registradas', 'e1', null);
    check(r?.kind === 'intent' && lastResolved('e1')?.id === 'historial-ventas', 'elige el tema por significado y responde la ficha', lastResolved('e1')?.id ?? 'nada');
    check(!r?.generated, 'la ficha es texto curado, no redactado');
    const ajena = await ia.elegirTema('receta de milanesa napolitana', 'e2');
    check((await ia.responder('receta de milanesa napolitana', 'e2', null)) === null, 'pregunta ajena: devuelve null (el motor dice que no sabe)', `parecido ${ajena?.score.toFixed(2)} con ${ajena?.id}`);
  }

  console.log('\n── El índice se reutiliza ──');
  {
    const antes = falso.textosEmbebidos;
    const ia = new FlowyIA({ userDataDir: dirEntender, cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.preparar();
    check(ia.activa(), 'queda activa al "reiniciar"');
    check(falso.textosEmbebidos === antes, 'no vuelve a calcular el índice', `textos nuevos: ${falso.textosEmbebidos - antes}`);
  }

  console.log('\n── Índice base que trae la app ──');
  {
    const rutaBase = join(dirEntender, 'flowy-ia-indice.json');
    const antes = falso.textosEmbebidos;
    const ia = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: rutaBase });
    await ia.configurar({ modo: 'entender', url: falso.url, modeloEmbeddings: EMB });
    await ia.preparar();
    const calculados = falso.textosEmbebidos - antes;
    check(ia.activa() && calculados <= 6, 'con el índice base, la PC sólo calcula las frases testigo', `${calculados} frases`);
    const r = await ia.responder('donde veo las ventas registradas', 'b1', null);
    check(r?.kind === 'intent' && lastResolved('b1')?.id === 'historial-ventas', 'y responde bien con los vectores de la base');

    // Base armada con OTRO modelo (vectores distintos): se descarta y se arma en la PC.
    const baseRara = JSON.parse(readFileSync(rutaBase, 'utf8')) as { testigos: { vectores: string } };
    baseRara.testigos.vectores = Buffer.alloc(Buffer.from(baseRara.testigos.vectores, 'base64').length).toString('base64');
    const rutaRara = join(nuevoDir(), 'base-rara.json');
    writeFileSync(rutaRara, JSON.stringify(baseRara));
    const antes2 = falso.textosEmbebidos;
    const ia2 = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: rutaRara });
    await ia2.configurar({ modo: 'entender', url: falso.url, modeloEmbeddings: EMB });
    await ia2.preparar();
    check(ia2.activa() && falso.textosEmbebidos - antes2 > 400, 'si la base no coincide con el modelo, la descarta y arma todo', `${falso.textosEmbebidos - antes2} frases`);
  }

  console.log('\n── Reutilizar vectores cuando cambia la base ──');
  {
    const docsA = ['como hago una venta', 'como abro la caja', 'como cargo un articulo'].map((texto, k) => ({ clave: `i:${k}`, texto }));
    const idxA = await IndiceSemantico.construir(cliente, EMB, 'd', 'hA', docsA);
    // Una ficha nueva ADELANTE corre las claves de todas las demás.
    const docsB = [{ clave: 'i:0', texto: 'frase nueva de prueba' }, ...docsA.map((d, k) => ({ clave: `i:${k + 1}`, texto: d.texto }))];
    check(idxA.faltantes(docsB) === 1, 'agregar una ficha sólo obliga a calcular esa ficha', `${idxA.faltantes(docsB)} a calcular`);
    const antes = falso.textosEmbebidos;
    const idxB = await IndiceSemantico.construir(cliente, EMB, 'd', 'hB', docsB, { reutilizar: idxA });
    check(idxB.tamaño === 4 && falso.textosEmbebidos - antes === 1 + 3, 'y al armar calcula sólo esa (más las 3 testigo)', `${falso.textosEmbebidos - antes} frases`);
  }

  console.log('\n── Modo "conversar" ──');
  {
    const ia = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.configurar({ modo: 'conversar', url: falso.url, modeloEmbeddings: EMB });
    await ia.preparar();
    check(ia.redacta(), 'redacta (tiene el modelo de chat)');
    const sinCargar = await ia.responder('como abro la caja con el saldo inicial', 'c0', null);
    check(sinCargar?.kind === 'intent' && !sinCargar.generated, 'con el modelo de chat todavía sin cargar, contesta la ficha al instante');
    await ia.precalentar();
    const pedazos: string[] = [];
    const r = await ia.responder('como abro la caja con el saldo inicial', 'c1', null, (t) => pedazos.push(t));
    check(Boolean(r?.generated) && /Respuesta de prueba/.test(r?.reply ?? ''), 'la respuesta la redacta la IA', r?.reply.slice(0, 60));
    check(pedazos.length >= 3 && pedazos[pedazos.length - 1]!.length > pedazos[0]!.length, 'el texto llega de a pedazos', `${pedazos.length} pedazos`);
    const guia = answerChat('guiame', 'c1');
    check(Boolean(guia && /Paso 1 de/.test(guia.reply)), 'después, "guiame" sigue con los pasos de ese tema', guia?.reply.slice(0, 40));

    falso.chatFalla = true;
    const r2 = await ia.responder('como abro la caja con el saldo inicial', 'c2', null);
    check(r2?.kind === 'intent' && !r2.generated, 'si el modelo falla, responde la ficha curada');
    falso.chatFalla = false;
  }

  console.log('\n── Descarga de modelos ──');
  {
    falso.modelos.delete(CHAT);
    const ia = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.configurar({ modo: 'conversar', url: falso.url, modeloEmbeddings: EMB });
    await ia.preparar();
    check(!(await ia.estado()).modelos.chat.descargado, 'detecta que falta el modelo de chat');
    check(!ia.redacta(), 'sin el modelo no intenta redactar');
    ia.descargarModelos();
    const limite = Date.now() + 5000;
    while (Date.now() < limite && !(await ia.estado()).modelos.chat.descargado) await new Promise((r) => setTimeout(r, 50));
    check((await ia.estado()).modelos.chat.descargado, 'lo descarga');
  }

  console.log('\n── Canales del asistente ──');
  {
    const ia = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.configurar({ modo: 'conversar', url: falso.url, modeloEmbeddings: EMB });
    await ia.preparar();
    await ia.precalentar();
    let rol: 'admin' | 'seller' = 'admin';
    const deps = {
      db: {},
      repos: {},
      userDataDir: nuevoDir(),
      appVersion: 'test',
      sessionStore: { getSession: () => ({ user: { id: 1, username: 'x', role: rol } }), getCurrentCashRegister: () => null },
      hardware: { getConfig: () => ({}) },
      flowyIA: ia,
    } as unknown as HandlerDeps;
    const h = buildAssistantHandlers(deps);
    const ask = (await h['assistant:ask']!({ messages: [{ role: 'user', content: 'como abro la caja con el saldo inicial' }], conversationId: 'h1' })) as {
      ok: boolean;
      data: { pendiente?: string };
    };
    check(ask.ok && Boolean(ask.data.pendiente), 'con IA redactando, "ask" devuelve una respuesta pendiente');
    type RespuestaSeguir = { ok: boolean; data: { listo: boolean; reply: string; ia?: boolean } };
    let seguir: RespuestaSeguir | null = null;
    const limite = Date.now() + 5000;
    while (Date.now() < limite) {
      seguir = (await h['assistant:seguir']!({ id: ask.data.pendiente })) as unknown as RespuestaSeguir;
      if (seguir.data.listo) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    check(Boolean(seguir?.data.listo && seguir.data.ia && /Respuesta de prueba/.test(seguir.data.reply)), '"seguir" entrega la respuesta completa, marcada como IA');
    const saludo = (await h['assistant:ask']!({ messages: [{ role: 'user', content: 'hola' }], conversationId: 'h2' })) as { data: { reply: string; pendiente?: string } };
    check(!saludo.data.pendiente && /Flowy/.test(saludo.data.reply), 'la charla ("hola") la sigue contestando el motor al instante');

    rol = 'seller';
    const denegado = (await h['assistant:iaConfigurar']!({ modo: 'apagado' })) as { ok: boolean };
    check(!denegado.ok, 'un vendedor no puede cambiar la configuración de la IA');
    const estadoVendedor = (await h['assistant:iaEstado']!(undefined)) as { ok: boolean };
    check(estadoVendedor.ok, 'pero sí puede ver el estado');
  }

  console.log('\n── Instalador de Ollama ──');
  {
    check(ARGUMENTOS_INSTALACION_SILENCIOSA.join(' ') === '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES', 'instala en silencio con los parámetros oficiales');
    const falsaLocal = nuevoDir();
    const falsoHome = nuevoDir();
    prepararArchivosOllama({ localAppData: falsaLocal, home: falsoHome });
    const conf = JSON.parse(readFileSync(join(falsoHome, '.ollama', 'server.json'), 'utf8')) as { disable_ollama_cloud?: boolean };
    check(conf.disable_ollama_cloud === true, 'deja apagadas las funciones de nube de Ollama');
    check(readFileSync(join(falsaLocal, 'Ollama', 'upgraded'), 'utf8') === '', 'deja la marca para que Ollama arranque oculto');
    writeFileSync(join(falsoHome, '.ollama', 'server.json'), '{"otra":"config"}');
    prepararArchivosOllama({ localAppData: falsaLocal, home: falsoHome });
    check(readFileSync(join(falsoHome, '.ollama', 'server.json'), 'utf8') === '{"otra":"config"}', 'no pisa una configuración de Ollama que ya exista');
  }

  console.log('\n── Charla: botones, seguimientos y registro de correcciones ──');
  {
    check(
      esSeguimientoReferencial('y para borrarlo') && esSeguimientoReferencial('¿y eso dónde está?') && esSeguimientoReferencial('como lo modifico'),
      'detecta seguimientos que se refieren al tema anterior',
    );
    check(!esSeguimientoReferencial('como cierro el dia') && !esSeguimientoReferencial('backup'), 'una pregunta corta nueva NO se pega al tema anterior');
    const iaC = new FlowyIA({ userDataDir: nuevoDir(), cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await iaC.configurar({ modo: 'entender', url: falso.url, modeloEmbeddings: EMB });
    await iaC.preparar();
    const tema = temasKB().find((t) => t.id === 'cerrar-caja')!;
    await iaC.responder('como hago una venta', 'clic-1', null);
    const elegido = await iaC.elegirTema(tema.canonical, 'clic-1');
    check(elegido?.id === 'cerrar-caja' && elegido.score === 1, 'el clic en un botón (pregunta canónica) responde esa ficha directo', elegido?.id ?? '-');

    const dirReg = nuevoDir();
    const depsReg = {
      db: {},
      repos: {},
      userDataDir: dirReg,
      appVersion: 'test',
      sessionStore: { getSession: () => ({ user: { id: 1, username: 'x', role: 'admin' } }), getCurrentCashRegister: () => null },
      hardware: { getConfig: () => ({}) },
      flowyIA: iaC,
    } as unknown as HandlerDeps;
    const hR = buildAssistantHandlers(depsReg);
    const r1 = (await hR['assistant:ask']!({ messages: [{ role: 'user', content: 'donde veo las ventas registradas' }], conversationId: 'reg-1' })) as unknown as {
      data: { suggestions: string[] };
    };
    const otro = r1.data.suggestions[0];
    if (otro) await hR['assistant:ask']!({ messages: [{ role: 'user', content: otro }], conversationId: 'reg-1' });
    let lineas: { t: string; preguntaOriginal?: string }[] = [];
    try {
      lineas = readFileSync(join(dirReg, 'flowy-ia-decisiones.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { t: string });
    } catch {
      /* sin archivo */
    }
    check(lineas.filter((l) => l.t === 'respuesta').length >= 1, 'anota en la PC cada respuesta de la IA');
    check(
      Boolean(otro) && lineas.some((l) => l.t === 'correccion' && l.preguntaOriginal === 'donde veo las ventas registradas'),
      'tocar otro botón queda anotado como corrección (pregunta original → ficha elegida)',
    );
  }

  console.log('\n── Red local e internet ──');
  for (const ch of ['assistant:iaConfigurar', 'assistant:iaDescargar', 'assistant:iaInstalarOllama', 'assistant:iaProbar']) {
    check(!lanServerAccepts(ch) && !remotoAccepts(ch), `${ch} no pasa desde un puesto ni desde internet`);
  }
  for (const ch of ['assistant:ask', 'assistant:seguir', 'assistant:iaEstado', 'assistant:iaPrecalentar']) {
    check(lanServerAccepts(ch), `${ch} sí pasa desde un puesto`);
  }

  console.log('\n── Ollama caído ──');
  {
    const ia = new FlowyIA({ userDataDir: dirEntender, cliente, umbrales: UMBRALES, log: () => {}, rutaIndiceBase: null });
    await ia.preparar();
    await falso.cerrar();
    const t = Date.now();
    const r = await ia.responder('donde veo las ventas registradas', 'd1', null);
    check(r === null && Date.now() - t < 5000, 'si Ollama se cae, responde el motor (sin colgarse)', `${Date.now() - t} ms`);
    const e = await ia.estado();
    check(!e.ollama.disponible && Boolean(e.ultimoError), 'el estado muestra que Ollama no responde', e.ultimoError ?? '');
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
  process.exit(fallas ? 1 : 0);
}

void main();
