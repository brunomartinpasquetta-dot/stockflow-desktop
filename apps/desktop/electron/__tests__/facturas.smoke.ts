/**
 * FACTURAS DE COMPRA POR TELÉFONO — prueba integral (sin Electron, sin Ollama real).
 *
 *   pnpm --filter @stockflow/desktop test:facturas
 *
 * Ollama es un servidor http local FALSO que contesta `/api/chat` en streaming
 * NDJSON con el texto de un fixture (lo que devolvería el lector real). Se
 * prueba el camino entero como lo haría el teléfono, por HTTP:
 *   token → fotos → cerrar → cola → 'lista' con los renglones correctos.
 * Además: apagado por defecto, error claro si Ollama no responde o falta el
 * lector, volver a leer, descartar (borra las fotos), vínculos por código,
 * retomar al reabrir, y los canales IPC con sesión y permisos.
 *
 * El parser y las rutas HTTP tienen su prueba propia y más fina en
 * facturas-parser.smoke.ts y facturas-servidor.smoke.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { OllamaClient, OllamaError } from '../assistant/ia/ollama';
import { cortarRepeticion, LectorFacturas } from '../facturas/lector';
import { parsearTexto, unirHojas } from '../facturas/parser';
import type { DatosQr } from '../facturas/qrFiscal';
import type { CajaTexto, LecturaSistema } from '../facturas/lectorSistema';
import {
  elegirIpLocal,
  FacturasTelefono,
  mismoNumeroDeFactura,
  type EncabezadoFactura,
  type LectorDeHojas,
  type RenglonFactura,
} from '../facturas/servicio';
import { ServidorFotos } from '../facturas/servidorFotos';
import {
  armarPasajeACompras,
  claveDeVinculo,
  cuitParaGuardar,
  datosArticuloNuevo,
  decidirAtajo,
  esCodigoDeBarras,
  proximoCodigoInterno,
  textoDeSeguimiento,
} from '../../src/lib/facturaACompra';
import type { HandlerDeps } from '../ipc/handler-context';
import { buildFacturasHandlers } from '../ipc/handlers/facturas.handlers';
import { buildAllHandlers } from '../ipc/index';
import type {
  EstadoFacturasDTO,
  FacturaEscaneadaDetalleDTO,
  FacturaEscaneadaResumenDTO,
  FacturasSeguimientoDTO,
  FacturasVincularDTO,
  IpcResponse,
} from '../ipc/types';
import { lanServerAccepts, remotoAccepts, shouldRouteLan } from '../preload-bridge';

let fallas = 0;
function check(n: string, ok: boolean, d = ''): void {
  if (!ok) fallas++;
  console.log(`  ${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`);
}

const AQUI = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(AQUI, 'fixtures', 'facturas');
const fixture = (nombre: string): string => readFileSync(join(FIXTURES, `${nombre}.txt`), 'utf8');
const ESPERADO = JSON.parse(readFileSync(join(FIXTURES, 'esperado.json'), 'utf8')) as Record<
  string,
  { codigo: string | null; cantidad: number; unidadesPorBulto: number | null; precioUnitario: number; importe: number }[]
>;

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const silencio = { info: () => {}, warn: () => {}, error: () => {} };

/** "Foto": cabecera JPEG + una marca para reconocerla del otro lado. No se decodifica nunca. */
function fotoFalsa(marca: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`foto:${marca}`, 'utf8'), Buffer.from([0xff, 0xd9])]);
}
function marcaDe(jpeg: Buffer): string {
  return /foto:([\w-]+)/.exec(jpeg.toString('latin1'))?.[1] ?? '';
}

/* ─────────────────────────── Ollama falso ─────────────────────────── */

const MODELO = 'glm-ocr:q8_0';

interface OllamaFalso {
  url: string;
  estado: {
    modelos: Set<string>;
    /** Texto que "lee" de cada foto, según su marca. */
    textoDe: (marca: string) => string;
    /** Después del texto repite el último renglón y corta con el error de Ollama. */
    bucle: boolean;
    /** Milisegundos entre pedazos (para alcanzar a ver 'leyendo'). */
    pausa: number;
    pedidos: Record<string, unknown>[];
    enCurso: number;
    maxEnCurso: number;
    descargas: number;
  };
  cerrar: () => Promise<void>;
}

async function leerJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const trozos: Buffer[] = [];
  for await (const t of req) trozos.push(t as Buffer);
  const s = Buffer.concat(trozos).toString('utf8');
  return s ? (JSON.parse(s) as Record<string, unknown>) : {};
}

async function levantarOllamaFalso(): Promise<OllamaFalso> {
  const estado: OllamaFalso['estado'] = {
    modelos: new Set([MODELO]),
    textoDe: () => '',
    bucle: false,
    pausa: 0,
    pedidos: [],
    enCurso: 0,
    maxEnCurso: 0,
    descargas: 0,
  };
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const json = (obj: unknown, code = 200): void => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.url === '/api/version') return json({ version: '0.35.0' });
      if (req.url === '/api/tags') {
        return json({ models: [...estado.modelos].map((m) => ({ name: m, model: m, size: 1000, digest: `sha-${m}` })) });
      }
      const body = await leerJson(req);
      const modelo = String(body.model ?? '');
      if (req.url === '/api/chat') {
        estado.pedidos.push(body);
        if (!estado.modelos.has(modelo)) return json({ error: `model "${modelo}" not found, try pulling it first` }, 404);
        estado.enCurso++;
        estado.maxEnCurso = Math.max(estado.maxEnCurso, estado.enCurso);
        try {
          const msgs = (body.messages as { images?: string[] }[]) ?? [];
          const imagen = Buffer.from(msgs[0]?.images?.[0] ?? '', 'base64');
          const texto = estado.textoDe(marcaDe(imagen));
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          // Pedazos chicos y que no coinciden con los renglones, como los tokens reales.
          for (let i = 0; i < texto.length; i += 37) {
            res.write(JSON.stringify({ message: { role: 'assistant', content: texto.slice(i, i + 37) }, done: false }) + '\n');
            if (estado.pausa) await esperar(estado.pausa);
          }
          if (estado.bucle) {
            const ultimo = texto.trimEnd().split('\n').pop() ?? '';
            for (let i = 0; i < 12; i++) {
              res.write(JSON.stringify({ message: { role: 'assistant', content: `\n${ultimo}` }, done: false }) + '\n');
            }
            res.end(JSON.stringify({ error: 'token repeat limit reached' }) + '\n');
            return;
          }
          res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, eval_count: 900, prompt_eval_count: 300 }) + '\n');
        } finally {
          estado.enCurso--;
        }
        return;
      }
      if (req.url === '/api/pull') {
        estado.descargas++;
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(JSON.stringify({ status: 'pulling', total: 100, completed: 40 }) + '\n');
        await esperar(30);
        estado.modelos.add(modelo);
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      json({ error: 'ruta desconocida' }, 404);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    estado,
    cerrar: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}

/* ─────────────────────────── el "teléfono" ─────────────────────────── */

async function http(
  base: string,
  metodo: 'GET' | 'POST',
  ruta: string,
  cuerpo?: Buffer,
): Promise<{ status: number; json: Record<string, unknown> | null; texto: string }> {
  const res = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: cuerpo ? { 'content-type': 'image/jpeg' } : undefined,
    body: cuerpo ? new Uint8Array(cuerpo) : undefined,
  });
  const texto = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(texto) as Record<string, unknown>;
  } catch {
    /* página HTML */
  }
  return { status: res.status, json, texto };
}

/** Sondea el estado como la página, hasta que la factura llega a un estado final. */
async function esperarFinal(base: string, token: string, vistos: string[] = []): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const r = await http(base, 'GET', `/lan/foto/${token}/estado`);
    const f = r.json?.factura as { estado: string; hojas: number; hojasLeidas: number } | null;
    const e = f?.estado ?? 'sin-factura';
    if (vistos[vistos.length - 1] !== e) vistos.push(e);
    if (e === 'lista' || e === 'error') return e;
    await esperar(15);
  }
  return 'tiempo';
}

function igualAEsperado(lineas: RenglonFactura[], nombre: string, desde = 0): { exactos: number; total: number } {
  const esperado = ESPERADO[nombre] ?? [];
  let exactos = 0;
  esperado.forEach((e, i) => {
    const r = lineas[desde + i];
    const cerca = (a: number | null | undefined, b: number | null): boolean =>
      a == null || b == null ? (a ?? null) === b : Math.abs(a - b) < 0.006;
    if (
      r &&
      cerca(r.cantidad, e.cantidad) &&
      cerca(r.unidadesPorBulto, e.unidadesPorBulto) &&
      cerca(r.precioUnitario, e.precioUnitario) &&
      cerca(r.importe, e.importe) &&
      // El código se compara por los últimos 6 dígitos (en vital-15 la foto
      // los corta). Si el código esperado no está en el texto leído (los dos
      // descuentos de vital-15), el renglón sale sin código.
      (e.codigo == null ||
        (r.codigo ?? '').slice(-6) === e.codigo.slice(-6) ||
        (r.codigo === null && !fixture(nombre).includes(e.codigo.slice(-6))))
    ) {
      exactos++;
    }
  });
  return { exactos, total: esperado.length };
}

/* ───────────────────────────────── partes ───────────────────────────────── */

function parteLectorSuelto(): void {
  console.log('\n[cortarRepeticion]');
  const renglon = '106988 2 UN Aceite girasol COCINERO x900cc 2.767,77 21,00 3349,00 8.303,31';
  const otro = '183417 1 BTO Arroz largo fino MOLINOS ALA 10 566,12 21,00 685,01 5.661,20';
  check('texto normal queda igual', cortarRepeticion(`${renglon}\n${otro}\n`) === `${renglon}\n${otro}\n`);
  check('dos renglones iguales seguidos se respetan (dos promociones)', cortarRepeticion(`${otro}\n${renglon}\n${renglon}`).split('\n').length === 3);
  const enBucle = [otro, ...Array.from({ length: 30 }, () => renglon)].join('\n');
  check('un renglón repetido en bucle queda una sola vez', cortarRepeticion(enBucle) === `${otro}\n${renglon}`, `${cortarRepeticion(enBucle).split('\n').length} líneas`);
  const bloque = [otro, ...Array.from({ length: 5 }, () => `${renglon}\n${otro.replace('183417', '999999')}`)].join('\n');
  check('un bloque de dos renglones en bucle queda una sola vez', cortarRepeticion(bloque).split('\n').length === 3);
  check('líneas cortas repetidas no se cortan', cortarRepeticion('a\na\na\na\na') === 'a\na\na\na\na');
  const celda = '<tr><td>0183509</td><td>1</td><td>Acond PLUSBELLE</td><td>4.169,28</td></tr>';
  const html = `<table><tr><td>0188760</td><td>3</td><td>Antitr DOVE roll-on</td><td>6.443,79</td></tr>${celda.repeat(9)}${celda.slice(0, 31)}`;
  const cortado = cortarRepeticion(html);
  check('tabla HTML en una sola línea: la fila repetida queda una vez', cortado.split('0183509').length - 1 <= 2 && cortado.includes('0188760'), `${cortado.split('0183509').length - 1} veces`);
  check('texto vacío', cortarRepeticion('') === '');

  console.log('\n[IP para el teléfono]');
  const v4 = (address: string, internal = false) =>
    ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '', cidr: null }) as never;
  check(
    'prefiere la placa real y descarta túneles, puentes y docker',
    elegirIpLocal({ lo0: [v4('127.0.0.1', true)], utun3: [v4('10.8.0.2')], bridge100: [v4('192.168.64.1')], docker0: [v4('172.17.0.1')], en0: [v4('192.168.1.37')] }) === '192.168.1.37',
  );
  check('Windows: "Wi-Fi" antes que "vEthernet (WSL)"', elegirIpLocal({ 'vEthernet (WSL)': [v4('172.20.0.1')], 'Wi-Fi': [v4('192.168.0.15')] }) === '192.168.0.15');
  check('una 10.x de la placa real sirve', elegirIpLocal({ en1: [v4('10.0.0.8')], utun0: [v4('192.168.9.9')] }) === '10.0.0.8');
  check('sin red → null', elegirIpLocal({ lo0: [v4('127.0.0.1', true)], en0: [v4('169.254.10.10')] }) === null);
}

async function parteLector(falso: OllamaFalso): Promise<void> {
  console.log('\n[lector: streaming]');
  const cliente = new OllamaClient({ baseUrl: falso.url });
  const lector = new LectorFacturas({ cliente, modelo: MODELO });
  falso.estado.textoDe = () => fixture('vital-12');
  const foto = fotoFalsa('v12');
  const texto = await lector.leerHoja(foto);
  const pedido = falso.estado.pedidos[falso.estado.pedidos.length - 1] as {
    stream: boolean;
    keep_alive: string;
    options: Record<string, number>;
    messages: { role: string; content: string; images: string[] }[];
  };
  check('devuelve el texto completo', texto === fixture('vital-12'));
  check('pide en streaming', pedido.stream === true);
  check("keep_alive '2m' (un solo modelo en memoria)", pedido.keep_alive === '2m');
  check('opciones del lector', pedido.options.temperature === 0 && pedido.options.num_ctx === 8192 && pedido.options.num_predict === 6000, JSON.stringify(pedido.options));
  check('prompt "Table Recognition:" con la foto en base64', pedido.messages[0]?.content === 'Table Recognition:' && pedido.messages[0]?.images[0] === foto.toString('base64'));

  falso.estado.bucle = true;
  const conBucle = await lector.leerHoja(foto);
  falso.estado.bucle = false;
  const renglones = parsearTexto(conBucle);
  check('si Ollama corta por repetición, conserva lo leído', renglones.length === ESPERADO['vital-12']!.length, `${renglones.length} renglones`);
  check('y saca la cola repetida', conBucle.trimEnd() === fixture('vital-12').trimEnd());

  falso.estado.textoDe = () => '';
  falso.estado.bucle = true;
  let error: unknown = null;
  await lector.leerHoja(foto).catch((e: unknown) => (error = e));
  falso.estado.bucle = false;
  check('si cortó sin leer nada, es un error', error instanceof OllamaError);

  error = null;
  await new LectorFacturas({ cliente, modelo: 'otro-modelo' }).leerHoja(foto).catch((e: unknown) => (error = e));
  check('modelo sin descargar → OllamaError modelo-faltante', error instanceof OllamaError && error.tipo === 'modelo-faltante');
}

/* ───────────────────── lector del sistema (falso) ───────────────────── */

/**
 * Lector del sistema FALSO: arma las cajas de texto a partir del texto de un
 * fixture (una fila de cajas por línea), como si las hubiera leído de la foto.
 * La marca de la "foto" elige el fixture (`reales-roa` → reales/roa.txt) y
 * cómo salió: `borrosa-…` casi no trae texto, `corte-…` trae el texto pegado
 * al borde izquierdo (hoja cortada).
 */
function lectorSistemaFalso(): LectorDeHojas & { lecturas: number } {
  const lector = {
    lecturas: 0,
    disponible: async () => true,
    leerHoja: async (jpeg: Buffer): Promise<LecturaSistema> => {
      lector.lecturas++;
      const marca = marcaDe(jpeg);
      // `sistema-<hoja>`: la lectura REAL del lector del sistema guardada como fixture (sistema/<hoja>.json).
      if (marca.startsWith('sistema-')) return JSON.parse(readFileSync(join(FIXTURES, 'sistema', `${marca.slice('sistema-'.length)}.json`), 'utf8')) as LecturaSistema;
      const nombre = marca.replace(/^(borrosa|corte)-/, '').replace(/^reales-/, 'reales/');
      const lineas = fixture(nombre).split('\n').filter((l) => l.trim());
      const largo = Math.max(...lineas.map((l) => l.length));
      const textos: CajaTexto[] = [];
      lineas.forEach((linea, i) => {
        const y = 0.04 + (0.92 * i) / lineas.length;
        const re = /\S+(?: \S+)*/g; // una caja por columna (las columnas van separadas por 2+ espacios)
        let m: RegExpExecArray | null;
        while ((m = re.exec(linea)) !== null) {
          const corte = marca.startsWith('corte-') ? 0.05 : 0;
          const x0 = Math.max(0, 0.05 + (0.9 * m.index) / largo - corte);
          textos.push({ t: m[0], x0, y0: y, x1: x0 + (0.9 * m[0].length) / largo, y1: y, h: 0.006, c: 0.95 });
        }
      });
      return { ancho: 1500, alto: 2000, textos: marca.startsWith('borrosa-') ? textos.slice(0, 3) : textos };
    },
  };
  return lector;
}

/**
 * Lector principal = el del sistema: proveedor y encabezado desde el texto,
 * control de total, atajo a Compras, calidad de la foto al recibirla, «Mejorar
 * lectura» y «Volver a leer». Con las tres facturas reales del dueño.
 */
async function parteSistema(repos: ReturnType<typeof createRepositories>, adminId: string, dirBase: string, falso: OllamaFalso): Promise<void> {
  console.log('\n[lector del sistema: estado]');
  const dir = join(dirBase, 'con-sistema');
  mkdirSync(dir, { recursive: true });
  const lector = lectorSistemaFalso();
  let consultasOllama = 0;
  const servicio = new FacturasTelefono({
    userDataDir: dir,
    repos,
    cliente: () => {
      const c = new OllamaClient({ baseUrl: falso.url });
      const version = c.version.bind(c);
      c.version = async () => {
        consultasOllama++;
        return version();
      };
      return c;
    },
    lectorSistema: lector,
    log: silencio,
    leerQr: () => null,
    limites: { pendientes: 1000 },
  });
  const servidor = new ServidorFotos({ puerta: servicio, port: 0, host: '127.0.0.1', log: silencio });
  await servidor.start();
  const base = `http://127.0.0.1:${servidor.puerto}`;
  const dirFotos = join(dir, 'facturas-escaneadas');
  falso.estado.modelos.add(MODELO);
  falso.estado.pausa = 0;
  falso.estado.textoDe = (marca) => fixture(marca.replace(/^(borrosa|corte)-/, '').replace(/^reales-/, 'reales/'));
  const encabezadoDe = (id: string): EncabezadoFactura | null => repos.scannedInvoices.obtener(id)!.header as EncabezadoFactura | null;
  const lineasDe = (id: string): RenglonFactura[] => repos.scannedInvoices.obtener(id)!.lines as RenglonFactura[];
  const resumenDe = async (id: string) => (await servicio.listar()).find((f) => f.id === id)!;
  /** Manda una factura de una hoja como el teléfono y espera a que se lea. */
  const mandar = async (token: string, marca: string, forzar = false): Promise<string> => {
    const r = await http(base, 'POST', `/lan/foto/${token}/hoja${forzar ? '?forzar=1' : ''}`, fotoFalsa(marca));
    if (r.status !== 200) throw new Error(`hoja rechazada: ${r.status} ${r.texto}`);
    const id = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    await servicio.esperarCola();
    return id;
  };

  try {
    await servicio.configurar({ activo: true });
    let est = await servicio.estado();
    check('estado: lector del sistema disponible, «Mejorar lectura» apagada', est.lectorSistema.disponible === true && est.mejorLectura === false);
    check('estado: con el lector del sistema NO se consulta a Ollama', consultasOllama === 0 && est.ollama.disponible === false, `${consultasOllama} consultas`);
    const { token } = servicio.crearSesion(adminId);

    console.log('\n[proveedor y encabezado desde el texto (sin QR)]');
    // El negocio que usa StockFlow figura en la hoja como cliente: su CUIT nunca es el del proveedor.
    await repos.company.upsert({ cuit: '20-24681357-5' });
    const roa = await repos.suppliers.create({ code: 'P-ROA', name: 'Roa Distribuciones', cuit: '27-24815936-2' } as never);
    const pedidos0 = falso.estado.pedidos.length;
    const idRoa = await mandar(token, 'reales-roa');
    const fRoa = repos.scannedInvoices.obtener(idRoa)!;
    const hRoa = encabezadoDe(idRoa);
    check("llega a 'lista' sin llamar a Ollama", fRoa.status === 'lista' && falso.estado.pedidos.length === pedidos0 && consultasOllama === 0);
    check('la hoja se leyó UNA sola vez (al recibirla; la cola usa esa lectura)', lector.lecturas === 1 && existsSync(join(dirFotos, idRoa, 'hoja-1.json')), `${lector.lecturas} lecturas`);
    check('renglones de la factura real', fRoa.lines.length === 5 && lineasDe(idRoa).every((r) => r.estado !== 'revisar'), `${fRoa.lines.length} renglones`);
    check('proveedor asociado por el CUIT impreso (cargado con guiones)', fRoa.supplierId === roa.id, String(fRoa.supplierId));
    check(
      'encabezado del texto: CUIT, razón social, número, fecha, letra y total',
      hRoa?.qr === false && hRoa.origen === 'texto' && hRoa.cuit === '27248159362' && hRoa.razonSocial === 'ROA DISTRIBUCIONES' && hRoa.ptoVta === 1 && hRoa.nroCmp === 17141 && hRoa.fecha === '2021-01-07' && hRoa.letra === 'B' && hRoa.importe === 27070,
      JSON.stringify(hRoa),
    );
    const detRoa = await servicio.obtener(idRoa);
    check('obtener: el encabezado llega a la pantalla con origen y razón social', detRoa.header?.origen === 'texto' && detRoa.header.razonSocial === 'ROA DISTRIBUCIONES' && detRoa.proveedor === 'Roa Distribuciones');

    console.log('\n[control de total y atajo a Compras]');
    let resRoa = await resumenDe(idRoa);
    check('la suma de los renglones coincide con el total leído', resRoa.totalCoincide === true && resRoa.total === 27070 && Math.abs(resRoa.sumaRenglones - 27070) <= 1 && resRoa.porRevisar === 0, JSON.stringify({ suma: resRoa.sumaRenglones, total: resRoa.total }));
    check('sin artículos vinculados no hay atajo', resRoa.listaParaCargar === false);
    const art = await repos.articles.create({ barcode: 'ROA-GENERICO', description: 'Artículo de prueba Roa', listPrice1: '100.0000', stock: '0.000' } as never);
    await servicio.guardar({ id: idRoa, lines: detRoa.lineas.map((r) => ({ ...r, articleId: art.id })) });
    resRoa = await resumenDe(idRoa);
    check('lista + proveedor + todo vinculado + nada en revisar + total coincide → atajo «Cargar en Compras»', resRoa.listaParaCargar === true);
    // Factura A (precios netos) con un descuento sin alícuota y la empresa en
    // precios con IVA: el descuento no se puede precargar en Compras → sin atajo.
    {
      const conDescuento = [
        ...detRoa.lineas.map((r) => ({ ...r, articleId: art.id })),
        { ...detRoa.lineas[0]!, articleId: art.id, codigo: null, descripcion: 'Producto extra', importe: 100, precioUnitario: 100, cantidad: 1 },
        { ...detRoa.lineas[0]!, articleId: null, codigo: null, descripcion: 'BONIFICACION', importe: -100, precioUnitario: -100, cantidad: 1, esDescuento: true, tasaIva: null },
      ];
      const headerA = { ...detRoa.header!, letra: 'A', tipoCmp: 1 };
      await servicio.guardar({ id: idRoa, header: headerA, lines: conDescuento });
      const rA = await resumenDe(idRoa);
      check('Factura A con descuento sin alícuota y empresa con IVA: NO hay atajo', rA.letra === 'A' && rA.listaParaCargar === false, JSON.stringify({ letra: rA.letra, lista: rA.listaParaCargar, coincide: rA.totalCoincide }));
      await servicio.guardar({ id: idRoa, header: detRoa.header, lines: detRoa.lineas.map((r) => ({ ...r, articleId: art.id })) });
      check('sin el descuento vuelve el atajo', (await resumenDe(idRoa)).listaParaCargar === true);
    }
    await servicio.guardar({ id: idRoa, lines: detRoa.lineas.slice(1).map((r) => ({ ...r, articleId: art.id })) });
    resRoa = await resumenDe(idRoa);
    check('falta un renglón: el total NO coincide, cuenta en «a revisar» y se va el atajo', resRoa.totalCoincide === false && resRoa.porRevisar === 1 && resRoa.listaParaCargar === false, JSON.stringify({ suma: resRoa.sumaRenglones, porRevisar: resRoa.porRevisar }));
    await servicio.guardar({ id: idRoa, supplierId: null, lines: detRoa.lineas.map((r) => ({ ...r, articleId: art.id })) });
    check('sin proveedor tampoco hay atajo', (await resumenDe(idRoa)).listaParaCargar === false && (await resumenDe(idRoa)).totalCoincide === true);
    await servicio.guardar({ id: idRoa, supplierId: roa.id, lines: detRoa.lineas.map((r, i) => ({ ...r, articleId: art.id, ...(i === 0 ? { estado: 'revisar' } : {}) })) });
    check('con un renglón en revisar tampoco', (await resumenDe(idRoa)).listaParaCargar === false);

    console.log('\n[proveedor que no existe: se ofrece crearlo; por nombre exacto se asocia]');
    const idBer = await mandar(token, 'reales-bernardi');
    const resBer = await resumenDe(idBer);
    check('sin proveedor con ese CUIT: queda sin asociar, con lo leído para crearlo', resBer.supplierId === null && resBer.proveedorLeido?.razonSocial === 'BERNARDI DISTRIBUCIONES S.R.L' && resBer.proveedorLeido.cuit === '33715137009', JSON.stringify(resBer.proveedorLeido));
    check('Factura B: 19 renglones y el total impreso coincide (diferencia de 1 centavo)', resBer.renglones === 19 && resBer.totalCoincide === true && resBer.letra === 'B', `${resBer.renglones} renglones, suma ${resBer.sumaRenglones}, total ${resBer.total}`);
    // «Crear proveedor» usa el alta de siempre con nombre y CUIT precargados: después de crearlo, lo encuentra por CUIT.
    const bernardi = await repos.suppliers.create({ code: 'P-BER', name: 'Bernardi Distribuciones SRL' } as never);

    console.log('\n[volver a leer: pasa el texto por el parser, sin leer la foto de nuevo]');
    const lecturasAntes = lector.lecturas;
    repos.scannedInvoices.actualizar(idBer, { lines: [], header: null });
    check('releer la manda a la cola', (await servicio.releer(idBer)) === 'en_cola');
    await servicio.esperarCola();
    const fBer = repos.scannedInvoices.obtener(idBer)!;
    check('vuelven los 19 renglones y el encabezado', fBer.status === 'lista' && fBer.lines.length === 19 && encabezadoDe(idBer)?.nroCmp === 19142);
    check('sin leer la foto otra vez (usa la lectura guardada) y sin Ollama', lector.lecturas === lecturasAntes && falso.estado.pedidos.length === pedidos0, `${lector.lecturas - lecturasAntes} lecturas`);
    check('proveedor sin CUIT cargado: se asocia por el nombre exacto (sin tipo de sociedad)', fBer.supplierId === bernardi.id, String(fBer.supplierId));
    rmSync(join(dirFotos, idBer, 'hoja-1.json'));
    await servicio.releer(idBer);
    await servicio.esperarCola();
    check('si falta la lectura guardada, lee la foto de nuevo', lector.lecturas === lecturasAntes + 1 && repos.scannedInvoices.obtener(idBer)!.lines.length === 19);
    await servicio.guardar({ id: idBer, lines: (await servicio.obtener(idBer)).lineas.map((r) => ({ ...r, articleId: art.id })) });
    check('Factura B completa: atajo', (await resumenDe(idBer)).listaParaCargar === true);
    await servicio.guardar({ id: idBer, header: { ...encabezadoDe(idBer), letra: null, tipo: null } });
    check('sin letra leída no hay atajo (no se sabe si los precios son netos o finales)', (await resumenDe(idBer)).totalCoincide === true && (await resumenDe(idBer)).listaParaCargar === false);
    await servicio.guardar({ id: idBer, header: { ...encabezadoDe(idBer), tipo: 'X' } });
    check('con el tipo elegido por el usuario, sí', (await resumenDe(idBer)).listaParaCargar === true);
    await servicio.guardar({ id: idRoa, supplierId: roa.id });
    await repos.company.upsert({ cuit: '27-24815936-2' });
    await servicio.releer(idRoa);
    await servicio.esperarCola();
    check('el CUIT del propio negocio nunca sale como el del proveedor', encabezadoDe(idRoa)?.cuit !== '27248159362', String(encabezadoDe(idRoa)?.cuit));
    check('y al releer no se pierde el proveedor que ya tenía la factura', repos.scannedInvoices.obtener(idRoa)!.supplierId === roa.id);
    await repos.company.upsert({ cuit: '20-24681357-5' });

    console.log('\n[calidad de la foto al recibirla]');
    const antes = lector.lecturas;
    const borrosa = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('borrosa-reales-roa'));
    check('foto borrosa → 422 FOTO con el motivo', borrosa.status === 422 && borrosa.json?.ok === false && borrosa.json.code === 'FOTO' && /borrosa u oscura/.test(String(borrosa.json.message)), `${borrosa.status} ${borrosa.texto}`);
    check('la hoja NO se agrega (ni se abre una factura)', servicio.estadoParaTelefono(token).factura?.estado !== 'recibiendo' && repos.scannedInvoices.listar({ estados: ['recibiendo'] }).length === 0);
    const cortada = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('corte-reales-alvinovino'));
    check('hoja cortada en el borde → 422 con el motivo', cortada.status === 422 && /Falta parte de la hoja a la izquierda/.test(String(cortada.json?.message)), `${cortada.status} ${cortada.texto}`);
    check('cada foto se leyó en el momento', lector.lecturas === antes + 2);
    const alvino = await repos.suppliers.create({ code: 'P-ALV', name: 'Al Vino Vino', cuit: '30-71249243-7' } as never);
    const idCorte = await mandar(token, 'corte-reales-alvinovino', true);
    const lCorte = lineasDe(idCorte);
    check('«Usar igual» (?forzar=1): se acepta y se lee sin volver a leer la foto', repos.scannedInvoices.obtener(idCorte)!.status === 'lista' && lCorte.length === 7 && lector.lecturas === antes + 3, `${lCorte.length} renglones, ${lector.lecturas - antes} lecturas`);
    check('los códigos de una hoja cortada quedan marcados como dudosos', lCorte.filter((r) => r.codigo).length === 7 && lCorte.every((r) => r.codigoDudoso === true), JSON.stringify(lCorte.map((r) => r.codigo)));
    check('proveedor por CUIT sin QR (letra no leída: sin tipo, sin atajo)', repos.scannedInvoices.obtener(idCorte)!.supplierId === alvino.id && encabezadoDe(idCorte)?.letra === null);
    const marcada = await servicio.marcarCargada({ id: idCorte, vinculos: lCorte.map((r) => ({ code: r.codigo!, articleId: art.id })) });
    check('marcarCargada NO recuerda códigos que pudieron quedar cortados', marcada.guardados === 0 && repos.articleSupplierCodes.listarPorProveedor(alvino.id).length === 0, `${marcada.guardados} guardados`);
    // La misma factura bien sacada: sí se recuerdan, y la siguiente sale vinculada sola.
    const idAlv = await mandar(token, 'reales-alvinovino');
    const lAlv = lineasDe(idAlv);
    check('hoja buena: códigos sin marca y total que coincide', lAlv.length === 7 && lAlv.every((r) => !r.codigoDudoso) && (await resumenDe(idAlv)).totalCoincide === true);
    check('el mismo comprobante escaneado dos veces: repetida, sin atajo', (await resumenDe(idAlv)).repetida === true && (await resumenDe(idAlv)).listaParaCargar === false);
    const bien = await servicio.marcarCargada({ id: idAlv, vinculos: lAlv.map((r) => ({ code: r.codigo!, articleId: art.id })) });
    check('hoja buena: los 7 códigos se recuerdan', bien.guardados === 7, `${bien.guardados}`);
    const idAlv2 = await mandar(token, 'reales-alvinovino');
    check('la siguiente del mismo proveedor sale vinculada sola', lineasDe(idAlv2).every((r) => r.articleId === art.id));
    const idCorte2 = await mandar(token, 'corte-reales-alvinovino', true);
    const detCorte2 = await servicio.obtener(idCorte2);
    check('…pero con la hoja cortada no se vincula sola: se ofrece como sugerencia', lineasDe(idCorte2).every((r) => r.articleId === null) && detCorte2.lineas.every((r) => r.articulo === null && r.sugerencias[0]?.id === art.id && r.codigoDudoso === true));

    console.log('\n[control completo de la hoja al recibirla: lecturas reales del lector del sistema]');
    // La foto bernardi-2 tiene luz, está nítida y entera (pasa el control básico),
    // pero la birome tapó dos descripciones: eso se ve recién al interpretarla.
    const antesControl = lector.lecturas;
    const b2 = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('sistema-bernardi-2'));
    check(
      'bernardi-2 (torcida, con cruces de birome): 422 FOTO que dice cuántos renglones quedaron sin descripción y qué hacer',
      b2.status === 422 && b2.json?.ok === false && b2.json.code === 'FOTO' && /^Se leyeron 19 renglones y 2 quedaron sin descripción\. Repita la foto con la hoja derecha, sin inclinar y sin sombras\.$/.test(String(b2.json.message)),
      `${b2.status} ${b2.texto}`,
    );
    check('la hoja NO se agrega (ni se abre una factura) y se leyó una sola vez', repos.scannedInvoices.listar({ estados: ['recibiendo'] }).length === 0 && lector.lecturas === antesControl + 1);
    const idB2 = await mandar(token, 'sistema-bernardi-2', true);
    const lB2 = lineasDe(idB2);
    check('«Usar igual» (?forzar=1): se acepta y la cola usa la lectura guardada al recibirla (no se lee dos veces)', repos.scannedInvoices.obtener(idB2)!.status === 'lista' && lector.lecturas === antesControl + 2, `${lector.lecturas - antesControl} lecturas`);
    check('salen los 19 renglones; los 2 sin descripción llegan en revisar con el motivo', lB2.length === 19 && lB2.filter((r) => r.descripcion === '' && r.estado === 'revisar' && /Sin descripción/.test(r.motivo ?? '')).length === 2 && lB2.filter((r) => r.estado === 'revisar').length === 2, `${lB2.length} renglones, ${lB2.filter((r) => r.estado === 'revisar').length} en revisar`);
    check('1023: la cantidad ya es de unidades (packResuelto) y no se le ponen UxB', lB2[0]?.codigo === '1023' && lB2[0].packResuelto === true && lB2[0].unidadesPorBulto === null && lB2[0].cantidad === 72, JSON.stringify(lB2[0] ?? null));
    const resB2 = await resumenDe(idB2);
    check('la suma coincide con el total impreso, la razón social sale completa y el proveedor se asocia', resB2.totalCoincide === true && encabezadoDe(idB2)?.razonSocial === 'BERNARDI DISTRIBUCIONES S.R.L' && encabezadoDe(idB2)?.ptoVta === 4 && encabezadoDe(idB2)?.nroCmp === 19142 && repos.scannedInvoices.obtener(idB2)!.supplierId === bernardi.id, JSON.stringify({ suma: resB2.sumaRenglones, total: resB2.total, rs: encabezadoDe(idB2)?.razonSocial }));
    const v13 = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('sistema-vital-13'));
    check('vital-13 (foto buena): se acepta sin aviso', v13.status === 200 && v13.json?.hojas === 1, `${v13.status} ${v13.texto}`);
    const idV13 = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    await servicio.esperarCola();
    check('y se lee entera con esa misma lectura', repos.scannedInvoices.obtener(idV13)!.status === 'lista' && lineasDe(idV13).length === 24 && lector.lecturas === antesControl + 3, `${lineasDe(idV13).length} renglones, ${lector.lecturas - antesControl} lecturas`);

    console.log('\n[«Mejorar lectura»]');
    est = await servicio.configurar({ mejorLectura: true });
    check('se activa sin apagar la función, y recién ahí se consulta a Ollama', est.mejorLectura === true && est.activo === true && est.ollama.disponible === true && est.lector.descargado === true && consultasOllama > 0);
    check('queda guardada', JSON.parse(readFileSync(join(dir, 'facturas-telefono.json'), 'utf8')).mejorLectura === true);
    const lecturasSistema = lector.lecturas;
    const pedidos1 = falso.estado.pedidos.length;
    falso.estado.pausa = 15;
    const lenta = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('borrosa-reales-roa'));
    check('con «Mejorar lectura» la PC no controla la foto al recibirla', lenta.status === 200 && lector.lecturas === lecturasSistema, `${lenta.status}`);
    const idLenta = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    for (let i = 0; i < 300 && repos.scannedInvoices.obtener(idLenta)?.status !== 'leyendo'; i++) await esperar(5);
    const tel = (await http(base, 'GET', `/lan/foto/${token}/estado`)).json?.factura as { estado: string; lento: boolean } | null;
    est = await servicio.estado();
    check('mientras lee: el teléfono y la PC saben que puede demorar', tel?.estado === 'leyendo' && tel.lento === true && est.cola.leyendo?.id === idLenta && est.cola.leyendo.lento === true && (await resumenDe(idLenta)).lecturaLenta === true, JSON.stringify(tel));
    await servicio.esperarCola();
    falso.estado.pausa = 0;
    check('la hoja la leyó Ollama, no el lector del sistema', repos.scannedInvoices.obtener(idLenta)!.status === 'lista' && falso.estado.pedidos.length === pedidos1 + 1 && lector.lecturas === lecturasSistema && lineasDe(idLenta).length === 5);
    check('el encabezado y el proveedor salen igual del texto', encabezadoDe(idLenta)?.cuit === '27248159362' && repos.scannedInvoices.obtener(idLenta)!.supplierId === roa.id);
    repos.scannedInvoices.actualizar(idLenta, { lines: [] });
    await servicio.releer(idLenta);
    await servicio.esperarCola();
    check('volver a leer con el mismo lector: no llama a Ollama de nuevo', lineasDe(idLenta).length === 5 && falso.estado.pedidos.length === pedidos1 + 1);
    await servicio.configurar({ mejorLectura: false });
    await servicio.releer(idLenta);
    await servicio.esperarCola();
    check('volver a leer después de cambiar de lector: relee la foto con el lector nuevo', lector.lecturas === lecturasSistema + 1 && falso.estado.pedidos.length === pedidos1 + 1 && repos.scannedInvoices.obtener(idLenta)!.status === 'lista');
    // «Mejorar lectura» sin el lector descargado no traba nada: lee el del sistema.
    falso.estado.modelos.delete(MODELO);
    await servicio.configurar({ mejorLectura: true });
    const idSinModelo = await mandar(token, 'reales-roa');
    check('«Mejorar lectura» sin el lector descargado: lee el lector del sistema', repos.scannedInvoices.obtener(idSinModelo)!.status === 'lista' && falso.estado.pedidos.length === pedidos1 + 1 && lineasDe(idSinModelo).length === 5);
    falso.estado.modelos.add(MODELO);
    await servicio.configurar({ mejorLectura: false });
  } finally {
    await servicio.apagar();
    await servidor.stop();
  }
}

/**
 * El lector del sistema dice «disponible» pero falla al leer (error del
 * programa auxiliar o salida vacía): sigue con Ollama sólo si está listo; si
 * no, error claro. Apagada la opción no se sondea NADA.
 */
async function parteFalloSistema(repos: ReturnType<typeof createRepositories>, adminId: string, dirBase: string, falso: OllamaFalso): Promise<void> {
  console.log('\n[lector del sistema que falla al leer]');
  const dir = join(dirBase, 'sistema-falla');
  mkdirSync(dir, { recursive: true });
  let modo: 'error' | 'vacio' = 'error';
  let sondeos = 0;
  let urlOllama = 'http://127.0.0.1:1';
  const lector: LectorDeHojas = {
    disponible: async () => {
      sondeos++;
      return true;
    },
    leerHoja: async () => {
      if (modo === 'error') throw new Error('powershell: tipo WinRT no encontrado');
      return { ancho: 1500, alto: 2000, textos: [] };
    },
  };
  let consultasOllama = 0;
  const servicio = new FacturasTelefono({
    userDataDir: dir,
    repos,
    cliente: () => {
      const c = new OllamaClient({ baseUrl: urlOllama });
      const version = c.version.bind(c);
      c.version = async () => {
        consultasOllama++;
        return version();
      };
      return c;
    },
    lectorSistema: lector,
    log: silencio,
    leerQr: () => null,
    limites: { pendientes: 1000 },
  });
  try {
    const est0 = await servicio.estado();
    check('apagada: estado() no ejecuta el lector del sistema ni consulta a Ollama', sondeos === 0 && consultasOllama === 0 && est0.lectorSistema.disponible === false, `${sondeos} sondeos, ${consultasOllama} consultas`);
    await servicio.configurar({ activo: true });
    const leer = async (marca: string): Promise<string> => {
      const { token } = servicio.crearSesion(adminId);
      // Sin texto, al recibirla se pide repetir la foto; el teléfono puede forzarla.
      await servicio.recibirFoto(token, fotoFalsa(marca), { forzar: modo === 'vacio' });
      const { id } = await servicio.cerrarFactura(token);
      await servicio.esperarCola();
      return id;
    };
    const id1 = await leer('reales-roa');
    const f1 = repos.scannedInvoices.obtener(id1)!;
    check('falla el lector y Ollama no está: error claro', f1.status === 'error' && /No se pudo leer la hoja con el lector del sistema/.test(f1.error ?? ''), `${f1.status}: ${f1.error}`);
    modo = 'vacio';
    const id2 = await leer('reales-roa');
    const f2 = repos.scannedInvoices.obtener(id2)!;
    check('salida vacía cuenta como falla: error claro', f2.status === 'error' && /lector del sistema/.test(f2.error ?? ''), `${f2.status}: ${f2.error}`);
    urlOllama = falso.url;
    falso.estado.modelos.add(MODELO);
    falso.estado.pausa = 0;
    falso.estado.textoDe = (marca) => fixture(marca.replace(/^reales-/, 'reales/'));
    const pedidos = falso.estado.pedidos.length;
    await servicio.releer(id2);
    await servicio.esperarCola();
    const f3 = repos.scannedInvoices.obtener(id2)!;
    check('con Ollama listo, la hoja que el lector del sistema no leyó se lee con Ollama', f3.status === 'lista' && falso.estado.pedidos.length === pedidos + 1 && f3.lines.length === 5, `${f3.status} ${f3.lines.length} renglones`);
  } finally {
    await servicio.apagar();
  }
}

/**
 * El vinculador enchufado al servicio y el ida y vuelta con Compras, con un
 * catálogo chico propio (otra base) y la factura real de ROA (proveedor que no
 * usa códigos). Orden: código del proveedor → código de barras → descripción
 * aprendida → parecido («Sugerido»). Lo sugerido cuenta para el atajo pero NO
 * se recuerda hasta que el usuario lo acepta; aceptado, la próxima factura
 * sale «Aprendido». Además: el catálogo se arma una vez, el proveedor sin CUIT
 * se sugiere por los otros nombres de la hoja y se le guarda el CUIT, la
 * factura repetida avisa "ya fue cargada el …" y «Crear artículo».
 */
async function parteVinculador(dirBase: string): Promise<void> {
  console.log('\n[vinculador: parecido «Sugerido», descripción «Aprendido», catálogo en caché]');
  const dir = join(dirBase, 'vinculador');
  mkdirSync(dir, { recursive: true });
  const { db } = initLocalDb(join(dir, 'v.db'));
  const repos = createRepositories(db);
  const admin = (await repos.users.findByUsername('admin'))!;
  const servicio = new FacturasTelefono({
    userDataDir: dir,
    repos,
    // Nadie escucha ahí: esta parte no usa Ollama.
    cliente: new OllamaClient({ baseUrl: 'http://127.0.0.1:9' }),
    lectorSistema: lectorSistemaFalso(),
    log: silencio,
    leerQr: () => null,
    limites: { pendientes: 1000, facturasPorSesion: 100 },
  });
  const lineasDe = (id: string): RenglonFactura[] => repos.scannedInvoices.obtener(id)!.lines as RenglonFactura[];
  const reloj = Date.now;
  try {
    await repos.company.upsert({ cuit: '20-24681357-5' });
    await servicio.configurar({ activo: true });
    // El proveedor está cargado con OTRO nombre (el de "Razón Social:" de la hoja) y sin CUIT.
    const fernandez = await repos.suppliers.create({ code: 'P-TAB', name: 'Fernandez Maria' } as never);
    const imperial = await repos.articles.create({ barcode: '7790001000011', description: 'Cerveza Imperial 1 L', costPrice: '1500.0000', listPrice1: '2500.0000', stock: '0.000' } as never);
    const heineken = await repos.articles.create({ barcode: '7790001000028', description: 'Cerveza Heineken 1 L', costPrice: '1600.0000', listPrice1: '2700.0000', stock: '0.000' } as never);
    const stout = await repos.articles.create({ barcode: '7790001000035', description: 'Cerveza Imperial Stout 500 cc', costPrice: '1700.0000', listPrice1: '1900.0000', stock: '0.000' } as never);
    const ipa = await repos.articles.create({ barcode: '7790001000042', description: 'Cerveza Imperial IPA lata 473', costPrice: '500.0000', listPrice1: '900.0000', stock: '0.000' } as never);
    // El espejo de una promoción con el mismo nombre: nunca es lo que trae un proveedor.
    await repos.articles.create({ barcode: 'PROMO-01', description: 'Cerveza Heineken 1 L', brand: 'PROMO', listPrice1: '5000.0000', stock: '0.000' } as never);

    console.log('\n[Compras sigue lo que manda el teléfono]');
    const { token, sesion } = servicio.crearSesion(admin.id);
    check('el enlace trae un identificador para seguirlo (no es el token)', /^[0-9a-f]{16}$/.test(sesion) && sesion !== token);
    let seg = servicio.seguir({ sesion });
    check('seguir: enlace vivo y todavía sin facturas', seg.sesionViva === true && seg.facturas.length === 0);
    await servicio.recibirFoto(token, fotoFalsa('reales-roa'));
    seg = servicio.seguir({ sesion });
    check('seguir: «Recibiendo hoja 1…»', seg.facturas.length === 1 && seg.facturas[0]?.estado === 'recibiendo' && textoDeSeguimiento(seg.facturas[0]) === 'Recibiendo hoja 1…', JSON.stringify(seg));
    const { id: r1 } = await servicio.cerrarFactura(token);
    await servicio.esperarCola();
    seg = servicio.seguir({ sesion });
    check('seguir: la factura de ESE enlace quedó lista', seg.facturas.length === 1 && seg.facturas[0]?.id === r1 && seg.facturas[0].estado === 'lista');
    check('seguir con un identificador que no existe: enlace muerto, sin facturas', servicio.seguir({ sesion: '0'.repeat(16) }).sesionViva === false && servicio.seguir({ sesion: 'x' }).facturas.length === 0);

    console.log('\n[al quedar lista: artículos sugeridos por parecido]');
    const l1 = lineasDe(r1);
    const porDesc = (texto: string): RenglonFactura | undefined => l1.find((r) => r.descripcion.includes(texto));
    check(
      '4 de 5 renglones quedan con el artículo SUGERIDO (la promo homónima no cuenta)',
      porDesc('HEINEKEN')?.articleId === heineken.id && porDesc('IMPERIAL X 1L')?.articleId === imperial.id && porDesc('STOUT')?.articleId === stout.id && porDesc('IPA')?.articleId === ipa.id && l1.filter((r) => r.sugerido === true).length === 4,
      JSON.stringify(l1.map((r) => [r.descripcion, r.articleId, r.sugerido])),
    );
    check('el que no tiene un artículo igual queda sin vínculo', porDesc('BARRIL')?.articleId === null && porDesc('BARRIL')?.sugerido === undefined);
    check('el catálogo del asociador se armó una vez', servicio.armadosDelCatalogo === 1, `${servicio.armadosDelCatalogo}`);
    let det = await servicio.obtener(r1);
    check('obtener: vinculadoPor «sugerido» y sin proveedor asociado', det.lineas.filter((r) => r.vinculadoPor === 'sugerido' && r.sugerido === true).length === 4 && det.supplierId === null);
    check('obtener sin cambios en el padrón: no se vuelve a armar el catálogo', servicio.armadosDelCatalogo === 1, `${servicio.armadosDelCatalogo}`);
    check('proveedor sin CUIT con otro nombre: se SUGIERE por los otros nombres de la hoja (no se asigna)', det.proveedoresSugeridos.some((p) => p.id === fernandez.id) && det.supplierId === null, JSON.stringify(det.proveedoresSugeridos));
    check('sin el barril no hay atajo', det.listaParaCargar === false);

    // Se carga el artículo que faltaba: el padrón cambió y la propuesta aparece al abrirla.
    const barril = await repos.articles.create({ barcode: '7790001000059', description: 'Cerveza Imperial Barril 30 L', costPrice: '5000.0000', listPrice1: '9000.0000', stock: '0.000' } as never);
    det = await servicio.obtener(r1);
    const lBarril = det.lineas.find((r) => r.descripcion.includes('BARRIL'));
    check('padrón nuevo → el catálogo se vuelve a armar y el barril sale «Sugerido»', servicio.armadosDelCatalogo === 2 && lBarril?.articulo?.id === barril.id && lBarril.vinculadoPor === 'sugerido', `${servicio.armadosDelCatalogo} ${JSON.stringify(lBarril?.articulo)}`);

    console.log('\n[proveedor elegido a mano sin CUIT: se le guarda el leído]');
    const cuit = cuitParaGuardar(fernandez, det.header?.cuit, await repos.suppliers.findAll());
    check('se ofrece guardar el CUIT leído en el proveedor elegido', cuit === '27248159362', String(cuit));
    await repos.suppliers.update(fernandez.id, { cuit: '27-24815936-2' } as never);
    det = await servicio.guardar({ id: r1, supplierId: fernandez.id });
    check('con proveedor y todo vinculado o sugerido con confianza: atajo', det.supplierId === fernandez.id && det.listaParaCargar === true && det.totalCoincide === true, JSON.stringify({ lista: det.listaParaCargar, coincide: det.totalCoincide }));
    const porId = new Map((await repos.articles.findAll()).map((a) => [a.id, a]));
    const articuloDe = (id: string) => {
      const a = porId.get(id);
      return a && a.active ? { alicuota: Number(a.vatRate), costo: Number(a.costPrice) } : null;
    };
    const atajo = decidirAtajo(det, 'gross', articuloDe);
    check('decidirAtajo: directo a Compras, los 5 marcados como sugeridos y sin vínculos para recordar', atajo.directo === true && atajo.pasaje.lineas.length === 5 && atajo.pasaje.sugeridos === 5 && atajo.pasaje.vinculos.length === 0, JSON.stringify(atajo.directo ? atajo.pasaje.vinculos : atajo.motivo));
    // Un cliente viejo que manda igual los vínculos sugeridos: el servidor no los recuerda.
    const sugeridas = lineasDe(r1).filter((r) => r.sugerido === true);
    const m1 = await servicio.marcarCargada({ id: r1, vinculos: sugeridas.map((r) => ({ code: claveDeVinculo(r)!, articleId: r.articleId! })) });
    check('marcarCargada no recuerda artículos sugeridos que nadie aceptó', m1.guardados === 0 && repos.articleSupplierCodes.listarPorProveedor(fernandez.id).length === 0, `${m1.guardados}`);
    const cargadaEl = (repos.scannedInvoices.obtener(r1)!.header as unknown as EncabezadoFactura).cargadaEl;
    check('la factura cargada anota cuándo se cargó', typeof cargadaEl === 'number' && Math.abs(cargadaEl - Date.now()) < 60_000);

    console.log('\n[la misma factura otra vez: "ya fue cargada el …"]');
    const r2 = await (async () => {
      const s = servicio.crearSesion(admin.id);
      await servicio.recibirFoto(s.token, fotoFalsa('reales-roa'));
      const { id } = await servicio.cerrarFactura(s.token);
      await servicio.esperarCola();
      return id;
    })();
    let det2 = await servicio.obtener(r2);
    check('con el CUIT guardado, la próxima factura se asocia sola al proveedor', det2.supplierId === fernandez.id);
    check('avisa que ya se cargó, con la fecha de la carga', det2.yaCargada?.origen === 'escaneada' && det2.yaCargada.fecha === cargadaEl && det2.repetida === true, JSON.stringify(det2.yaCargada));
    const noAtajo = decidirAtajo(det2, 'gross', articuloDe);
    check('ya cargada: no hay atajo, se abre la revisión con el aviso', !noAtajo.directo && /^Esta factura ya fue cargada el \d{2}\/\d{2}\/\d{4}\.$/.test(noAtajo.motivo), noAtajo.directo ? '' : noAtajo.motivo);
    check('con una compra registrada, la fecha es la de la compra', await (async () => {
      const conCompra = new FacturasTelefono({
        userDataDir: dir,
        repos: { ...repos, purchases: { findBySupplier: async () => [{ id: 'c1', type: 'B', number: 3, date: 1_700_000_000_000, createdAt: 1_790_000_000_000, total: '27070.0000', status: 'completed', supplierInvoiceNumber: '0001-00017141' }] } } as never,
        cliente: new OllamaClient({ baseUrl: 'http://127.0.0.1:9' }),
        log: silencio,
      });
      const d = await conCompra.obtener(r2);
      return d.yaCargada?.origen === 'compra' && d.yaCargada.fecha === 1_790_000_000_000;
    })());

    // El usuario acepta los sugeridos en la revisión y registra la compra.
    det2 = await servicio.guardar({ id: r2, lines: det2.lineas.map((r) => ({ ...r, sugerido: false })) });
    check('aceptados: pasan a elegidos («Elegido»)', det2.lineas.every((r) => r.vinculadoPor === 'guardado' && !r.sugerido));
    const pasaje2 = armarPasajeACompras(det2.lineas, 'B', 'gross', (id) => articuloDe(id)?.alicuota ?? null);
    const m2 = await servicio.marcarCargada({ id: r2, vinculos: pasaje2.vinculos });
    check('al registrar la compra se recuerdan las 5 descripciones para el proveedor', m2.guardados === 5 && repos.articleSupplierCodes.listarPorProveedor(fernandez.id).every((c) => c.code.startsWith('desc:')), `${m2.guardados}`);

    console.log('\n[la tercera: vinculada por la descripción aprendida]');
    const s3 = servicio.crearSesion(admin.id);
    await servicio.recibirFoto(s3.token, fotoFalsa('reales-roa'));
    const { id: r3 } = await servicio.cerrarFactura(s3.token);
    await servicio.esperarCola();
    const det3 = await servicio.obtener(r3);
    check('los 5 renglones salen vinculados por la descripción («Aprendido»), ninguno sugerido', det3.lineas.length === 5 && det3.lineas.every((r) => r.vinculadoPor === 'descripcion' && !r.sugerido && r.articulo !== null), JSON.stringify(det3.lineas.map((r) => r.vinculadoPor)));
    check('el más viejo manda en el aviso de ya cargada', det3.yaCargada?.fecha === cargadaEl);

    console.log('\n[la revisión devuelve la factura a Compras]');
    check('nadie la espera: aCompras no la manda (la revisión abre Compras como siempre)', servicio.enviarACompras(r3).recibe === false && servicio.seguir({ id: r3 }).facturas[0]?.enviadaACompras === null);
    servicio.seguir({ id: r3, esperaRevision: true });
    check('Compras la espera: aCompras avisa y Compras lo ve al sondear', servicio.enviarACompras(r3).recibe === true && typeof servicio.seguir({ id: r3 }).facturas[0]?.enviadaACompras === 'number');
    // Con varios puestos en red: la espera es de UNA pantalla de Compras (la
    // que abrió la revisión); otra revisión no le "devuelve" la factura.
    servicio.seguir({ id: r3, esperaRevision: true, pantalla: 'compras-a' });
    check('la espera es de una pantalla: otra pantalla (u otro puesto), o una revisión abierta desde la lista, no la recibe', servicio.enviarACompras(r3, 'compras-b').recibe === false && servicio.enviarACompras(r3).recibe === false);
    check('…la pantalla que la espera, sí', servicio.enviarACompras(r3, 'compras-a').recibe === true);
    Date.now = () => reloj() + 80_000;
    check('si Compras dejó de preguntar hace rato, ya no la espera', servicio.enviarACompras(r3).recibe === false);
    Date.now = reloj;
    await servicio.marcarCargada({ id: r3, vinculos: [] });
    check('cargada: se olvida el aviso y aCompras no la manda', servicio.seguir({ id: r3 }).facturas[0]?.enviadaACompras === null && servicio.enviarACompras(r3).recibe === false);

    console.log('\n[el código dice un artículo y el parecido otro: no se propone ninguno]');
    const oreo = await repos.articles.create({ barcode: '0100695', description: 'Galletitas Oreo 118 g', listPrice1: '800.0000', stock: '0.000' } as never);
    const atunSP = await repos.articles.create({ barcode: '7790001000066', description: 'Atun S&P desmenuzado en aceite 170 gr', listPrice1: '1300.0000', stock: '0.000' } as never);
    const s4 = servicio.crearSesion(admin.id);
    // Recorte de la tabla, sin membrete: el control de la foto lo ve inclinado. «Usar igual».
    await servicio.recibirFoto(s4.token, fotoFalsa('vital-12'), { forzar: true });
    const { id: v1 } = await servicio.cerrarFactura(s4.token);
    await servicio.esperarCola();
    const lv = lineasDe(v1)[0];
    let detV = await servicio.obtener(v1);
    check('código 0100695 (no EAN) de otro artículo + parecido con el atún: queda sin vínculo', lv?.codigo === '0100695' && lv.articleId === null && detV.lineas[0]?.articulo === null, JSON.stringify(lv));
    check('…y los dos se ofrecen: primero el del código, después el parecido', detV.lineas[0]?.sugerencias[0]?.id === oreo.id && detV.lineas[0]?.sugerencias.some((s) => s.id === atunSP.id) === true);
    await repos.articles.update(oreo.id, { barcode: 'OREO-118' } as never);
    await repos.articles.update(atunSP.id, { barcode: '0100695' } as never);
    detV = await servicio.obtener(v1);
    check('si el código y el parecido coinciden, sale «Sugerido»', detV.lineas[0]?.articulo?.id === atunSP.id && detV.lineas[0]?.vinculadoPor === 'sugerido');

    console.log('\n[crear artículo desde un renglón sin vínculo]');
    const iFideos = detV.lineas.findIndex((r) => r.descripcion.includes('SOLEIL'));
    const fideos = detV.lineas[iFideos]!;
    check('el renglón elegido no tiene vínculo ni sugerencia', iFideos >= 0 && fideos.articulo === null, JSON.stringify(fideos));
    const datos = datosArticuloNuevo(fideos, 'A', 'gross');
    check('lo precargado: descripción, sin código (el del proveedor no es EAN), costo con IVA', datos.barcode === '' && datos.description === fideos.descripcion && Number(datos.costPrice) === Math.round(fideos.precioUnitario! * 1.21 * 10000) / 10000, JSON.stringify(datos));
    const codigo = proximoCodigoInterno((await repos.articles.findAll()).map((a) => a.barcode));
    const nuevo = await repos.articles.create({ ...datos, barcode: codigo, supplierId: null, listPrice1: '0.0000' } as never);
    check('el alta de siempre lo acepta (código interno generado)', nuevo.barcode === codigo && nuevo.costPrice === datos.costPrice && nuevo.vatRate === '21.00', `${codigo} ${nuevo.costPrice}`);
    let repetido = false;
    await repos.articles.create({ ...datos, barcode: codigo } as never).catch(() => (repetido = true));
    check('el mismo código dos veces → error (el código es único)', repetido);
    detV = await servicio.guardar({ id: v1, lines: detV.lineas.map((r, i) => (i === iFideos ? { ...r, articleId: nuevo.id, sugerido: false } : r)) });
    check('el renglón queda vinculado al artículo nuevo («Elegido»)', detV.lineas[iFideos]?.articulo?.id === nuevo.id && detV.lineas[iFideos]?.vinculadoPor === 'guardado');

    console.log('\n[apagada]');
    await servicio.configurar({ activo: false });
    check('apagada: el enlace deja de valer y no hay nada que seguir de él', servicio.seguir({ sesion }).sesionViva === false && servicio.seguir({ sesion }).facturas.length === 0);
  } finally {
    Date.now = reloj;
    await servicio.apagar();
    closeLocalDb(db);
  }
}

async function main(): Promise<void> {
  parteLectorSuelto();

  const falso = await levantarOllamaFalso();
  await parteLector(falso);

  const dir = mkdtempSync(join(tmpdir(), 'facturas-'));
  const { db } = initLocalDb(join(dir, 'x.db'));
  const repos = createRepositories(db);
  const admin = (await repos.users.findByUsername('admin'))!;

  /** QR falso: la "foto" marcada `qr-…` trae un QR fiscal de este proveedor. */
  const QR: DatosQr = { fecha: '2026-09-30', cuit: '30712345671', ptoVta: 7, tipoCmp: 1, letra: 'A', nroCmp: 4521, importe: 150000.5, codAut: '76401234567890' };
  let lecturasQr = 0;
  const leerQr = (jpeg: Buffer): DatosQr | null => {
    lecturasQr++;
    return marcaDe(jpeg).startsWith('qr-') ? QR : null;
  };
  let urlOllama = falso.url;
  const servicio = new FacturasTelefono({
    userDataDir: dir,
    repos,
    cliente: () => new OllamaClient({ baseUrl: urlOllama }),
    log: silencio,
    leerQr,
  });
  const servidor = new ServidorFotos({ puerta: servicio, port: 0, host: '127.0.0.1', log: silencio });
  await servidor.start();
  const base = `http://127.0.0.1:${servidor.puerto}`;
  const dirFotos = join(dir, 'facturas-escaneadas');

  try {
    console.log('\n[apagado por defecto]');
    check('la configuración nace apagada', servicio.getConfig().activo === false && servicio.getConfig().modelo === MODELO);
    check('activo() es false', servicio.activo() === false);
    let lanzo = false;
    try {
      servicio.crearSesion(admin.id);
    } catch {
      lanzo = true;
    }
    check('apagado no entrega enlaces', lanzo);
    check('la ruta del teléfono contesta 404', (await http(base, 'GET', `/lan/foto/${'a'.repeat(32)}`)).status === 404);
    servicio.reanudar();
    await servicio.esperarCola();
    check('apagado no llama a Ollama', falso.estado.pedidos.length === 4, `${falso.estado.pedidos.length} pedidos (los 4 del lector suelto)`);

    console.log('\n[activar]');
    const avisos: boolean[] = [];
    servicio.alConfigurar = (c) => avisos.push(c.activo);
    let est = await servicio.configurar({ activo: true });
    check('queda activo y avisa para levantar la escucha', est.activo && avisos.join() === 'true');
    check('la configuración se guarda en facturas-telefono.json', JSON.parse(readFileSync(join(dir, 'facturas-telefono.json'), 'utf8')).activo === true);
    check('estado: Ollama disponible y lector descargado', est.ollama.disponible && est.lector.descargado && est.ollama.url === falso.url);
    check('estado: cola vacía', est.cola.enCola === 0 && est.cola.leyendo === null);

    console.log('\n[sesión del teléfono]');
    const { token, vence } = servicio.crearSesion(admin.id);
    check('token de 32 hex en minúsculas', /^[0-9a-f]{32}$/.test(token));
    check('vence a los 30 minutos', Math.abs(vence - Date.now() - 30 * 60_000) < 5000);
    check('validarToken acepta el token', servicio.validarToken(token));
    check('rechaza otro token, uno corto y uno en mayúsculas', !servicio.validarToken('0'.repeat(32)) && !servicio.validarToken('abc') && !servicio.validarToken(token.toUpperCase()));
    check('GET de la página → 200', (await http(base, 'GET', `/lan/foto/${token}`)).status === 200);
    const malo = await http(base, 'POST', `/lan/foto/${'f'.repeat(32)}/hoja`, fotoFalsa('x')).catch(() => ({ status: 404, json: null, texto: '' }));
    check('token malo → 404', malo.status === 404);
    const noJpeg = await http(base, 'POST', `/lan/foto/${token}/hoja`, Buffer.from('%PDF-1.4 esto no es una foto'));
    check('archivo que no es JPEG → 400', noJpeg.status === 400, String(noJpeg.json?.message));
    check('sin fotos todavía no hay factura', (await http(base, 'GET', `/lan/foto/${token}/estado`)).json?.factura === null);
    const sinHojas = await http(base, 'POST', `/lan/foto/${token}/cerrar`);
    check('cerrar sin hojas → 400 con texto claro', sinHojas.status === 400 && sinHojas.json?.message === 'La factura no tiene hojas', String(sinHojas.json?.message));

    console.log('\n[flujo completo: fotos → cerrar → cola → lista]');
    falso.estado.textoDe = (marca) => fixture(marca.replace(/^qr-/, ''));
    falso.estado.pausa = 2;
    falso.estado.pedidos.length = 0;
    falso.estado.maxEnCurso = 0;
    const h1 = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-12'));
    const h2 = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('buensol'));
    const h3 = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-13'));
    check('cada hoja contesta cuántas van', h1.json?.hojas === 1 && h2.json?.hojas === 2 && h3.json?.hojas === 3);
    const quitada = await http(base, 'POST', `/lan/foto/${token}/quitar`);
    check('quitar saca la última', quitada.json?.hojas === 2);
    const h3b = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-13'));
    check('y se puede volver a mandar', h3b.json?.hojas === 3);
    const recibiendo = (await http(base, 'GET', `/lan/foto/${token}/estado`)).json?.factura as { estado: string; hojas: number };
    check("mientras manda, la factura está 'recibiendo'", recibiendo.estado === 'recibiendo' && recibiendo.hojas === 3);
    check('todavía no aparece en la lista de la PC', (await servicio.listar()).length === 0);
    check('ni se llamó al lector', falso.estado.pedidos.length === 0);

    const cerrada = await http(base, 'POST', `/lan/foto/${token}/cerrar`);
    const id1 = String(cerrada.json?.id);
    check('cerrar devuelve el id', cerrada.status === 200 && id1.length > 10);
    const archivos = readdirSync(join(dirFotos, id1)).sort();
    check('las fotos quedan en userData/facturas-escaneadas/<id>/hoja-N.jpg', archivos.length === 3 && archivos.every((a) => /^hoja-\d+\.jpg$/.test(a)), archivos.join(', '));
    const repetida = await http(base, 'POST', `/lan/foto/${token}/cerrar`);
    check('repetir el cerrar (respuesta perdida) contesta lo mismo', repetida.json?.id === id1);
    const vistos: string[] = [];
    const final = await esperarFinal(base, token, vistos);
    check("el teléfono ve en_cola/leyendo → 'lista'", final === 'lista' && vistos.includes('leyendo'), vistos.join(' → '));
    await servicio.esperarCola();
    check('leyó las 3 hojas, de a una por vez', falso.estado.pedidos.length === 3 && falso.estado.maxEnCurso === 1, `${falso.estado.pedidos.length} pedidos, ${falso.estado.maxEnCurso} a la vez`);

    const f1 = repos.scannedInvoices.obtener(id1)!;
    const lineas1 = f1.lines as RenglonFactura[];
    const a = igualAEsperado(lineas1, 'vital-12');
    const b = igualAEsperado(lineas1, 'buensol', a.total);
    const c = igualAEsperado(lineas1, 'vital-13', a.total + b.total);
    check('renglones de la hoja 1 correctos', a.exactos === a.total, `${a.exactos}/${a.total}`);
    check('renglones de la hoja 2 correctos', b.exactos === b.total, `${b.exactos}/${b.total}`);
    check('renglones de la hoja 3 correctos', c.exactos === c.total, `${c.exactos}/${c.total}`);
    check('ni uno de más', lineas1.length === a.total + b.total + c.total, `${lineas1.length} renglones`);
    check('cada renglón sabe de qué hoja salió', lineas1[0]?.hoja === 1 && lineas1[lineas1.length - 1]?.hoja === 3);
    check('guarda el texto de cada hoja y las hojas leídas', f1.pagesText.length === 3 && f1.pagesDone === 3 && f1.pagesText[1] === fixture('buensol'));
    check('la creó el usuario que vinculó el teléfono', f1.createdBy === admin.id);
    // Sin QR el encabezado sale del texto. Estas hojas son recortes de la tabla
    // (sin membrete): no hay número, fecha ni total, y no se asocia proveedor.
    const h1txt = f1.header as { qr?: boolean; origen?: string; nroCmp?: number | null; importe?: number | null } | null;
    check('sin QR: nada del QR, sin número ni total inventados, sin proveedor', (h1txt === null || (h1txt.qr === false && (h1txt.origen === 'texto' || h1txt.origen === null) && h1txt.nroCmp === null && h1txt.importe === null)) && f1.supplierId === null, JSON.stringify(f1.header));
    const res1 = (await servicio.listar()).find((f) => f.id === id1)!;
    check('sin total leído no hay control de total (ni atajo a Compras)', res1.totalCoincide === null && res1.listaParaCargar === false && res1.lecturaLenta === false);
    check('buscó el QR en las 3 hojas', lecturasQr === 3, `${lecturasQr}`);
    check('NO creó ninguna compra', (await repos.purchases.findAll()).length === 0);

    const lista = await servicio.listar();
    check('aparece en la lista como Lista', lista.length === 1 && lista[0]?.estado === 'lista' && lista[0]?.renglones === lineas1.length && lista[0]?.hojas === 3);

    console.log('\n[cargar otra factura con el mismo enlace: QR, proveedor y vínculos por código]');
    const proveedor = await repos.suppliers.create({ code: 'P-VITAL', name: 'Mayorista Vital', cuit: '30-71234567-1' } as never);
    const codigo0 = lineas1[0]!.codigo!;
    const codigo1 = lineas1[1]!.codigo!;
    const artBarras = await repos.articles.create({ barcode: codigo0, description: 'Atún desmenuzado 170 g', listPrice1: '1500.0000', stock: '0.000' } as never);
    const artAtun = await repos.articles.create({ barcode: '7790001112223', description: 'Atun trozos aceite abre facil 170g', listPrice1: '3000.0000', stock: '0.000' } as never);
    await repos.articles.create({ barcode: '7790001112224', description: 'Caballa al agua PUGLISI 380g', listPrice1: '5000.0000', stock: '0.000' } as never);

    // El código de la factura es el código INTERNO del proveedor: que coincida
    // con un código del padrón no alcanza para vincular solo (puede ser otro
    // producto). Se ofrece primero, y lo confirma el usuario.
    check('el código del proveedor no tiene forma de código de barras', !esCodigoDeBarras(codigo0), codigo0);
    let det = await servicio.obtener(id1);
    check('obtener: código que coincide con un código del padrón (no EAN) → NO se vincula solo', det.lineas[0]?.articulo === null && det.lineas[0]?.vinculadoPor === null && det.lineas[0]?.articleId === null);
    check('…pero ese artículo va primero en las sugerencias', det.lineas[0]?.sugerencias[0]?.id === artBarras.id);
    check('obtener: sin vínculo trae sugerencias por descripción (máx. 3)', det.lineas[1]?.articulo === null && det.lineas[1]?.sugerencias[0]?.id === artAtun.id && det.lineas[1]!.sugerencias.length <= 3, JSON.stringify(det.lineas[1]?.sugerencias.map((s) => s.description)));
    // La caballa coincide en marca, variedad y tamaño con un solo artículo (que
    // se cargó DESPUÉS de leer la factura): sale pre-vinculada, como «Sugerido».
    check('obtener: con un único artículo igual (marca, variedad y tamaño) queda «Sugerido»', det.lineas[2]?.articulo?.description.includes('PUGLISI') === true && det.lineas[2]?.vinculadoPor === 'sugerido' && det.lineas[2]?.sugerido === true, JSON.stringify(det.lineas[2]?.articulo));

    // El usuario elige proveedor y vincula el segundo renglón; después carga en Compras.
    det = await servicio.guardar({
      id: id1,
      supplierId: proveedor.id,
      header: { letra: 'A', ptoVta: 7, nroCmp: 4520, fecha: '2026-09-29', importe: '1234.5', cualquierCosa: 'x' },
      lines: det.lineas.map((r, i) => (i === 1 ? { ...r, articleId: artAtun.id, sugerencias: undefined, campoRaro: 1 } : i === 0 ? { ...r, articleId: artBarras.id } : r)),
    });
    check('obtener: los renglones vinculados no llevan sugerencias', det.lineas[0]?.articulo?.id === artBarras.id && det.lineas[0]?.sugerencias.length === 0);
    check('guardar: proveedor y encabezado', det.supplierId === proveedor.id && det.proveedor === 'Mayorista Vital' && det.header?.nroCmp === 4520 && det.header?.importe === 1234.5);
    check('guardar: el renglón queda con el artículo elegido', det.lineas[1]?.articulo?.id === artAtun.id && det.lineas[1]?.vinculadoPor === 'guardado');
    const crudo = repos.scannedInvoices.obtener(id1)!;
    check('guardar: no se cuela ningún campo ajeno', !('campoRaro' in (crudo.lines[1] as object)) && !('sugerencias' in (crudo.lines[1] as object)) && !('cualquierCosa' in (crudo.header as object)));
    let noDeja = false;
    await servicio.guardar({ id: id1, supplierId: 'no-existe' }).catch(() => (noDeja = true));
    check('guardar: proveedor inexistente → error', noDeja);

    const cargada = await servicio.marcarCargada({
      id: id1,
      vinculos: [
        { code: codigo1, articleId: artAtun.id },
        { code: codigo0, articleId: artBarras.id },
        { code: 'XX', articleId: 'no-existe' },
      ],
    });
    check('marcarCargada: recuerda el código del proveedor', repos.articleSupplierCodes.buscar(proveedor.id, codigo1)?.articleId === artAtun.id);
    check('marcarCargada: recuerda también el código que coincide con el del artículo (no es un EAN) y saltea artículos inexistentes', cargada.guardados === 2 && repos.articleSupplierCodes.listarPorProveedor(proveedor.id).length === 2 && repos.articleSupplierCodes.buscar(proveedor.id, codigo0)?.articleId === artBarras.id);
    check('marcarCargada: la factura queda Cargada', repos.scannedInvoices.obtener(id1)?.status === 'cargada');
    check('marcarCargada: sigue sin crear compras', (await repos.purchases.findAll()).length === 0);
    let bloquea = false;
    try {
      servicio.descartar(id1);
    } catch {
      bloquea = true;
    }
    check('una factura cargada no se descarta ni se relee', bloquea && existsSync(join(dirFotos, id1)));

    // Segunda factura del mismo proveedor, por el mismo enlace ("Cargar otra factura").
    lecturasQr = 0;
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-15'));
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('qr-vital-12'));
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-14'));
    const id2 = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    check('es otra factura', id2 !== id1 && id2.length > 10);
    check("llega a 'lista'", (await esperarFinal(base, token)) === 'lista');
    await servicio.esperarCola();
    const det2 = await servicio.obtener(id2);
    check('QR: deja de buscar en la primera hoja que lo tiene', lecturasQr === 2, `${lecturasQr} lecturas`);
    check('QR: encabezado con letra, punto de venta, número, fecha y total', det2.header?.qr === true && det2.header.letra === 'A' && det2.header.ptoVta === 7 && det2.header.nroCmp === 4521 && det2.header.fecha === '2026-09-30' && det2.total === 150000.5);
    check('QR: proveedor encontrado por CUIT (guardado con guiones)', det2.supplierId === proveedor.id && det2.proveedor === 'Mayorista Vital');
    const n15 = ESPERADO['vital-15']!.length;
    const r0 = det2.lineas[n15];
    const r1 = det2.lineas[n15 + 1];
    check('la segunda factura sale vinculada sola por el código del proveedor', r1?.codigo === codigo1 && r1.articulo?.id === artAtun.id && r1.vinculadoPor === 'proveedor');
    check('y el otro también, ya confirmado por el usuario en la factura anterior', r0?.articulo?.id === artBarras.id && r0.vinculadoPor === 'proveedor');
    check('el vínculo queda guardado en el renglón', (repos.scannedInvoices.obtener(id2)!.lines as RenglonFactura[])[n15 + 1]?.articleId === artAtun.id);
    const v15 = igualAEsperado(det2.lineas, 'vital-15');
    const v14 = igualAEsperado(det2.lineas, 'vital-14', n15 + ESPERADO['vital-12']!.length);
    check('vital-15 (cantidad corregida, descuentos) correcta', v15.exactos === v15.total, `${v15.exactos}/${v15.total}`);
    check('vital-14 (tabla HTML) correcta', v14.exactos === v14.total, `${v14.exactos}/${v14.total}`);
    check('los descuentos no se vinculan con artículos', det2.lineas.filter((r) => r.esDescuento).every((r) => r.articulo === null && r.sugerencias.length === 0) && det2.lineas.some((r) => r.esDescuento));
    const res2 = (await servicio.listar()).find((f) => f.id === id2)!;
    // El total del QR (150.000,50) no es la suma de estas hojas: el control lo avisa y cuenta como una cosa más a revisar.
    check('resumen: suma de renglones; a revisar = renglones en revisar + el total que no coincide', Math.abs(res2.sumaRenglones - det2.lineas.reduce((t, r) => t + (r.importe ?? 0), 0)) < 0.01 && res2.totalCoincide === false && res2.porRevisar === det2.lineas.filter((r) => r.estado === 'revisar').length + 1 && !res2.listaParaCargar, `${res2.porRevisar} a revisar, coincide ${res2.totalCoincide}`);
    check('QR: el encabezado dice de dónde salió', det2.header?.origen === 'qr');

    console.log('\n[foto de una hoja]');
    const dataUrl = servicio.foto(id2, 2);
    check('devuelve la foto como data URL', dataUrl.startsWith('data:image/jpeg;base64,') && marcaDe(Buffer.from(dataUrl.split(',')[1]!, 'base64')) === 'qr-vital-12');
    let sinHoja = false;
    try {
      servicio.foto(id2, 9);
    } catch {
      sinHoja = true;
    }
    check('hoja inexistente → error', sinHoja);

    console.log('\n[el bucle del lector no arruina la factura]');
    falso.estado.bucle = true;
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-13'));
    const id3 = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    check("llega a 'lista' aunque Ollama corte por repetición", (await esperarFinal(base, token)) === 'lista');
    await servicio.esperarCola();
    falso.estado.bucle = false;
    const l3 = repos.scannedInvoices.obtener(id3)!.lines as RenglonFactura[];
    const v13 = igualAEsperado(l3, 'vital-13');
    check('con todos sus renglones y sin repetidos', v13.exactos === v13.total && l3.length === v13.total, `${v13.exactos}/${v13.total}, ${l3.length} renglones`);

    console.log('\n[Ollama no responde]');
    urlOllama = 'http://127.0.0.1:9'; // nadie escucha ahí
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-12'));
    const id4 = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    check("la factura queda en 'error'", (await esperarFinal(base, token)) === 'error');
    await servicio.esperarCola();
    const f4 = repos.scannedInvoices.obtener(id4)!;
    check('con un mensaje claro', /Ollama no está abierto/.test(f4.error ?? ''), f4.error ?? '');
    const telefono = (await http(base, 'GET', `/lan/foto/${token}/estado`)).json?.factura as { error: string };
    check('el teléfono ve el mismo mensaje, sin rutas ni direcciones', telefono.error === f4.error && !/[\\/]|127\.0/.test(telefono.error));
    check('las fotos NO se pierden', existsSync(join(dirFotos, id4, 'hoja-1.jpg')));
    est = await servicio.estado();
    check('estado: Ollama no disponible y último error', !est.ollama.disponible && !est.lector.descargado && est.ultimoError === f4.error);

    console.log('\n[volver a leer]');
    urlOllama = falso.url;
    check("releer la manda a la cola", (await servicio.releer(id4)) === 'en_cola');
    await servicio.esperarCola();
    const f4b = repos.scannedInvoices.obtener(id4)!;
    check("con Ollama de vuelta queda 'lista' y sin error", f4b.status === 'lista' && f4b.error === null && f4b.lines.length === ESPERADO['vital-12']!.length);

    // «Volver a leer» con el mismo lector: el texto ya leído pasa de nuevo por
    // el parser, sin pedirle otra vez las hojas a Ollama (tarda minutos).
    const pedidosAntes = falso.estado.pedidos.length;
    repos.scannedInvoices.actualizar(id4, { lines: [] });
    await servicio.releer(id4);
    await servicio.esperarCola();
    const f4r = repos.scannedInvoices.obtener(id4)!;
    check('volver a leer con el mismo lector: rearma los renglones del texto, sin llamar a Ollama', f4r.status === 'lista' && f4r.lines.length === ESPERADO['vital-12']!.length && falso.estado.pedidos.length === pedidosAntes, `${f4r.lines.length} renglones, ${falso.estado.pedidos.length - pedidosAntes} pedidos`);

    console.log('\n[falta descargar el lector]');
    falso.estado.modelos.delete(MODELO);
    // Sin texto leído (como una factura que quedó en error) sí hay que leer la foto.
    repos.scannedInvoices.actualizar(id4, { status: 'error', pagesText: [], pagesDone: 0 });
    await servicio.releer(id4);
    await servicio.esperarCola();
    const f4c = repos.scannedInvoices.obtener(id4)!;
    check("queda en 'error' pidiendo descargar el lector", f4c.status === 'error' && /Falta descargar el lector/.test(f4c.error ?? ''), f4c.error ?? '');
    check('estado: lector sin descargar', (await servicio.estado()).lector.descargado === false);
    const desc = servicio.descargarLector();
    check('descargarLector arranca y muestra el avance', desc?.modelo === MODELO);
    for (let i = 0; i < 100 && !(await servicio.estado()).lector.descargado; i++) await esperar(20);
    est = await servicio.estado();
    check('lo descarga (una sola vez)', est.lector.descargado && est.descarga === null && falso.estado.descargas === 1);
    await servicio.releer(id4);
    await servicio.esperarCola();
    check("y ahora se lee", repos.scannedInvoices.obtener(id4)?.status === 'lista');

    console.log('\n[descartar]');
    servicio.descartar(id4);
    check('borra las fotos del disco', !existsSync(join(dirFotos, id4)));
    check('ya no aparece en la lista', !(await servicio.listar()).some((f) => f.id === id4));
    let yaNo = false;
    await servicio.obtener(id4).catch(() => (yaNo = true));
    check('ni se puede abrir', yaNo);
    check('las otras facturas siguen con sus fotos', existsSync(join(dirFotos, id2, 'hoja-1.jpg')));

    console.log('\n[descartar mientras se lee]');
    falso.estado.pausa = 15;
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-12'));
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-13'));
    const id5 = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    for (let i = 0; i < 200 && repos.scannedInvoices.obtener(id5)?.status !== 'leyendo'; i++) await esperar(5);
    est = await servicio.estado();
    check('estado: muestra qué factura se está leyendo', est.cola.leyendo?.id === id5 && est.cola.leyendo.hojas === 2);
    servicio.descartar(id5);
    await servicio.esperarCola();
    falso.estado.pausa = 0;
    check('la lectura se corta y la factura queda descartada', repos.scannedInvoices.obtener(id5)?.status === 'descartada' && !existsSync(join(dirFotos, id5)));

    console.log('\n[tope de hojas]');
    for (let i = 0; i < 12; i++) await servicio.recibirFoto(token, fotoFalsa('vital-12'));
    const trece = await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('vital-12'));
    check('la hoja 13 se rechaza con texto claro', trece.status === 400 && trece.json?.message === 'La factura ya tiene 12 hojas', String(trece.json?.message));
    const id6 = repos.scannedInvoices.listar({ estados: ['recibiendo'] })[0]!.id;
    servicio.descartar(id6);
    check('se puede descartar una factura a medio enviar', !existsSync(join(dirFotos, id6)));

    console.log('\n[al reabrir la app]');
    // Una quedó a medio leer (con la hoja 1 ya leída) y otra a medio recibir.
    const colgada = repos.scannedInvoices.crear({ createdBy: admin.id });
    mkdirSync(join(dirFotos, colgada.id), { recursive: true });
    writeFileSync(join(dirFotos, colgada.id, 'hoja-1.jpg'), fotoFalsa('vital-12'));
    writeFileSync(join(dirFotos, colgada.id, 'hoja-2.jpg'), fotoFalsa('vital-13'));
    repos.scannedInvoices.actualizar(colgada.id, { status: 'leyendo', photos: ['hoja-1.jpg', 'hoja-2.jpg'], pagesText: [fixture('vital-12')], pagesDone: 1 });
    const aMedias = repos.scannedInvoices.crear({});
    mkdirSync(join(dirFotos, aMedias.id), { recursive: true });
    writeFileSync(join(dirFotos, aMedias.id, 'hoja-1.jpg'), fotoFalsa('vital-15'));
    repos.scannedInvoices.actualizar(aMedias.id, { photos: ['hoja-1.jpg'] });
    const vacia = repos.scannedInvoices.crear({});
    falso.estado.pedidos.length = 0;
    servicio.reanudar();
    await servicio.esperarCola();
    const retomada = repos.scannedInvoices.obtener(colgada.id)!;
    check("la que quedó 'leyendo' se termina de leer", retomada.status === 'lista' && retomada.lines.length === ESPERADO['vital-12']!.length + ESPERADO['vital-13']!.length);
    check('sin releer la hoja que ya estaba leída', falso.estado.pedidos.length === 2, `${falso.estado.pedidos.length} pedidos (1 de ésta + 1 de la otra)`);
    check('la que quedó a medio recibir con hojas se lee igual', repos.scannedInvoices.obtener(aMedias.id)?.status === 'lista');
    check('la que quedó vacía se descarta', repos.scannedInvoices.obtener(vacia.id)?.status === 'descartada');

    console.log('\n[vínculos: código de barras de verdad, quitar el vínculo, tipo X]');
    check('esCodigoDeBarras: EAN-13, UPC-A y EAN-8 con verificador bien', esCodigoDeBarras('4006381333931') && esCodigoDeBarras('036000291452') && esCodigoDeBarras('96385074'));
    check('esCodigoDeBarras: verificador mal, código corto o interno → no', !esCodigoDeBarras('4006381333932') && !esCodigoDeBarras('1050') && !esCodigoDeBarras('0100695') && !esCodigoDeBarras('016203711000x'));
    await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa('qr-vital-12'));
    const idR = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
    await esperarFinal(base, token);
    await servicio.esperarCola();
    let detR = await servicio.obtener(idR);
    const iAtun = detR.lineas.findIndex((r) => r.codigo === codigo1);
    check('sale vinculada sola por el código recordado', iAtun >= 0 && detR.lineas[iAtun]?.articulo?.id === artAtun.id);
    const artEan = await repos.articles.create({ barcode: '4006381333931', description: 'Mermelada durazno 454 g', listPrice1: '900.0000', stock: '0.000' } as never);
    const iOtro = detR.lineas.findIndex((r, i) => i !== iAtun && !r.esDescuento && r.articulo === null);
    detR = await servicio.guardar({
      id: idR,
      header: { ...detR.header, tipo: 'X', letra: null },
      lines: detR.lineas.map((r, i) =>
        i === iAtun ? { ...r, articleId: null, sinVinculo: true } : i === iOtro ? { ...r, codigo: '4006381333931', articleId: null } : r,
      ),
    });
    check('quitar el vínculo se conserva al guardar: el renglón NO vuelve a vincularse por el código', detR.lineas[iAtun]?.articulo === null && detR.lineas[iAtun]?.articleId === null && detR.lineas[iAtun]?.sinVinculo === true);
    check('…y el artículo quitado queda sólo como sugerencia', detR.lineas[iAtun]?.sugerencias[0]?.id === artAtun.id);
    check('…y sigue quitado al volver a abrir', (await servicio.obtener(idR)).lineas[iAtun]?.articulo === null);
    check('un código con forma de código de barras sí se vincula solo', detR.lineas[iOtro]?.articulo?.id === artEan.id && detR.lineas[iOtro]?.vinculadoPor === 'codigo');
    check('el tipo «Comprobante X» sobrevive al guardado', detR.header?.tipo === 'X' && detR.header.letra === null && (await servicio.obtener(idR)).header?.tipo === 'X');
    check('sin tipo elegido, el encabezado lo dice (vale la letra del QR)', det2.header?.tipo === null && det2.header.letra === 'A');
    detR = await servicio.guardar({ id: idR, lines: detR.lineas.map((r, i) => (i === iAtun ? { ...r, articleId: artAtun.id, sinVinculo: true } : r)) });
    check('al elegir un artículo se borra la marca de «sin vínculo»', detR.lineas[iAtun]?.articulo?.id === artAtun.id && !('sinVinculo' in (repos.scannedInvoices.obtener(idR)!.lines[iAtun] as object)));

    console.log('\n[el mismo comprobante dos veces]');
    const listaR = await servicio.listar();
    check('la lista marca las dos facturas con el mismo QR como repetidas', listaR.find((f) => f.id === idR)?.repetida === true && listaR.find((f) => f.id === id2)?.repetida === true);
    check('y no marca a las demás', listaR.find((f) => f.id === id1)?.repetida === false);
    check('el detalle también avisa', (await servicio.obtener(id2)).repetida === true && (await servicio.obtener(id1)).repetida === false);
    check('mismoNumeroDeFactura: con y sin ceros, con y sin punto de venta', mismoNumeroDeFactura('0007-00004520', 7, 4520) && mismoNumeroDeFactura('7-4520', 7, 4520) && mismoNumeroDeFactura('4520', 7, 4520) && mismoNumeroDeFactura('000700004520', 7, 4520) && mismoNumeroDeFactura('A 0007-00004520', 7, 4520));
    check('mismoNumeroDeFactura: otro número u otro punto de venta → no', !mismoNumeroDeFactura('0007-00004521', 7, 4520) && !mismoNumeroDeFactura('0008-00004520', 7, 4520) && !mismoNumeroDeFactura('', 7, 4520) && !mismoNumeroDeFactura(null, 7, 4520) && !mismoNumeroDeFactura('0007-00004520', 7, null));
    check('sin compras del proveedor, compraExistente es null', (await servicio.obtener(id1)).compraExistente === null);
    const compra = (n: string, status: string, invoice: string): Record<string, unknown> => ({ id: n, type: 'A', number: 12, date: 1_790_000_000_000, total: '1234.5000', status, supplierInvoiceNumber: invoice });
    const conCompras = (compras: Record<string, unknown>[]): FacturasTelefono =>
      new FacturasTelefono({ userDataDir: dir, repos: { ...repos, purchases: { findBySupplier: async () => compras } } as never, cliente: new OllamaClient({ baseUrl: falso.url }), log: silencio });
    const yaComprada = await conCompras([compra('c-anulada', 'voided', '0007-00004520'), compra('c-otra', 'completed', '0007-00009999'), compra('c-1', 'completed', '7-4520')]).obtener(id1);
    check('avisa la compra ya registrada con ese proveedor y número (no la anulada)', yaComprada.compraExistente?.id === 'c-1' && yaComprada.compraExistente.number === 12);
    check('una compra anulada con ese número no cuenta', (await conCompras([compra('c-anulada', 'voided', '0007-00004520')]).obtener(id1)).compraExistente === null);
    servicio.descartar(idR);
    check('descartada la repetida, la otra deja de figurar como repetida', (await servicio.listar()).find((f) => f.id === id2)?.repetida === false);

    console.log('\n[código aprendido: se compara la descripción antes de confiar en él]');
    // Los códigos de proveedor no tienen dígito verificador: uno mal leído al
    // aprenderlo es el código REAL de otro producto. Por eso con el código se
    // guarda cómo lo describió el proveedor, y la próxima factura lo compara.
    const descAtun = lineas1[1]!.descripcion; // "Atun S&P trozos aceite abre facil x170g" (codigo1 → artAtun)
    check('marcarCargada guardó la descripción con que se aprendió el código', repos.articleSupplierCodes.buscar(proveedor.id, codigo1)?.description === descAtun, String(repos.articleSupplierCodes.buscar(proveedor.id, codigo1)?.description));
    const textos: Record<string, string> = {
      'otro-producto': `${codigo1} 2 UN Fideos tallarin x500gr 100,00 200,00`,
      'mismo-producto': `${codigo1} 2 UN ${descAtun.replace('trozos', 'tr0zos')} 100,00 200,00`,
      'ean-debajo': `COCA COLA 2L 6 1.000,00 6.000,00\n${artEan.barcode}\nFANTA 2L 6 900,00 5.400,00\n7790895001234`,
    };
    falso.estado.textoDe = (marca) => {
      const m = marca.replace(/^qr-/, '');
      return textos[m] ?? fixture(m);
    };
    const leerTexto = async (marca: string): Promise<FacturaEscaneadaDetalleDTO> => {
      await http(base, 'POST', `/lan/foto/${token}/hoja`, fotoFalsa(`qr-${marca}`));
      const id = String((await http(base, 'POST', `/lan/foto/${token}/cerrar`)).json?.id);
      await esperarFinal(base, token);
      await servicio.esperarCola();
      return servicio.obtener(id);
    };
    const otro = await leerTexto('otro-producto');
    check('el mismo código con OTRA descripción no vincula solo: el artículo aprendido se ofrece primero', otro.supplierId === proveedor.id && otro.lineas[0]?.codigo === codigo1 && otro.lineas[0]?.articulo === null && otro.lineas[0]?.sugerencias[0]?.id === artAtun.id, JSON.stringify(otro.lineas[0]));
    const mismo = await leerTexto('mismo-producto');
    check('la misma descripción con un error de lectura (O→0) sigue vinculando por el código', mismo.lineas[0]?.articulo?.id === artAtun.id && mismo.lineas[0]?.vinculadoPor === 'proveedor', JSON.stringify(mismo.lineas[0]));
    const ean = await leerTexto('ean-debajo');
    check('código de barras impreso debajo de cada producto: queda dudoso y NO vincula solo aunque sea un EAN del padrón', ean.lineas.length === 2 && ean.lineas.every((r) => r.codigoDudoso === true && r.articulo === null) && ean.lineas[0]?.codigo === artEan.barcode && ean.lineas[0]?.sugerencias[0]?.id === artEan.id, JSON.stringify(ean.lineas.map((r) => [r.codigo, r.codigoDudoso, r.articulo?.id])));

    console.log('\n[la misma factura leída con QR y sin QR se reconoce igual]');
    // Segunda foto de la misma factura en la que el QR no se pudo leer: el
    // encabezado sale del texto (sin tipo de comprobante ni CAE), con el mismo
    // CUIT, punto de venta y número.
    await servicio.guardar({ id: mismo.id, header: { ...mismo.header, qr: false, origen: 'texto', tipoCmp: null, codAut: null } });
    check('sin QR (tipoCmp null, sin CAE) se reconoce como el mismo comprobante que la leída con QR', (await servicio.obtener(mismo.id)).repetida === true && (await servicio.obtener(mismo.id)).header?.tipoCmp === null);

    console.log('\n[la compra se registró con OTRO proveedor que el de la factura]');
    const otroProv = await repos.suppliers.create({ code: 'P-SUR', name: 'Distribuidora Sur SRL' } as never);
    const conOtro = await servicio.marcarCargada({ id: mismo.id, supplierId: otroProv.id, vinculos: [{ code: codigo1, articleId: artAtun.id }] });
    check('los códigos se aprenden para el proveedor de la COMPRA, con su descripción', conOtro.guardados === 1 && repos.articleSupplierCodes.buscar(otroProv.id, codigo1)?.articleId === artAtun.id && repos.articleSupplierCodes.buscar(otroProv.id, codigo1)?.description === mismo.lineas[0]!.descripcion, String(repos.articleSupplierCodes.buscar(otroProv.id, codigo1)?.description));
    check('…y la factura queda asociada a ese proveedor (así «ya cargada» la encuentra)', repos.scannedInvoices.obtener(mismo.id)?.supplierId === otroProv.id && repos.scannedInvoices.obtener(mismo.id)?.status === 'cargada');
    check('el proveedor original conserva lo suyo', repos.articleSupplierCodes.buscar(proveedor.id, codigo1)?.description === descAtun);
    await servicio.marcarCargada({ id: otro.id, supplierId: 'no-existe', vinculos: [] });
    check('un proveedor inexistente se ignora: la factura conserva el suyo', repos.scannedInvoices.obtener(otro.id)?.supplierId === proveedor.id);
    falso.estado.textoDe = (marca) => fixture(marca.replace(/^qr-/, ''));

    console.log('\n[topes de un enlace]');
    const dir2 = mkdtempSync(join(tmpdir(), 'facturas-topes-'));
    let licencia = true;
    const topes = new FacturasTelefono({
      userDataDir: dir2,
      repos,
      cliente: () => new OllamaClient({ baseUrl: falso.url }),
      log: silencio,
      leerQr: () => null,
      licenciaActiva: () => licencia,
      limites: { vidaMaximaSesionMs: 60 * 60_000, facturasPorSesion: 2, bytesPorSesion: 200, pendientes: 2 },
    });
    await topes.configurar({ activo: true });
    const mensajeDe = async (fn: () => Promise<unknown>): Promise<string> => fn().then(() => '', (e: Error) => e.message);
    const reloj = Date.now;
    try {
      // Vida máxima: el enlace se renueva al usarlo, pero no pasa de 60 minutos desde que se creó.
      const sA = topes.crearSesion(admin.id);
      Date.now = () => reloj() + 29 * 60_000;
      await topes.recibirFoto(sA.token, fotoFalsa('vital-12'));
      Date.now = () => reloj() + 58 * 60_000;
      check('usándolo, el enlace sigue vivo pasados los 30 minutos', topes.validarToken(sA.token));
      await topes.recibirFoto(sA.token, fotoFalsa('vital-12'));
      Date.now = () => reloj() + 61 * 60_000;
      check('pero no vive más que su vida máxima, aunque se lo siga usando', !topes.validarToken(sA.token));
      check('y ya no recibe fotos', /venció/.test(await mensajeDe(() => topes.recibirFoto(sA.token, fotoFalsa('vital-12')))));
      Date.now = reloj;
      for (const f of repos.scannedInvoices.listar({ estados: ['recibiendo'] })) topes.descartar(f.id);

      // Facturas por enlace.
      const sB = topes.crearSesion(admin.id);
      for (let i = 0; i < 2; i++) {
        await topes.recibirFoto(sB.token, fotoFalsa('vital-15'));
        await topes.cerrarFactura(sB.token);
      }
      await topes.esperarCola();
      const antes = repos.scannedInvoices.listar({ limite: 1000 }).length;
      const m3 = await mensajeDe(() => topes.recibirFoto(sB.token, fotoFalsa('vital-15')));
      check('la tercera factura del mismo enlace se rechaza (tope 2)', /ya cargó 2 facturas/.test(m3) && repos.scannedInvoices.listar({ limite: 1000 }).length === antes, m3);

      // Bytes por enlace (tope 200 en esta prueba).
      const sC = topes.crearSesion(admin.id);
      const gorda = Buffer.concat([fotoFalsa('vital-15'), Buffer.alloc(120)]);
      await topes.recibirFoto(sC.token, gorda);
      const mB = await mensajeDe(() => topes.recibirFoto(sC.token, gorda));
      check('pasado el tope de bytes del enlace, no se guarda otra foto', /demasiadas fotos/.test(mB) && readdirSync(join(dir2, 'facturas-escaneadas', repos.scannedInvoices.listar({ estados: ['recibiendo'] })[0]!.id)).length === 1, mB);

      // Facturas pendientes entre todos los enlaces (tope 2): la de sC está a medio mandar.
      const sD = topes.crearSesion(admin.id);
      await topes.recibirFoto(sD.token, fotoFalsa('vital-15'));
      const sE = topes.crearSesion(admin.id);
      const mP = await mensajeDe(() => topes.recibirFoto(sE.token, fotoFalsa('vital-15')));
      check('con la cola llena no se acepta otra factura', /demasiadas facturas esperando/.test(mP) && repos.scannedInvoices.listar({ estados: ['recibiendo'] }).length === 2, mP);

      console.log('\n[licencia en sólo lectura]');
      const servidor2 = new ServidorFotos({ puerta: topes, port: 0, host: '127.0.0.1', log: silencio });
      await servidor2.start();
      const base2 = `http://127.0.0.1:${servidor2.puerto}`;
      check('con licencia activa la página del teléfono abre', (await http(base2, 'GET', `/lan/foto/${sD.token}`)).status === 200);
      licencia = false;
      const fotosAntes = repos.scannedInvoices.obtener(repos.scannedInvoices.listar({ estados: ['recibiendo'] }).find((f) => f.photos.length === 1 && f.createdBy === admin.id)!.id)!.photos.length;
      const hojaSL = await http(base2, 'POST', `/lan/foto/${sD.token}/hoja`, fotoFalsa('vital-15'));
      const cerrarSL = await http(base2, 'POST', `/lan/foto/${sD.token}/cerrar`);
      check('sistema en sólo lectura: el teléfono recibe 404 al subir y al cerrar', hojaSL.status === 404 && cerrarSL.status === 404 && (await http(base2, 'GET', `/lan/foto/${sD.token}`)).status === 404);
      check('y no se escribió nada', repos.scannedInvoices.listar({ estados: ['recibiendo'] }).length === 2 && fotosAntes === 1 && repos.scannedInvoices.listar({ estados: ['en_cola', 'leyendo'] }).length === 0);
      check('ni se entregan enlaces nuevos', /sólo lectura/.test(await mensajeDe(async () => topes.crearSesion(admin.id))));
      check('directo al servicio tampoco', /venció/.test(await mensajeDe(() => topes.recibirFoto(sD.token, fotoFalsa('vital-15')))));
      licencia = true;
      check('al volver la licencia, el mismo enlace sigue sirviendo', (await http(base2, 'POST', `/lan/foto/${sD.token}/hoja`, fotoFalsa('vital-15'))).status === 200);
      await servidor2.stop();

      console.log('\n[reanudar no toca lo de esta sesión]');
      const abiertas = repos.scannedInvoices.listar({ estados: ['recibiendo'] }).map((f) => f.id);
      topes.reanudar({ arrancar: false });
      check('las facturas que un teléfono vinculado está mandando siguen «recibiendo»', abiertas.length === 2 && abiertas.every((id) => repos.scannedInvoices.obtener(id)?.status === 'recibiendo'));
      const huerfana = repos.scannedInvoices.crear({});
      repos.scannedInvoices.actualizar(huerfana.id, { photos: ['hoja-1.jpg'] });
      topes.reanudar({ arrancar: false });
      check('la que quedó de una sesión anterior pasa a la cola, sin arrancar la lectura', repos.scannedInvoices.obtener(huerfana.id)?.status === 'en_cola');
      repos.scannedInvoices.actualizar(huerfana.id, { status: 'descartada', photos: [] });

      console.log('\n[limpieza de las cargadas viejas]');
      const vieja = repos.scannedInvoices.crear({});
      mkdirSync(join(dir2, 'facturas-escaneadas', vieja.id), { recursive: true });
      writeFileSync(join(dir2, 'facturas-escaneadas', vieja.id, 'hoja-1.jpg'), fotoFalsa('vital-12'));
      repos.scannedInvoices.actualizar(vieja.id, { status: 'cargada', photos: ['hoja-1.jpg'], pagesText: ['texto'], lines: [{ codigo: '1', descripcion: 'x' }] });
      topes.reanudar({ arrancar: false });
      check('una cargada reciente conserva sus fotos', existsSync(join(dir2, 'facturas-escaneadas', vieja.id, 'hoja-1.jpg')));
      db.$client.prepare('UPDATE scanned_invoices SET updated_at = ? WHERE id = ?').run(Date.now() - 91 * 24 * 60 * 60_000, vieja.id);
      topes.reanudar({ arrancar: false });
      const purgada = repos.scannedInvoices.obtener(vieja.id)!;
      check('pasados 90 días se borran las fotos y el texto, no el registro', !existsSync(join(dir2, 'facturas-escaneadas', vieja.id)) && purgada.status === 'cargada' && purgada.photos.length === 0 && purgada.pagesText.length === 0 && purgada.lines.length === 1);
      repos.scannedInvoices.actualizar(vieja.id, { status: 'descartada' });
      for (const id of abiertas) topes.descartar(id);
    } finally {
      Date.now = reloj;
      await topes.apagar();
      rmSync(dir2, { recursive: true, force: true });
    }

    console.log('\n[apagado, el estado no llama a Ollama]');
    let llamadas = 0;
    const contador = createServer((_req, res) => {
      llamadas++;
      res.setHeader('content-type', 'application/json');
      res.end('{"version":"0.0.0","models":[]}');
    });
    await new Promise<void>((r) => contador.listen(0, '127.0.0.1', r));
    const dir3 = mkdtempSync(join(tmpdir(), 'facturas-apagado-'));
    const apagadoSrv = new FacturasTelefono({ userDataDir: dir3, repos, cliente: new OllamaClient({ baseUrl: `http://127.0.0.1:${(contador.address() as AddressInfo).port}` }), log: silencio });
    const estApagado = await apagadoSrv.estado();
    check('con la opción apagada, estado() no hace ningún pedido a Ollama', llamadas === 0 && estApagado.activo === false && estApagado.ollama.disponible === false && estApagado.lector.descargado === false, `${llamadas} pedidos`);
    await apagadoSrv.configurar({ activo: true });
    const trasActivar = llamadas;
    await apagadoSrv.estado();
    await apagadoSrv.estado();
    check('activa sí consulta, y varias consultas seguidas no repiten el pedido', trasActivar > 0 && llamadas === trasActivar, `${trasActivar} → ${llamadas}`);
    check('el estado trae cuántas facturas hay listas (contador de Compras)', (await servicio.estado()).listas === (await servicio.listar()).filter((f) => f.estado === 'lista').length);
    await apagadoSrv.apagar();
    await new Promise<void>((r) => contador.close(() => r()));
    rmSync(dir3, { recursive: true, force: true });

    console.log('\n[el enlace vence]');
    const ahoraReal = Date.now;
    Date.now = () => ahoraReal() + 31 * 60_000;
    const vencido = servicio.validarToken(token);
    const pagina = await http(base, 'GET', `/lan/foto/${token}`);
    Date.now = ahoraReal;
    check('pasados los 30 minutos sin actividad, el token no vale', vencido === false && pagina.status === 404 && /venci/.test(pagina.texto));

    console.log('\n[canales IPC: sesión y permisos]');
    let rol: 'admin' | 'manager' | 'seller' | null = 'admin';
    let tunelEstado = 'apagado';
    const deps = {
      db,
      repos,
      userDataDir: dir,
      appVersion: 'test',
      sessionStore: {
        getSession: () => (rol ? { user: { id: admin.id, username: 'x', fullName: 'X', role: rol } } : null),
        getCurrentCashRegister: () => null,
      },
      facturas: servicio,
      lanExtras: { tunel: { estado: () => ({ estado: tunelEstado, direccion: 'https://local.mistockflow.com', ultimoError: null, desde: 0 }) } },
    } as unknown as HandlerDeps;
    const h = buildFacturasHandlers(deps);
    const llamar = async <T>(canal: string, payload?: unknown): Promise<IpcResponse<T>> => (await h[canal]!(payload)) as IpcResponse<T>;
    const CANALES = ['estado', 'configurar', 'descargarLector', 'vincular', 'seguir', 'aCompras', 'listar', 'obtener', 'foto', 'guardar', 'releer', 'descartar', 'marcarCargada'];
    check('están los 13 canales del diseño', CANALES.every((c) => typeof h[`facturas:${c}`] === 'function') && Object.keys(h).length === CANALES.length, Object.keys(h).join(', '));

    rol = null;
    const sinSesion = await Promise.all(CANALES.map((c) => llamar(`facturas:${c}`, { id: id2 })));
    check('sin sesión, todos → UNAUTHENTICATED', sinSesion.every((r) => !r.ok && r.code === 'UNAUTHENTICATED'));
    rol = 'seller';
    const vendedor = await Promise.all(CANALES.map((c) => llamar(`facturas:${c}`, { id: id2, hoja: 1, activo: false })));
    check('un vendedor (sin permiso de Compras) no entra a ninguno', vendedor.every((r) => !r.ok && r.code === 'PERMISSION_DENIED'), vendedor.map((r) => (r.ok ? 'ok' : r.code)).join(','));
    check('y la opción sigue activa', servicio.getConfig().activo);
    rol = 'manager';
    const enc = await llamar<FacturaEscaneadaResumenDTO[]>('facturas:listar');
    check('un encargado lista', enc.ok && enc.data.some((f) => f.id === id2));
    const encCfg = await llamar('facturas:configurar', { activo: false });
    const encDesc = await llamar('facturas:descargarLector');
    check('pero no configura ni descarga el lector', !encCfg.ok && encCfg.code === 'PERMISSION_DENIED' && !encDesc.ok && encDesc.code === 'PERMISSION_DENIED');

    rol = 'admin';
    servicio.servidorFotos = { puerto: 7790, error: null };
    const vinc = await llamar<FacturasVincularDTO>('facturas:vincular');
    const ip = elegirIpLocal();
    if (ip) {
      check('vincular: urlLocal con la IP de esta PC y el puerto 7790', vinc.ok && new RegExp(`^http://${ip.replace(/\./g, '\\.')}:7790/lan/foto/[0-9a-f]{32}$`).test(vinc.data.urlLocal ?? ''), vinc.ok ? String(vinc.data.urlLocal) : JSON.stringify(vinc));
      check('vincular: sin túnel, urlInternet es null', vinc.ok && vinc.data.urlInternet === null);
      check('vincular: el token del enlace sirve', vinc.ok && servicio.validarToken(vinc.data.urlLocal!.split('/').pop()!));
    } else {
      check('vincular: sin red ni túnel avisa (esta máquina no tiene red)', !vinc.ok && vinc.code === 'BUSINESS_RULE');
    }
    tunelEstado = 'conectado';
    const vincT = await llamar<FacturasVincularDTO>('facturas:vincular');
    check('vincular: con el túnel conectado da también el enlace por internet', vincT.ok && /^https:\/\/local\.mistockflow\.com\/lan\/foto\/[0-9a-f]{32}$/.test(vincT.data.urlInternet ?? ''), vincT.ok ? String(vincT.data.urlInternet) : '');
    check('vincular: los dos enlaces llevan el mismo token', vincT.ok && (!vincT.data.urlLocal || vincT.data.urlLocal.split('/').pop() === vincT.data.urlInternet!.split('/').pop()));

    check('vincular: trae el identificador para seguir el enlace', vincT.ok && /^[0-9a-f]{16}$/.test(vincT.data.sesion));
    const segIpc = await llamar<FacturasSeguimientoDTO>('facturas:seguir', { sesion: vincT.ok ? vincT.data.sesion : '', id: id2 });
    check('seguir por IPC: el enlace nuevo vive y la factura pedida por id viene', segIpc.ok && segIpc.data.sesionViva === true && segIpc.data.facturas.some((f) => f.id === id2), JSON.stringify(segIpc));
    const aCompIpc = await llamar<{ recibe: boolean }>('facturas:aCompras', { id: id2 });
    check('aCompras por IPC: sin una pantalla de Compras esperándola, recibe = false', aCompIpc.ok && aCompIpc.data.recibe === false);
    const aCompMal = await llamar('facturas:aCompras', { id: 'no-existe' });
    check('aCompras de una factura inexistente → error con texto', !aCompMal.ok && aCompMal.code === 'BUSINESS_RULE');

    const obt = await llamar<FacturaEscaneadaDetalleDTO>('facturas:obtener', { id: id2 });
    check('obtener por IPC', obt.ok && obt.data.lineas.length === det2.lineas.length && obt.data.header?.qr === true);
    const obtMal = await llamar('facturas:obtener', { id: 'no-existe' });
    check('factura inexistente → error con texto para el usuario', !obtMal.ok && obtMal.code === 'BUSINESS_RULE' && obtMal.message === 'La factura escaneada no existe.', JSON.stringify(obtMal));
    const fotoIpc = await llamar<{ dataUrl: string }>('facturas:foto', { id: id2, hoja: 1 });
    check('foto por IPC', fotoIpc.ok && fotoIpc.data.dataUrl.startsWith('data:image/jpeg;base64,'));
    const guardarMal = await llamar('facturas:guardar', { id: id1, lines: [] });
    check('guardar sobre una factura ya cargada → error', !guardarMal.ok && guardarMal.code === 'BUSINESS_RULE');
    const g = await llamar<FacturaEscaneadaDetalleDTO>('facturas:guardar', { id: id2, lines: [{ codigo: 'A1', descripcion: 'Uno', cantidad: '2', precioUnitario: 10, importe: 20, estado: 'ok' }] });
    check('guardar por IPC normaliza los renglones', g.ok && g.data.lineas.length === 1 && g.data.lineas[0]?.cantidad === 2 && g.data.lineas[0]?.hoja === 1);
    const mc = await llamar<{ ok: true; guardados: number }>('facturas:marcarCargada', { id: id2, vinculos: [{ code: 'A1', articleId: artAtun.id }] });
    check('marcarCargada por IPC guarda el código', mc.ok && mc.data.guardados === 1 && repos.articleSupplierCodes.buscar(proveedor.id, 'A1')?.articleId === artAtun.id);
    const rel = await llamar('facturas:releer', { id: id3 });
    await servicio.esperarCola();
    check('releer por IPC', rel.ok && repos.scannedInvoices.obtener(id3)?.status === 'lista');
    const des = await llamar('facturas:descartar', { id: id3 });
    check('descartar por IPC borra las fotos', des.ok && !existsSync(join(dirFotos, id3)));
    const cfgMejor = await llamar<EstadoFacturasDTO>('facturas:configurar', { mejorLectura: true });
    check('configurar acepta «Mejorar lectura» sola, sin tocar si está activo', cfgMejor.ok && cfgMejor.data.mejorLectura === true && cfgMejor.data.activo === servicio.getConfig().activo && servicio.getConfig().mejorLectura === true);
    await llamar('facturas:configurar', { mejorLectura: false });
    check('y se apaga igual', servicio.getConfig().mejorLectura === false);
    const cfgMal = await llamar('facturas:configurar', {});
    check('configurar sin `activo` → error', !cfgMal.ok);

    const apagar = await llamar<EstadoFacturasDTO>('facturas:configurar', { activo: false });
    check('configurar(false): apaga y avisa para bajar la escucha', apagar.ok && apagar.data.activo === false && avisos.join() === 'true,false');
    check('apagado: los enlaces entregados dejan de valer', !servicio.validarToken(token) && (await http(base, 'GET', `/lan/foto/${token}`)).status === 404);
    const vincApagado = await llamar('facturas:vincular');
    check('apagado: vincular avisa que está desactivado', !vincApagado.ok && /desactivadas/.test(vincApagado.message), JSON.stringify(vincApagado));
    const sinServicio = buildFacturasHandlers({ ...deps, facturas: undefined } as HandlerDeps);
    const r = (await sinServicio['facturas:listar']!(undefined)) as IpcResponse<unknown>;
    check('sin servicio (una terminal) → error claro, no rompe', !r.ok && r.code === 'BUSINESS_RULE');

    console.log('\n[qué cruza la red]');
    for (const c of ['configurar', 'descargarLector']) {
      check(`facturas:${c} no pasa desde un puesto ni desde internet`, !lanServerAccepts(`facturas:${c}`) && !remotoAccepts(`facturas:${c}`));
    }
    for (const c of CANALES.filter((x) => x !== 'configurar' && x !== 'descargarLector')) {
      check(`facturas:${c} sí pasa desde un puesto`, lanServerAccepts(`facturas:${c}`) && remotoAccepts(`facturas:${c}`));
    }
    check('una terminal le pide las facturas al servidor', shouldRouteLan('facturas:listar', 'client') && !shouldRouteLan('facturas:listar', 'single'));
    const todos = buildAllHandlers({ ...deps, hardware: { getConfig: () => ({}) } } as unknown as HandlerDeps);
    check('los canales están en el registro general', CANALES.every((c) => typeof todos[`facturas:${c}`] === 'function'));

    await parteSistema(repos, admin.id, dir, falso);
    await parteFalloSistema(repos, admin.id, dir, falso);
    await parteVinculador(dir);

    console.log('\n[cierre]');
    await servicio.configurar({ activo: true });
    falso.estado.pausa = 15;
    const s2 = servicio.crearSesion(admin.id);
    await servicio.recibirFoto(s2.token, fotoFalsa('vital-12'));
    const { id: id7 } = await servicio.cerrarFactura(s2.token);
    for (let i = 0; i < 200 && repos.scannedInvoices.obtener(id7)?.status !== 'leyendo'; i++) await esperar(5);
    await servicio.apagar();
    await servicio.esperarCola();
    check('apagar corta la lectura y la factura vuelve a la cola para el próximo arranque', repos.scannedInvoices.obtener(id7)?.status === 'en_cola');
    check('apagado ya no acepta al teléfono', !servicio.validarToken(s2.token) && !servicio.activo());
  } finally {
    await servidor.stop();
    await falso.cerrar();
    closeLocalDb(db);
    rmSync(dir, { recursive: true, force: true });
  }

  // Coherencia con el parser: unir hojas da lo mismo que el servicio guardó (ya cubierto arriba), y el parser solo:
  check('unirHojas de dos fixtures = suma de sus renglones', unirHojas([fixture('vital-12'), fixture('vital-13')]).length === ESPERADO['vital-12']!.length + ESPERADO['vital-13']!.length);

  if (fallas > 0) {
    console.error(`\nTEST FACTURAS FALLÓ — ${fallas} check(s) con error.\n`);
    process.exit(1);
  }
  console.log('\n✅ TODO OK — TEST FACTURAS POR TELÉFONO\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n✗ Excepción durante el test de facturas:', err);
  process.exit(1);
});
