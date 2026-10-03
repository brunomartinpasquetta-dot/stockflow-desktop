/**
 * Facturas por teléfono — lector de texto del SISTEMA (Apple Vision / Windows.Media.Ocr).
 * Fixtures: las cajas de texto reales que devolvió el lector para fotos de
 * celular (fixtures/facturas/sistema/*.json: Mac para las 8 fotos de muestras/,
 * `windows-*` = Windows.Media.Ocr en GitHub Actions) + la planilla correcta
 * (esperado.json, reales/esperado.json).
 *   cajas → armarRenglones → parsearTexto → comparar
 * Lo que NO puede pasar: un renglón con cantidad, precio o importe equivocado
 * que quede en 'ok' o 'corregido' (mal SIN aviso), ni un renglón que se pierda
 * en silencio (lo que no se entiende sale en 'revisar').
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ./node_modules/tsx/dist/cli.mjs electron/__tests__/facturas-sistema.smoke.ts
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { leerEncabezado } from '../facturas/encabezado';
import {
  LectorSistema,
  armarRenglones,
  calidadDeFoto,
  interpretarLectura,
  programaPorPlataforma,
  type LecturaSistema,
} from '../facturas/lectorSistema';
import { aLineas, MOTIVO_ILEGIBLE, MOTIVO_PEGADO, parsearTexto, totalesDelTexto, type RenglonLeido } from '../facturas/parser';

const here = dirname(fileURLToPath(import.meta.url));
const dirFixtures = join(here, 'fixtures', 'facturas');
const dirMuestras = join(here, '..', '..', '..', '..', 'tools', 'ocr-facturas', 'muestras');
const dirNative = join(here, '..', '..', 'native');

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

interface Esperado {
  codigo: string | null;
  cantidad: number | null;
  unidadesPorBulto: number | null;
  descripcion: string;
  precioUnitario: number | null;
  importe: number | null;
}
const esperado = JSON.parse(readFileSync(join(dirFixtures, 'esperado.json'), 'utf8')) as Record<string, Esperado[]>;
const leerFixture = (nombre: string): LecturaSistema =>
  JSON.parse(readFileSync(join(dirFixtures, 'sistema', `${nombre}.json`), 'utf8')) as LecturaSistema;

const cerca = (a: number | null, b: number | null): boolean => a !== null && b !== null && Math.abs(a - b) < 0.005;
const unidades = (r: { cantidad: number | null; unidadesPorBulto: number | null }): number | null =>
  r.cantidad === null ? null : r.cantidad * (r.unidadesPorBulto ?? 1);
const norma = (s: string): string =>
  s.normalize('NFKD').replace(/[^\w ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Palabras en común entre dos descripciones (0..1), para emparejar renglones repetidos. */
function parecido(a: string, b: string): number {
  const pa = new Set(norma(a).split(' ').filter((w) => w.length > 2));
  const pb = new Set(norma(b).split(' ').filter((w) => w.length > 2));
  if (pa.size === 0 || pb.size === 0) return 0;
  let n = 0;
  for (const w of pa) if (pb.has(w)) n++;
  return n / Math.max(pa.size, pb.size);
}

/**
 * Empareja cada renglón esperado con uno leído, sin repetir: primero por código
 * (últimos 5 dígitos: el borde de la foto puede comerse el primero), precio o
 * importe iguales; en el empate decide la descripción y después el orden.
 */
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

interface Medicion {
  hoja: string;
  total: number;
  exactos: number;
  revisar: number;
  faltan: number;
  malSinAviso: number;
  inventados: number;
  corregidos: number;
  codigosMal: number;
}

function medir(nombre: string, verboso = true, esp: Esperado[] = esperado[nombre]!): Medicion {
  const lectura = leerFixture(nombre);
  const lineas = armarRenglones(lectura);
  const texto = lineas.join('\n');
  const leidos = parsearTexto(texto);
  const pares = emparejar(esp, leidos);
  const m: Medicion = { hoja: nombre, total: esp.length, exactos: 0, revisar: 0, faltan: 0, malSinAviso: 0, inventados: 0, corregidos: 0, codigosMal: 0 };
  esp.forEach((e, i) => {
    const r = pares[i];
    if (!r) {
      m.faltan++;
      if (verboso) console.log(`   · ${nombre} FALTA: ${e.codigo ?? ''} ${e.descripcion}`);
      return;
    }
    const numeros = cerca(unidades(r), unidades(e)) && cerca(r.precioUnitario, e.precioUnitario) && cerca(r.importe, e.importe);
    // El código se exige (últimos 6 dígitos) sólo cuando la lectura lo trae completo.
    const codigoExigible = e.codigo !== null && texto.includes(e.codigo);
    const codigoOk = !codigoExigible || (r.codigo !== null && r.codigo.slice(-6) === e.codigo!.slice(-6));
    if (!codigoOk) m.codigosMal++;
    if (numeros && codigoOk) {
      m.exactos++;
      if (r.estado === 'corregido') m.corregidos++;
      if (r.estado === 'revisar') m.revisar++; // exacto pero igual pide revisión: no molesta, se cuenta
      return;
    }
    if (r.estado === 'revisar') {
      m.revisar++;
      if (verboso) console.log(`   · ${nombre} revisar: ${e.descripcion} → ${r.motivo}  [${r.original}]`);
      return;
    }
    if (!numeros) {
      m.malSinAviso++;
      console.log(
        `   · ${nombre} MAL SIN AVISO (${r.estado}): ${e.descripcion}\n       esperado ${unidades(e)} u × ${e.precioUnitario} = ${e.importe}\n       leído    ${r.cantidad}×${r.unidadesPorBulto ?? 1} × ${r.precioUnitario} = ${r.importe}  [${r.original}]`,
      );
    } else if (verboso) {
      console.log(`   · ${nombre} código distinto: esperado ${e.codigo}, leído ${r.codigo}  [${r.original}]`);
    }
  });
  const usados = new Set(pares.filter((r): r is RenglonLeido => r !== null));
  for (const r of leidos) {
    if (usados.has(r)) continue;
    m.inventados++;
    console.log(`   · ${nombre} INVENTADO (${r.estado}): ${r.original}`);
  }
  return m;
}

async function main(): Promise<void> {
  // --- 1. Renglones: cajas → líneas → renglones de compra ----------------------
  const hojas = ['vital-12', 'vital-13', 'vital-14', 'vital-15'];
  const mediciones = hojas.map((h) => medir(h));
  const suma = (k: keyof Omit<Medicion, 'hoja'>): number => mediciones.reduce((s, m) => s + m[k], 0);

  console.log('\nHoja        Exactos   Corregidos   Revisar   Faltan   Mal sin aviso   Inventados');
  for (const m of mediciones) {
    console.log(
      `${m.hoja.padEnd(11)} ${`${m.exactos}/${m.total}`.padEnd(9)} ${String(m.corregidos).padEnd(12)} ${String(m.revisar).padEnd(9)} ${String(m.faltan).padEnd(8)} ${String(m.malSinAviso).padEnd(15)} ${m.inventados}`,
    );
  }
  const total = suma('total');
  console.log(
    `${'TOTAL'.padEnd(11)} ${`${suma('exactos')}/${total}`.padEnd(9)} ${String(suma('corregidos')).padEnd(12)} ${String(suma('revisar')).padEnd(9)} ${String(suma('faltan')).padEnd(8)} ${String(suma('malSinAviso')).padEnd(15)} ${suma('inventados')}\n`,
  );

  check(suma('malSinAviso') === 0, 'ningún renglón con cantidad, precio o importe equivocado queda en ok/corregido', `mal sin aviso: ${suma('malSinAviso')}`);
  check(suma('exactos') >= 80, `renglones exactos ≥ 80/${total}`, `${suma('exactos')}/${total}`);
  check(suma('inventados') === 0, 'ningún renglón inventado', String(suma('inventados')));
  check(suma('faltan') === 0, 'ningún renglón perdido (lo que no cierra queda en revisar)', String(suma('faltan')));
  check(suma('codigosMal') === 0, 'códigos: cuando el código completo está en la lectura, es el del renglón', String(suma('codigosMal')));

  // --- 1b. Facturas reales del dueño leídas HOY con el lector del sistema -------
  //     (reales/esperado.json). Ninguna línea con importe se pierde en silencio.
  {
    interface EsperadoReal {
      encabezado: { razonSocial: string; numero: string; total: number };
      renglones?: Esperado[];
      cantidadRenglones?: number;
      suma?: number;
      codigos?: string[];
      descripciones?: Record<string, string>;
      cantidades?: Record<string, number>;
    }
    const reales = JSON.parse(readFileSync(join(dirFixtures, 'reales', 'esperado.json'), 'utf8')) as Record<string, EsperadoReal>;
    const sumaDe = (rs: RenglonLeido[]): number => Math.round(rs.reduce((s, r) => s + (r.importe ?? 0), 0) * 100) / 100;
    // alvinovino-v2: la misma foto leída con el binario de dos pasadas (3-oct): la
    // marca de lista "L5" llega partida ("L" + "5") y un precio con un punto de más ("1880.001.").
    for (const [nombre, clave] of [['alvinovino', 'alvinovino'], ['alvinovino-v2', 'alvinovino'], ['roa', 'roa'], ['bernardi', 'bernardi'], ['bernardi-2', 'bernardi-2']] as const) {
      const e = reales[clave]!;
      const texto = armarRenglones(leerFixture(nombre)).join('\n');
      const rs = parsearTexto(texto);
      const esperados = e.cantidadRenglones ?? e.renglones!.length;
      check(rs.length === esperados, `${nombre}.json: ${esperados} renglones (ninguno perdido ni inventado)`, `${rs.length}: ${rs.map((r) => r.codigo ?? r.descripcion.slice(0, 14)).join(', ')}`);
      const t = totalesDelTexto(texto);
      check(t.total !== null && Math.abs(sumaDe(rs) - t.total) <= 0.05, `${nombre}.json: la suma de los renglones es el total del texto`, `${sumaDe(rs)} / ${t.total}`);
      const h = leerEncabezado([texto]);
      check(h.razonSocial === e.encabezado.razonSocial && h.numero === e.encabezado.numero, `${nombre}.json: razón social "${e.encabezado.razonSocial}" y número ${e.encabezado.numero}`, `${h.razonSocial} ${h.numero}`);
    }
    const mV2 = medir('alvinovino-v2', true, reales.alvinovino!.renglones!);
    check(mV2.exactos === 7 && mV2.malSinAviso === 0, 'alvinovino-v2.json: los 7 renglones exactos (GASTOS DE ENVIO con "L 5" adelante y GIN BOMBAY con "1880.001.")', `${mV2.exactos}/7 exactos, ${mV2.malSinAviso} mal sin aviso`);

    // --- 1c. Lecturas de WINDOWS (Windows.Media.Ocr, GitHub Actions, motor en-US, con
    //     preproceso; run 37096394848). Windows pierde la parte entera de la cantidad
    //     ("7.00" → ".00", "4.00" → "00") y rompe importes ("2. n6,2A", "958, 6B").
    //     Lo que se exige: NINGÚN renglón perdido y 0 mal sin aviso. Que muchos
    //     queden en revisar está bien; lo que no está bien es perderlos.
    {
      const mRoa = medir('windows-roa', true, reales.roa!.renglones!);
      const textoRoa = armarRenglones(leerFixture('windows-roa')).join('\n');
      const rsRoa = parsearTexto(textoRoa);
      check(rsRoa.length === 5 && mRoa.faltan === 0 && mRoa.inventados === 0, 'windows-roa.json: 5 renglones (los dos con la cantidad leída ".00"/"00" no se pierden)', `${rsRoa.length}: ${rsRoa.map((r) => `${r.cantidad}×${r.precioUnitario} ${r.estado}`).join(', ')}`);
      check(mRoa.malSinAviso === 0, 'windows-roa.json: 0 mal sin aviso', String(mRoa.malSinAviso));
      check(mRoa.exactos === 5, 'windows-roa.json: 5/5 exactos (cantidades 7 y 4 deducidas por la cuenta)', `${mRoa.exactos}/5`);
      check(rsRoa[0]!.cantidad === 7 && rsRoa[0]!.estado === 'corregido' && /Cantidad calculada por el importe: 7/.test(rsRoa[0]!.motivo ?? ''), 'windows-roa: ".00 CERVEZA IMPERIAL … 1620.00 11340.00" → cantidad 7, corregido con motivo', JSON.stringify(rsRoa[0]));
      const tRoa = totalesDelTexto(textoRoa);
      check(tRoa.total === 27070 && Math.abs(sumaDe(rsRoa) - 27070) < 0.001, 'windows-roa.json: la suma de los renglones es el total impreso (27.070)', `${sumaDe(rsRoa)} / ${tRoa.total}`);

      const m13 = medir('windows-vital-13', false, esperado['vital-13']!);
      const rs13 = parsearTexto(armarRenglones(leerFixture('windows-vital-13')).join('\n'));
      console.log(`   windows-vital-13: ${rs13.length} renglones · ${m13.exactos} exactos · ${rs13.filter((r) => r.estado === 'revisar').length} en revisar · ${rs13.filter((r) => r.motivo === MOTIVO_ILEGIBLE).length} ilegibles · ${m13.malSinAviso} mal sin aviso`);
      check(rs13.length === 24, 'windows-vital-13.json: 24 renglones (ninguno perdido: lo que no se entiende sale vacío en revisar, en su lugar)', `${rs13.length}: ${rs13.map((r) => r.codigo ?? (r.descripcion || '·').slice(0, 10)).join(', ')}`);
      check(m13.malSinAviso === 0, 'windows-vital-13.json: 0 mal sin aviso', String(m13.malSinAviso));
      check(rs13.every((r) => r.estado === 'revisar' || (r.descripcion !== '' && r.cantidad !== null && r.importe !== null)), 'windows-vital-13: todo lo que no está en revisar tiene descripción, cantidad e importe');
      check(rs13.filter((r) => r.motivo === MOTIVO_ILEGIBLE).every((r) => r.cantidad === null && r.precioUnitario === null && r.importe === null), 'windows-vital-13: los renglones ilegibles no traen ningún número inventado');
      const sopa = rs13.find((r) => /Sopa crema KNORR/.test(r.descripcion));
      check(!!sopa && sopa.estado === 'revisar' && sopa.cantidad === 1 && sopa.importe === 2276.24 && /Importe ilegible \(2\. n6,2A\)/.test(sopa.motivo ?? ''), 'windows-vital-13: importe roto en dos tokens ("2. n6,2A") → revisar con el importe que da la cuenta (precio confirmado por el precio con IVA)', JSON.stringify(sopa ?? null));
      const toalla = rs13.find((r) => r.codigo === '0188730');
      check(!!toalla && toalla.estado === 'revisar' && toalla.precioUnitario === 4958.68 && toalla.importe === null && /precio calculado desde el precio con IVA/.test(toalla.motivo ?? ''), 'windows-vital-13 0188730: precio truncado ("4.958.") e importe roto → revisar, precio reconstruido desde el precio con IVA, sin importe', JSON.stringify(toalla ?? null));
    }

    // bernardi-2 en detalle: torcida, con cruces de birome que taparon dos descripciones.
    const e = reales['bernardi-2']!;
    const textoB2 = armarRenglones(leerFixture('bernardi-2')).join('\n');
    const rs = parsearTexto(textoB2);
    console.log('\n   bernardi-2   código  cantidad    precio     importe  estado     descripción · motivo');
    for (const r of rs) {
      console.log(
        `   ${String(r.codigo ?? '').padStart(14)} ${String(r.cantidad ?? '').padStart(9)} ${String(r.precioUnitario ?? '').padStart(9)} ${String(r.importe ?? '').padStart(11)}  ${r.estado.padEnd(9)}  ${r.descripcion || '(sin descripción)'}${r.motivo ? ` · ${r.motivo}` : ''}${r.packResuelto ? ` · packResuelto (${r.bultos} bultos)` : ''}`,
      );
    }
    console.log(`   ${'suma'.padStart(14)} ${String(sumaDe(rs)).padStart(32)}\n`);
    check(JSON.stringify(rs.map((r) => r.codigo)) === JSON.stringify(e.codigos), 'bernardi-2: los 19 códigos en orden', rs.map((r) => r.codigo).join(','));
    const porCodigo = new Map(rs.map((r) => [r.codigo, r]));
    let cantidadesBien = 0;
    for (const [cod, cant] of Object.entries(e.cantidades ?? {})) {
      const r = porCodigo.get(cod);
      if (r && r.cantidad === cant && r.unidadesPorBulto === null) cantidadesBien++;
      else console.log(`   · bernardi-2 ${cod}: cantidad esperada ${cant}, leída ${r ? `${r.cantidad} × ${r.unidadesPorBulto}` : 'falta'}`);
    }
    check(cantidadesBien === Object.keys(e.cantidades ?? {}).length, 'bernardi-2: las 19 cantidades son la columna Cantidad (unidades), sin UxB', `${cantidadesBien}/19`);
    const r968 = porCodigo.get('968');
    const r969 = porCodigo.get('969');
    check(
      !!r968 && r968.descripcion === '' && r968.cantidad === 24 && r968.precioUnitario === 102.16 && r968.importe === 2451.85 && r968.estado === 'revisar' && /Sin descripción/.test(r968.motivo ?? ''),
      '968 (descripción tapada por la birome): código, cantidad 24, precio e importe; en revisar con el motivo de la descripción',
      JSON.stringify(r968 ?? null),
    );
    check(
      !!r969 && r969.descripcion === '' && r969.cantidad === 16 && r969.precioUnitario === 102.16 && r969.importe === 1634.56 && r969.estado === 'revisar' && /Sin descripción/.test(r969.motivo ?? ''),
      '969 (descripción tapada por la birome): ídem, cantidad 16',
      JSON.stringify(r969 ?? null),
    );
    for (const [cod, desc] of Object.entries(e.descripciones ?? {})) {
      const r = porCodigo.get(cod);
      check(!!r && r.descripcion === desc && r.estado === 'ok', `bernardi-2 ${cod}: "${desc}" en ok (la caja alta de SPEED va a su renglón, no al de 940)`, r ? `"${r.descripcion}" ${r.estado}` : 'falta');
    }
    check(Math.abs(sumaDe(rs) - e.suma!) < 0.001, `bernardi-2: suma de importes ${e.suma}`, String(sumaDe(rs)));
    check(porCodigo.get('1023')?.packResuelto === true && porCodigo.get('1023')?.bultos === 6, 'bernardi-2 1023: Bultos 6 × 12 (de "12X500") = Cantidad 72 → packResuelto (la pantalla no propone "× 12")', JSON.stringify(porCodigo.get('1023') ?? null));
    check(rs.every((r) => r.estado !== 'ok' || r.descripcion !== ''), 'bernardi-2: ningún renglón sin descripción queda en ok');
    check(leerEncabezado([textoB2]).razonSocial === 'BERNARDI DISTRIBUCIONES S.R.L', 'bernardi-2: razón social "BERNARDI DISTRIBUCIONES S.R.L" (con la letra "B" sola entre las dos líneas del nombre)', String(leerEncabezado([textoB2]).razonSocial));
    const dosProductos = parsearTexto('940  * SPEED CON CAFE 24X24  • POWERADE MOUNTAIN BLAST 6X500  6,00  36,00  52,95  1.906,19')[0]!;
    check(dosProductos.estado === 'revisar' && dosProductos.motivo === MOTIVO_PEGADO, 'dos productos en una línea (viñeta en el medio de la descripción) → revisar "Posible renglón pegado"', `${dosProductos.estado} · ${dosProductos.motivo}`);
    const unoSolo = parsearTexto('2394  - CERVEZA TEMPLE WOLF IPA 6XX473  4,00  24,00  123,75  2.969,92')[0]!;
    check(unoSolo.estado === 'ok' && unoSolo.descripcion === 'CERVEZA TEMPLE WOLF IPA 6XX473', 'una marca de birome ADELANTE de la descripción no es un renglón pegado (y no queda en la descripción)', `${unoSolo.estado} "${unoSolo.descripcion}"`);
    const soloNumeros = parsearTexto(['2396  CERVEZA TEMPLE SCOTTISH 6X473  4,00  24,00  123,75  2.969,92', '968  3,00  24,00  102,16  2.451,85', '976  POWERADE F.TROP. 6X500  6,00  36,00  52,95  1.906,19'].join('\n'));
    check(soloNumeros.length === 3 && soloNumeros[1]!.codigo === '968' && soloNumeros[1]!.cantidad === 24 && soloNumeros[1]!.estado === 'revisar', 'línea de sólo números entre renglones (código corto + cantidades + precio + importe) → renglón en revisar', JSON.stringify(soloNumeros[1] ?? null));
    check(parsearTexto('1 1.998,00 1.998,00').length === 0 && parsearTexto('21,00 346,76 1.998,00').length === 0, 'un pie sin rótulo (pocos números, o sin un entero adelante) no se vuelve renglón');

    // Regla general sobre TODOS los fixtures del lector: entre el primer y el
    // último renglón, ninguna línea con un importe con decimales y otro número
    // queda sin renglón (si no se entiende, sale en revisar; nunca se pierde).
    const esNumero = (t: string): boolean => /^-?\$?\d[\d.,]*\d-?$|^\d$/.test(t);
    const pareceRenglon = (l: string): boolean => {
      const toks = l.split(' ');
      return toks.filter(esNumero).length >= 2 && toks.some((t) => /\d[.,]\d{2}$/.test(t));
    };
    for (const archivo of readdirSync(join(dirFixtures, 'sistema')).filter((f) => f.endsWith('.json')).sort()) {
      const nombre = archivo.replace(/\.json$/, '');
      const lineas = aLineas(armarRenglones(leerFixture(nombre)).join('\n'));
      const renglones = parsearTexto(lineas.join('\n'));
      const conRenglon = new Set(renglones.map((r) => r.original));
      const indices = lineas.map((l, i) => (conRenglon.has(l) ? i : -1)).filter((i) => i >= 0);
      const primero = indices[0] ?? -1;
      const ultimo = indices[indices.length - 1] ?? -1;
      const perdidas = lineas.filter((l, i) => i > primero && i < ultimo && !conRenglon.has(l) && pareceRenglon(l));
      check(perdidas.length === 0, `${nombre}.json: ninguna línea con importe entre renglones queda sin renglón (${indices.length} renglones)`, perdidas.join(' | '));
      // Un renglón de descuento (marca PR o un importe negativo con el signo
      // pegado) nunca sale con el importe o el precio en positivo.
      const positivos = renglones.filter((r) => (/\sPR$/.test(r.original) || /(^|\s)-\d[\d.,]*,\d{2}(\s|$)/.test(r.original)) && ((r.importe ?? 0) > 0 || (r.precioUnitario ?? 0) > 0));
      check(positivos.length === 0, `${nombre}.json: ningún renglón de descuento (PR o importe negativo pegado) queda en positivo`, positivos.map((r) => `${r.estado} ${r.precioUnitario} ${r.importe} [${r.original}]`).join(' | '));
    }
  }

  // --- 2. Renglones armados ------------------------------------------------------
  {
    const l14 = armarRenglones(leerFixture('vital-14'));
    const fila = (cod: string): string => l14.find((l) => l.includes(cod)) ?? '';
    check(/^0183509\b.*Acond PLUSBELLE.*4\.169,28$/.test(fila('0183509')), 'vital-14: el código queda en su renglón (hoja inclinada)', fila('0183509'));
    check(/Antitr DOVE duraz.*2\.147,93.*2599,00.*6\.443,79/.test(fila('0188760')), 'vital-14: renglones vecinos no se mezclan', fila('0188760'));
    check(/Antitr DOVE original.*5\.577,69.*16\.733,07/.test(fila('0179051')), 'vital-14: cada precio con su descripción', fila('0179051'));
    const l13 = armarRenglones(leerFixture('vital-13'));
    check(l13.some((l) => /^0189463\s+1 UN\s+SET BAÑO/.test(l)), 'vital-13: el primer código no se va al encabezado', l13.find((l) => l.includes('0189463')) ?? '');
    check(armarRenglones({ ancho: 100, alto: 100, textos: [] }).length === 0, 'lectura vacía → sin renglones');
    check(armarRenglones({ ancho: 0, alto: 0, textos: [{ t: 'hola', x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.1, h: 0.02, c: 1 }] }).join() === 'hola', 'lectura mínima no rompe');

    // La misma hoja girada 6° se arma igual (enderezado).
    const base = leerFixture('vital-13');
    const ang = (6 * Math.PI) / 180;
    const girar = (x: number, y: number): [number, number] => {
      const px = (x - 0.5) * base.ancho;
      const py = (y - 0.5) * base.alto;
      return [(px * Math.cos(ang) - py * Math.sin(ang)) / base.ancho + 0.5, (px * Math.sin(ang) + py * Math.cos(ang)) / base.alto + 0.5];
    };
    const girada: LecturaSistema = {
      ...base,
      textos: base.textos.map((c) => {
        const [x0, y0] = girar(c.x0, c.y0);
        const [x1, y1] = girar(c.x1, c.y1);
        return { ...c, x0, y0, x1, y1 };
      }),
    };
    const a = parsearTexto(l13.join('\n'));
    const b = parsearTexto(armarRenglones(girada).join('\n'));
    const mismos = a.length === b.length && a.every((r, i) => r.codigo === b[i]!.codigo && r.importe === b[i]!.importe && r.cantidad === b[i]!.cantidad);
    check(mismos, 'vital-13 girada 6°: salen los mismos renglones', `${a.length} vs ${b.length}`);
  }

  // --- 3. Control de la cuenta sobre texto del lector del sistema ---------------
  {
    const uno = (linea: string): RenglonLeido => parsearTexto(linea)[0]!;
    const pim = uno('0147134  3 UN  Pimenton ALICANTE x25gr  751,24  21,00  909,00  2.253,12');
    check(pim.estado === 'corregido' && pim.importe === 2253.72 && /2\.253,12/.test(pim.motivo ?? '') && /2\.253,72/.test(pim.motivo ?? ''), 'importe con un dígito mal + precio confirmado por el precio con IVA → corregido, con motivo', `${pim.estado} ${pim.importe} · ${pim.motivo}`);
    const sinTestigo = uno('0147134  3 UN  Pimenton ALICANTE x25gr  751,24  2.253,12');
    check(sinTestigo.estado === 'revisar', 'el mismo error SIN precio con IVA → revisar (no se sabe cuál número está mal)', `${sinTestigo.estado} · ${sinTestigo.motivo}`);
    const precioMal = uno('0189883  4.507,44  21,00  5575,00  x 13.822,32');
    check(
      precioMal.estado === 'revisar' && precioMal.precioUnitario === 4607.44 && precioMal.cantidad === 3 && /4\.507,44/.test(precioMal.motivo ?? '') && /^Sin descripción/.test(precioMal.motivo ?? ''),
      'precio con un dígito mal → corregido por el precio con IVA y el importe; sin descripción leída queda en revisar con los dos motivos',
      `${precioMal.estado} ${precioMal.cantidad} × ${precioMal.precioUnitario} · ${precioMal.motivo}`,
    );
    const precioMalConDesc = uno('0189883  Yerba x1kg  4.507,44  21,00  5575,00  x 13.822,32');
    check(precioMalConDesc.estado === 'corregido' && precioMalConDesc.precioUnitario === 4607.44 && precioMalConDesc.cantidad === 3, 'el mismo renglón con descripción → corregido', `${precioMalConDesc.estado} ${precioMalConDesc.cantidad} × ${precioMalConDesc.precioUnitario}`);
    const dosMal = uno('0189883  2 UN  Yerba x1kg  4.507,44  21,00  5575,00  13.822,32');
    check(dosMal.estado === 'revisar', 'precio mal y cantidad que tampoco coincide → revisar', `${dosMal.estado} · ${dosMal.motivo}`);
    const marca = uno('0188760  3 UN  Antitr DOVE x50ml  2.147,93  21,00  2599,00  x 6.443,79  OF');
    check(marca.estado === 'ok' && marca.cantidad === 3 && marca.importe === 6443.79, 'marca de birome entre el precio y el importe ("x 6.443,79") no rompe el renglón', JSON.stringify(marca));
    const menos = uno('0148287  3 UN  Toa fem x16u  2.819,21  21,00  3411,24  - 8.457,63');
    check(menos.importe === 8457.63 && !menos.esDescuento && menos.estado === 'corregido', 'tilde leída como signo menos delante del importe: no es un descuento (queda avisado)', `${menos.importe} ${menos.estado} · ${menos.motivo}`);
    const desc = uno('00239767  3 UN  ACEITES 10%  - 114,46  21,00  -138,50  - 343,39  PR');
    check(desc.esDescuento && desc.importe === -343.39 && desc.estado === 'ok', 'descuento de verdad (el precio con IVA trae el menos pegado) sigue en negativo', JSON.stringify(desc));
    const tapada = uno('0130455  DUN  Shampoo TRESEMME x500ml  5.784,30  21,00  6999,00  X 17.352,90  OF');
    check(tapada.cantidad === 3 && tapada.estado === 'corregido' && tapada.descripcion === 'Shampoo TRESEMME x500ml', 'cantidad tapada por la birome ("DUN") → calculada por el importe', `${tapada.cantidad} ${tapada.estado} "${tapada.descripcion}"`);
    const pegada = uno('0101737  3UN  Mayonesa NATURA x250gr  1.073,55  21,00  1299,00  3.220,65  OF');
    check(pegada.cantidad === 3 && pegada.estado === 'ok', 'cantidad pegada a la unidad ("3UN")', `${pegada.cantidad} ${pegada.estado}`);
    const bulto = uno('183417  BTO Arroz largo fino x500gr  566,12  21,00  685,01  5.661,20');
    check(bulto.cantidad === 1 && bulto.unidadesPorBulto === 10 && bulto.estado === 'corregido' && /10 unidades/.test(bulto.motivo ?? ''), 'bulto sin UxB leído → 1 bulto × (importe ÷ precio), corregido con motivo', `${bulto.cantidad}×${bulto.unidadesPorBulto} · ${bulto.motivo}`);
    const bultoUxb = uno('0175194  BTO Caldo KNORR x6u  10  1.230,58  21,00  1489,00  12.305,80');
    check(bultoUxb.cantidad === 1 && bultoUxb.unidadesPorBulto === 10 && bultoUxb.estado === 'corregido', 'bulto con UxB suelto antes del precio y sin cantidad → 1 × 10', `${bultoUxb.cantidad}×${bultoUxb.unidadesPorBulto}`);
    const cortado = uno('01966  1BTO Pure de tomate x520g:  12  561,16  21,00  679,00  .733,92  OF');
    check(cortado.importe === 6733.92 && cortado.cantidad === 1 && cortado.unidadesPorBulto === 12 && cortado.estado === 'corregido' && /\.733,92/.test(cortado.motivo ?? ''), 'importe cortado en el borde (".733,92") → reconstruido por la cuenta, con motivo', `${cortado.importe} ${cortado.estado} · ${cortado.motivo}`);
    const cortadoSinCant = uno('01966  BTO Pure de tomate x520g:  561,16  21,00  679,00  .733,92  OF');
    check(cortadoSinCant.estado === 'revisar' && cortadoSinCant.importe === null, 'importe cortado y sin cantidad → revisar, sin inventar el importe', `${cortadoSinCant.estado} ${cortadoSinCant.importe} · ${cortadoSinCant.motivo}`);
    const sinDesc = uno('0176159  2.171,70  21,00  2627,75  x 2.171,70');
    check(sinDesc.codigo === '0176159' && sinDesc.cantidad === 1 && sinDesc.descripcion === '' && sinDesc.estado === 'revisar' && /^Sin descripción/.test(sinDesc.motivo ?? ''), 'renglón sin descripción leída (sólo código y números) no se pierde: sale en revisar para leerla de la foto', JSON.stringify(sinDesc));
    const partido = uno('0128893  BTO Mayonesa sachet x125g  20  342,98  21,00  415, 01  6.859,60');
    check(partido.cantidad === 1 && partido.unidadesPorBulto === 20 && partido.precioUnitario === 342.98, 'decimales separados por el lector ("415, 01") se vuelven a unir', JSON.stringify(partido));
    const soloImporte = uno('0101741  Mayonesa NATURA d/p x1kg  4.433,88');
    check(soloImporte.estado === 'revisar' && soloImporte.codigo === '0101741', 'renglón con código y un solo importe → revisar (no se pierde)', JSON.stringify(soloImporte));
    const huerfano = parsearTexto('0183509\n1 UN  Acond PLUSBELLE x970ml  4.169,28  21,00  5044,83  * 4.169,28');
    check(huerfano.length === 1 && huerfano[0]!.codigo === '0183509' && huerfano[0]!.estado === 'ok', 'código solo en la línea de arriba → va al renglón siguiente', JSON.stringify(huerfano[0] ?? null));
    // Lectura real de hoy de vital-12.jpg: el importe salió "2:122,32" (era 2.722,32) y el renglón se perdía entero.
    const ilegible = uno('0115997  6 UN  Sal fina DOS ESTRELLAS x500gr  453,72  21,00  549,00  2:122,32  OF');
    check(
      ilegible.codigo === '0115997' && ilegible.cantidad === 6 && ilegible.precioUnitario === 453.72 && ilegible.importe === 2722.32 && ilegible.estado === 'revisar' && /Importe ilegible \(2:122,32\).*2\.722,32/.test(ilegible.motivo ?? '') && ilegible.descripcion === 'Sal fina DOS ESTRELLAS x500gr',
      'importe leído con un signo de más ("2:122,32") → el renglón no se pierde: revisar, con el importe que da la cuenta (precio confirmado por el precio con IVA)',
      JSON.stringify(ilegible),
    );
    const ilegibleSinTestigo = uno('0115997  6 UN  Sal fina DOS ESTRELLAS x500gr  453,72  2:122,32');
    check(ilegibleSinTestigo.estado === 'revisar' && ilegibleSinTestigo.importe === null && ilegibleSinTestigo.precioUnitario === 453.72 && /Importe ilegible/.test(ilegibleSinTestigo.motivo ?? ''), 'importe ilegible sin precio con IVA → revisar, sin inventar el importe', JSON.stringify(ilegibleSinTestigo));
    const horaAlFinal = uno('0012345  3 UN  Yerba x1kg  751,24  21,00  909,00  2.253,72  12:30');
    check(horaAlFinal.estado === 'ok' && horaAlFinal.importe === 2253.72, 'un número dañado DESPUÉS de una cuenta que cierra es una marca más', JSON.stringify(horaAlFinal));

    // Lo que trajo Windows (oct-2026): la cantidad sin parte entera, el importe
    // roto en varios tokens y líneas que son casi todo basura.
    const barril = '1.00  CERVEZA BARRIL X 30L IMPERIAL  5100.00  5100.00';
    const rota = parsearTexto(['.00  CERVEZA IMPERIAL X 1L X 12  1620.00  11340.00', '00  CERVEZA HEINEKEN X 1L X 12  1710.00  6840.00', barril].join('\n'));
    check(
      rota.length === 3 && rota[0]!.cantidad === 7 && rota[0]!.estado === 'corregido' && rota[0]!.descripcion === 'CERVEZA IMPERIAL X 1L X 12' && rota[1]!.cantidad === 4 && rota[1]!.estado === 'corregido' && rota[1]!.codigo === null,
      'cantidad leída ".00"/"00" ARRIBA del primer renglón que cierra → la tabla empieza ahí: cantidad deducida por la cuenta (7 y 4), corregido',
      JSON.stringify(rota.map((r) => [r.cantidad, r.estado, r.descripcion])),
    );
    const separada = parsearTexto(['.00  CERVEZA IMPERIAL X 1L X 12  1620.00  11340.00', 'Observaciones: entrega el lunes', barril].join('\n'));
    check(separada.length === 1, 'la misma línea separada de la tabla por una línea sin números no es un renglón (la zona se extiende sólo por líneas contiguas)', String(separada.length));
    const sinCantidad = parsearTexto(['JJ  Shampoo TRESEMME liso  5.784,30  21,00  6999,00  17.352,90', '0176850  1 UN  Sopa crema KNORR  2.276,24  21,00  2754,25  2.276,24'].join('\n'))[0]!;
    check(sinCantidad.cantidad === 3 && sinCantidad.estado === 'corregido' && sinCantidad.codigo === null, 'dentro de la tabla, una línea con descripción y sin cantidad ni código → cantidad por la cuenta (3), corregido', JSON.stringify(sinCantidad));
    const conDescuento = parsearTexto([barril, 'Descuento 10%  1234.56  123.46', barril].join('\n'));
    const descuento = conDescuento[1]!;
    check(conDescuento.length === 3 && descuento.estado === 'revisar' && descuento.cantidad === null && /Descuento/.test(descuento.descripcion), 'una línea con rótulo de pie en el medio ("Descuento 10% …") no deduce cantidad (10 × 123,46 cerraría): revisar', `${conDescuento.length} · ${descuento.estado} ${descuento.cantidad} · ${descuento.motivo}`);
    const sopa = uno('1 UN  Sopa crema KNORR verduras nueva x60gr  2.276,24  21,00  2754,25  2. n6,2A');
    check(sopa.estado === 'revisar' && sopa.cantidad === 1 && sopa.precioUnitario === 2276.24 && sopa.importe === 2276.24 && /Importe ilegible \(2\. n6,2A\); por la cuenta sería 2\.276,24/.test(sopa.motivo ?? ''), 'importe roto en DOS tokens ("2. n6,2A") → importe ilegible, con el valor de la cuenta', JSON.stringify(sopa));
    const toalla = uno('0188730  TOALLA diseños surtidos 70x140cm  4.958.  21,00  6000,00  A. 958, 6B  O?');
    check(toalla.estado === 'revisar' && toalla.precioUnitario === 4958.68 && toalla.importe === null && toalla.descripcion === 'TOALLA diseños surtidos 70x140cm 4.958.' && /Importe ilegible \(958, 6B\)/.test(toalla.motivo ?? '') && /precio con IVA: 4\.958,68/.test(toalla.motivo ?? ''), 'precio truncado + importe roto en cuatro tokens → revisar; el precio se reconstruye desde el precio con IVA y se dice', JSON.stringify(toalla));
    const puntoDeMas = uno('L5  6 (2051)  GIN BOMBAY X 750 cc.  (12x750)  1880.001.  11280.01');
    check(puntoDeMas.estado === 'ok' && puntoDeMas.cantidad === 6 && puntoDeMas.precioUnitario === 1880.001 && puntoDeMas.codigo === '2051', 'precio con un punto de más al final ("1880.001.") sigue siendo el precio', JSON.stringify(puntoDeMas));
    check(parsearTexto('0188730  TOALLA  4.958.  6000,00').length === 1 && parsearTexto('0188730  TOALLA  4.958.  6000,00')[0]!.precioUnitario === null, 'un número al que le faltan los decimales ("4.958.") NO es un número', JSON.stringify(parsearTexto('0188730  TOALLA  4.958.  6000,00')[0]));
    const listaPartida = uno('L  5  1 (1400)  GASTOS  DE ENVIO  1850.852  1850.85');
    check(listaPartida.estado === 'ok' && listaPartida.codigo === '1400' && listaPartida.cantidad === 1 && listaPartida.descripcion === 'GASTOS DE ENVIO', 'marca de lista partida en dos cajas ("L" + "5") delante de la cantidad y el código', JSON.stringify(listaPartida));
    const sopaOk = '0176850  1 UN  Sopa crema KNORR verduras nueva x60gr  2.276,24  21,00  2754,25  2.276,24';
    const ilegibles = parsearTexto([sopaOk, '- 929,  21,00  -1124, as', '148,  21,00  -180,26', sopaOk, '563,84  21,00  -682,25', 'Total Ahorro  - 10.502,37', 'Cajas: 2 Unidades: 21  Subtotal:  48.122,16'].join('\n'));
    check(
      ilegibles.length === 5 && ilegibles[0]!.estado === 'ok' && ilegibles[3]!.estado === 'ok' && [1, 2, 4].every((k) => ilegibles[k]!.estado === 'revisar' && ilegibles[k]!.motivo === MOTIVO_ILEGIBLE && ilegibles[k]!.descripcion === '' && ilegibles[k]!.cantidad === null && ilegibles[k]!.precioUnitario === null && ilegibles[k]!.importe === null),
      'líneas casi ilegibles dentro de la tabla (tasa de IVA + números rotos, o importes sin descripción) → renglón vacío en revisar, en su lugar; la de abajo del último renglón también; el pie no',
      ilegibles.map((r) => `${r.estado}:${r.motivo}`).join(' | '),
    );
    check(parsearTexto('- 929,  21,00  -1124, as').length === 0 && parsearTexto('563,84  21,00  -682,25').length === 0, 'las mismas líneas SOLAS (fuera de una tabla) no son renglones');
    const pieSinRotuloAlFrente = parsearTexto([barril, 'Cajas: 2 Unidades: 21  Subtotal:  48122.16'].join('\n'));
    check(pieSinRotuloAlFrente.length === 1, 'un pie con el rótulo en el medio de la línea, debajo del último renglón, no se vuelve renglón', String(pieSinRotuloAlFrente.length));
  }

  // --- 4. Calidad de la foto ----------------------------------------------------
  {
    const c15 = calidadDeFoto(leerFixture('vital-15'));
    check(!c15.ok && c15.problemas.some((p) => /Falta parte de la hoja a la izquierda/.test(p)), 'vital-15 (códigos cortados): avisa que falta hoja a la izquierda', c15.problemas.join(' | '));
    check(!c15.problemas.some((p) => /derecha/.test(p)), 'vital-15: no acusa el lado derecho');
    const c13 = calidadDeFoto(leerFixture('vital-13'));
    check(c13.ok && c13.problemas.length === 0, 'vital-13: foto buena', c13.problemas.join(' | '));
    for (const h of ['vital-12', 'vital-14']) {
      const c = calidadDeFoto(leerFixture(h));
      check(c.ok, `${h}: foto buena`, c.problemas.join(' | '));
    }
    const base = leerFixture('vital-13');
    const espejo: LecturaSistema = { ...base, textos: base.textos.map((c) => ({ ...c, x0: c.x0 + 0.12, x1: Math.min(1.001, c.x1 + 0.12) })) };
    check(calidadDeFoto(espejo).problemas.some((p) => /a la derecha/.test(p)), 'hoja corrida hacia la derecha → falta hoja a la derecha');
    const vacia = calidadDeFoto({ ancho: 2000, alto: 1500, textos: base.textos.slice(0, 3) });
    check(!vacia.ok && /borrosa u oscura/.test(vacia.problemas[0] ?? ''), 'casi sin texto → foto borrosa u oscura', vacia.problemas.join(' | '));
    const dudosa = calidadDeFoto({ ...base, textos: base.textos.map((c) => ({ ...c, c: 0.3 })) });
    check(!dudosa.ok && dudosa.problemas.some((p) => /borrosa u oscura/.test(p)), 'confianza media baja → foto borrosa u oscura');
    const ang = (14 * Math.PI) / 180;
    const torcida: LecturaSistema = {
      ...base,
      textos: base.textos.map((c) => {
        const g = (x: number, y: number): [number, number] => {
          const px = (x - 0.5) * base.ancho;
          const py = (y - 0.5) * base.alto;
          return [(px * Math.cos(ang) - py * Math.sin(ang)) / base.ancho + 0.5, (px * Math.sin(ang) + py * Math.cos(ang)) / base.alto + 0.5];
        };
        const [x0, y0] = g(c.x0 * 0.6 + 0.2, c.y0 * 0.6 + 0.2);
        const [x1, y1] = g(c.x1 * 0.6 + 0.2, c.y1 * 0.6 + 0.2);
        return { ...c, x0, y0, x1, y1 };
      }),
    };
    const ct = calidadDeFoto(torcida);
    check(ct.problemas.some((p) => /inclinada/.test(p)), 'hoja girada 14° → muy inclinada', ct.problemas.join(' | '));
    check(calidadDeFoto({ ancho: 0, alto: 0, textos: [] }).ok === false, 'lectura vacía → no ok, sin romper');
    const todos = [c15, vacia, ct].flatMap((c) => c.problemas).join(' ');
    check(!/\b(sacá|volvé|tenés|probá|fijate)\b/i.test(todos), 'mensajes sin tutear');
  }

  // --- 5. Programa auxiliar --------------------------------------------------------
  {
    const l = interpretarLectura('aviso cualquiera\n{"ancho":100,"alto":50,"textos":[{"t":"hola","x0":0.1,"y0":0.2,"x1":0.3,"y1":0.2,"h":0.05,"c":0.9},{"t":" ","x0":0,"y0":0,"x1":0,"y1":0,"h":0,"c":1},{"t":"x","x0":"a"}]}\n');
    check(l.ancho === 100 && l.textos.length === 1 && l.textos[0]!.t === 'hola', 'interpretarLectura: toma el JSON y descarta cajas inválidas');
    const unaSola = interpretarLectura('{"ancho":10,"alto":10,"textos":{"t":"a","x0":0,"y0":0,"x1":1,"y1":0,"h":0.1}}');
    check(unaSola.textos.length === 1 && unaSola.textos[0]!.c === 1, 'interpretarLectura: una sola caja como objeto (PowerShell) y sin confianza');
    let tiro = false;
    try {
      interpretarLectura('no hay nada');
    } catch {
      tiro = true;
    }
    check(tiro, 'interpretarLectura: salida sin JSON → error');
    check(programaPorPlataforma('darwin') === join('ocr-mac', 'vision-ocr') && programaPorPlataforma('win32') === join('ocr-win', 'leer.ps1') && programaPorPlataforma('linux') === null, 'programaPorPlataforma');

    const falso = new LectorSistema({ programa: join(dirNative, 'no-existe') });
    check((await falso.disponible()) === false, 'LectorSistema: sin programa auxiliar → no disponible');
    let msg = '';
    try {
      await falso.leerHoja(Buffer.from('no soy un jpeg'));
    } catch (e) {
      msg = (e as Error).message;
    }
    check(/JPEG/.test(msg), 'LectorSistema: lo que no es JPEG → error claro', msg);
    msg = '';
    try {
      await falso.leerHoja(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
    } catch (e) {
      msg = (e as Error).message;
    }
    check(/lector de texto del sistema/.test(msg), 'LectorSistema: programa que no arranca → error claro', msg);
    check((await new LectorSistema({ programa: 'x', plataforma: 'linux' }).disponible()) === false, 'LectorSistema: plataforma sin lector → no disponible');

    // De verdad, en esta máquina (si está el binario compilado y están las muestras).
    const rel = programaPorPlataforma();
    const programa = rel ? join(dirNative, rel) : '';
    const real = new LectorSistema({ programa });
    if (process.platform === 'darwin' && (await real.disponible()) && existsSync(join(dirMuestras, 'vital-13.jpg'))) {
      for (const h of hojas) {
        const t0 = Date.now();
        const lectura = await real.leerHoja(readFileSync(join(dirMuestras, `${h}.jpg`)));
        const ms = Date.now() - t0;
        const renglones = parsearTexto(armarRenglones(lectura).join('\n'));
        const fix = leerFixture(h);
        const igual = lectura.textos.length === fix.textos.length && lectura.textos.every((c, i) => c.t === fix.textos[i]!.t);
        check(lectura.textos.length > 50 && renglones.length === esperado[h]!.length, `lector real · ${h}.jpg: ${lectura.textos.length} cajas, ${renglones.length} renglones en ${ms} ms`);
        if (!igual) console.log(`ℹ️  ${h}: la lectura de hoy difiere del fixture (otra versión del sistema): conviene regenerarlo`);
      }
    } else {
      console.log('ℹ️  lector real no probado: falta el binario (native/ocr-mac/compilar.sh), las muestras, o no es Mac');
    }
  }

  console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
  process.exit(fallas ? 1 : 0);
}

void main();
