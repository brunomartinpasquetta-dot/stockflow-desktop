/**
 * Evalúa lecturas del lector del sistema (JSON de cajas: Mac o Windows) con el
 * MISMO pipeline de la app: interpretarLectura → armarRenglones → parsearTexto.
 *
 *   evaluar.mts <carpeta con <nombre>[sufijo].json> [sufijo] [--detalle]
 *
 * Imprime una tabla Markdown por foto: cajas, líneas, renglones leídos/esperados,
 * exactos (contra la planilla a mano cuando existe), revisar, sin descripción,
 * suma vs total leído, y el total esperado.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armarRenglones, interpretarLectura } from '/Users/brunopasquetta/dev/stockflow/apps/desktop/electron/facturas/lectorSistema.ts';
import { parsearTexto, totalesDelTexto, type RenglonLeido } from '/Users/brunopasquetta/dev/stockflow/apps/desktop/electron/facturas/parser.ts';

const [dir, sufijoArg, ...resto] = process.argv.slice(2);
if (!dir) {
  console.error('uso: evaluar.mts <carpeta> [sufijo] [--detalle]');
  process.exit(2);
}
const sufijo = sufijoArg && !sufijoArg.startsWith('--') ? sufijoArg : '';
const detalle = process.argv.includes('--detalle');

const FIX = '/Users/brunopasquetta/dev/stockflow/apps/desktop/electron/__tests__/fixtures/facturas';
interface Esperado {
  codigo: string | null;
  cantidad: number | null;
  unidadesPorBulto: number | null;
  descripcion: string;
  precioUnitario: number | null;
  importe: number | null;
}
const espSistema = JSON.parse(readFileSync(join(FIX, 'esperado.json'), 'utf8')) as Record<string, Esperado[]>;
const espReales = JSON.parse(readFileSync(join(FIX, 'reales', 'esperado.json'), 'utf8')) as Record<
  string,
  { encabezado: { total: number }; renglones?: Esperado[]; cantidadRenglones?: number; suma?: number; codigos?: string[] }
>;

/** Renglones y total esperados por foto (los de la consigna). */
const META: Record<string, { renglones: number; total: number }> = {
  alvinovino: { renglones: 7, total: 48122.16 },
  bernardi: { renglones: 19, total: 49519.4 },
  'bernardi-2': { renglones: 19, total: 49519.4 },
  roa: { renglones: 5, total: 27070 },
  'vital-12': { renglones: 23, total: 98286.05 },
  'vital-13': { renglones: 24, total: 64956.57 },
  'vital-14': { renglones: 33, total: 196903.24 },
  'vital-15': { renglones: 10, total: 59433.65 },
};
const FOTOS = Object.keys(META);

const cerca = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < 0.005;
const unidades = (r: { cantidad: number | null; unidadesPorBulto: number | null }): number | null =>
  r.cantidad === null ? null : r.cantidad * (r.unidadesPorBulto ?? 1);
const norma = (s: string): string => s.normalize('NFKD').replace(/[^\w ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
function parecido(a: string, b: string): number {
  const pa = new Set(norma(a).split(' ').filter((w) => w.length > 2));
  const pb = new Set(norma(b).split(' ').filter((w) => w.length > 2));
  if (pa.size === 0 || pb.size === 0) return 0;
  let n = 0;
  for (const w of pa) if (pb.has(w)) n++;
  return n / Math.max(pa.size, pb.size);
}
function emparejar(esp: Esperado[], leidos: RenglonLeido[]): Array<RenglonLeido | null> {
  const candidatos: Array<{ e: number; l: number; puntos: number }> = [];
  esp.forEach((e, ie) => {
    leidos.forEach((r, il) => {
      let puntos = 0;
      if (e.codigo && r.codigo && e.codigo.slice(-5) === r.codigo.slice(-5)) puntos += 3;
      if (cerca(r.importe, e.importe)) puntos += 2;
      if (cerca(r.precioUnitario, e.precioUnitario)) puntos += 2;
      puntos += parecido(e.descripcion, r.descripcion);
      if (puntos < 2) return;
      candidatos.push({ e: ie, l: il, puntos: puntos - Math.abs(ie - il) * 0.001 });
    });
  });
  candidatos.sort((a, b) => b.puntos - a.puntos);
  const de: Array<RenglonLeido | null> = esp.map(() => null);
  const usados = new Set<number>();
  const hechos = new Set<number>();
  for (const c of candidatos) {
    if (hechos.has(c.e) || usados.has(c.l)) continue;
    de[c.e] = leidos[c.l]!;
    hechos.add(c.e);
    usados.add(c.l);
  }
  return de;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const pesos = (n: number | null): string =>
  n === null ? '—' : n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Fila {
  foto: string;
  cajas: number;
  lineas: number;
  renglones: number;
  esperados: number;
  exactos: string;
  malSinAviso: number;
  revisar: number;
  sinDesc: number;
  suma: number;
  totalLeido: number | null;
  totalEsperado: number;
  cierra: string;
  nota: string;
}

const filas: Fila[] = [];
const detalles: string[] = [];
for (const foto of FOTOS) {
  const ruta = join(dir, `${foto}${sufijo}.json`);
  const meta = META[foto]!;
  if (!existsSync(ruta)) {
    filas.push({ foto, cajas: 0, lineas: 0, renglones: 0, esperados: meta.renglones, exactos: '—', malSinAviso: 0, revisar: 0, sinDesc: 0, suma: 0, totalLeido: null, totalEsperado: meta.total, cierra: '—', nota: 'sin archivo' });
    continue;
  }
  const crudo = readFileSync(ruta, 'utf8');
  let nota = '';
  let lectura;
  try {
    lectura = interpretarLectura(crudo);
  } catch (e) {
    filas.push({ foto, cajas: 0, lineas: 0, renglones: 0, esperados: meta.renglones, exactos: '—', malSinAviso: 0, revisar: 0, sinDesc: 0, suma: 0, totalLeido: null, totalEsperado: meta.total, cierra: '—', nota: `ilegible: ${(e as Error).message}` });
    continue;
  }
  let lineas = armarRenglones(lectura);
  // --normalizar: simula pegar los decimales que Windows corta en dos palabras
  // ("4.169, 28" → "4.169,28"; "21, oo" → "21,00") para medir cuánto del déficit es solo eso.
  if (process.argv.includes('--normalizar')) {
    lineas = lineas.map((l) =>
      l
        .replace(/(\d[.,])\s{1,2}([oO0][oO0])(?![\w])/g, '$100')
        .replace(/(\d[.,])\s{1,2}(\d{2})(?![\d.,])/g, '$1$2'),
    );
  }
  const texto = lineas.join('\n');
  const rs = parsearTexto(texto);
  const t = totalesDelTexto(texto);
  const suma = r2(rs.reduce((s, r) => s + (r.importe ?? 0), 0));
  const revisar = rs.filter((r) => r.estado === 'revisar').length;
  const sinDesc = rs.filter((r) => !r.descripcion || !r.descripcion.trim()).length;

  // Exactos contra la planilla a mano (vital-*: fixtures/esperado.json; alvinovino y roa: reales/esperado.json).
  const esp: Esperado[] | null = espSistema[foto] ?? espReales[foto]?.renglones ?? null;
  let exactos = '—';
  let malSinAviso = 0;
  if (esp) {
    const pares = emparejar(esp, rs);
    let n = 0;
    esp.forEach((e, i) => {
      const r = pares[i];
      if (!r) {
        detalles.push(`   · ${foto}: FALTA ${e.codigo ?? ''} ${e.descripcion}`);
        return;
      }
      const numeros = cerca(unidades(r), unidades(e)) && cerca(r.precioUnitario, e.precioUnitario) && cerca(r.importe, e.importe);
      if (numeros) n++;
      else if (r.estado !== 'revisar') {
        malSinAviso++;
        detalles.push(`   · ${foto}: MAL SIN AVISO (${r.estado}) ${e.descripcion}: esperado ${unidades(e)} × ${e.precioUnitario} = ${e.importe}; leído ${r.cantidad}×${r.unidadesPorBulto ?? 1} × ${r.precioUnitario} = ${r.importe}  [${r.original}]`);
      } else detalles.push(`   · ${foto}: revisar ${e.descripcion} → ${r.motivo}  [${r.original}]`);
    });
    const usados = new Set(pares.filter((r): r is RenglonLeido => r !== null));
    for (const r of rs) if (!usados.has(r)) detalles.push(`   · ${foto}: INVENTADO (${r.estado}) [${r.original}]`);
    exactos = `${n}/${esp.length}`;
  } else if (espReales[foto]?.codigos) {
    const cods = espReales[foto]!.codigos!;
    const leidos = rs.map((r) => r.codigo);
    const enOrden = JSON.stringify(leidos) === JSON.stringify(cods);
    const presentes = cods.filter((c) => leidos.includes(c)).length;
    exactos = `códigos ${presentes}/${cods.length}${enOrden ? ' en orden' : ''}`;
  }
  const cierra = t.total === null ? 'sin total' : Math.abs(suma - t.total) <= 0.05 ? 'sí' : `no (dif ${pesos(r2(suma - t.total))})`;
  filas.push({ foto, cajas: lectura.textos.length, lineas: lineas.length, renglones: rs.length, esperados: meta.renglones, exactos, malSinAviso, revisar, sinDesc, suma, totalLeido: t.total, totalEsperado: meta.total, cierra, nota });

  if (detalle) {
    const out: string[] = [`\n===== ${foto}${sufijo}  (${lectura.ancho}×${lectura.alto}, ${lectura.textos.length} cajas) =====`, '--- líneas ---', ...lineas, '--- renglones ---'];
    for (const r of rs) {
      out.push(
        `${String(r.codigo ?? '').padStart(10)} ${String(r.cantidad ?? '').padStart(8)} ${String(r.precioUnitario ?? '').padStart(10)} ${String(r.importe ?? '').padStart(12)}  ${r.estado.padEnd(9)} ${r.descripcion || '(sin descripción)'}${r.motivo ? ` · ${r.motivo}` : ''}`,
      );
    }
    out.push(`suma ${suma}  total leído ${t.total}`);
    writeFileSync(join(dir, `${foto}${sufijo}.detalle.txt`), out.join('\n') + '\n', 'utf8');
  }
}

console.log(`\n### ${dir}${sufijo ? ` (${sufijo})` : ''}\n`);
console.log('| Foto | Cajas | Líneas | Renglones (leídos/esperados) | Exactos | Mal sin aviso | Revisar | Sin descripción | Suma renglones | Total leído | Total real | Cierra |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const f of filas) {
  console.log(
    `| ${f.foto} | ${f.cajas} | ${f.lineas} | ${f.renglones}/${f.esperados} | ${f.exactos} | ${f.malSinAviso} | ${f.revisar} | ${f.sinDesc} | ${pesos(f.suma)} | ${pesos(f.totalLeido)} | ${pesos(f.totalEsperado)} | ${f.cierra}${f.nota ? ` (${f.nota})` : ''} |`,
  );
}
const tot = filas.reduce(
  (a, f) => ({ r: a.r + f.renglones, e: a.e + f.esperados, rev: a.rev + f.revisar, sd: a.sd + f.sinDesc, ok: a.ok + (f.cierra === 'sí' ? 1 : 0), mal: a.mal + f.malSinAviso }),
  { r: 0, e: 0, rev: 0, sd: 0, ok: 0, mal: 0 },
);
console.log(`\nTotal: ${tot.r}/${tot.e} renglones · ${tot.rev} en revisar · ${tot.sd} sin descripción · ${tot.mal} mal sin aviso · ${tot.ok}/${filas.length} hojas cierran contra el total impreso`);
if (detalles.length) console.log('\n' + detalles.join('\n'));
