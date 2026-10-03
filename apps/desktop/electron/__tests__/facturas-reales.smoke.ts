/**
 * Facturas por teléfono — facturas REALES cargadas por el dueño con su teléfono
 * (texto leído por el lector del sistema). Tres proveedores distintos, sin QR:
 * los renglones, el control contra el total impreso y el encabezado.
 *   pnpm --filter @stockflow/desktop test:facturas-reales
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cuitValido, leerEncabezado } from '../facturas/encabezado';
import { parsearTexto, totalesDelTexto, unirHojas, type RenglonLeido } from '../facturas/parser';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'fixtures', 'facturas', 'reales');

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

interface RenglonEsperado {
  codigo: string | null;
  cantidad: number;
  unidadesPorBulto: number | null;
  descripcion: string;
  precioUnitario: number;
  importe: number;
}
interface Esperado {
  encabezado: { cuit: string; razonSocial: string; numero: string; fecha: string; letra?: 'A' | 'B' | 'C'; total: number };
  renglones?: RenglonEsperado[];
  codigos?: string[];
  cantidadRenglones?: number;
  suma?: number;
}
const esperado = JSON.parse(readFileSync(join(dir, 'esperado.json'), 'utf8')) as Record<string, Esperado>;
const leer = (nombre: string): string => readFileSync(join(dir, `${nombre}.txt`), 'utf8');
const igual = (a: number | null, b: number | null, tol = 0.00005): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) <= tol;
const suma = (rs: RenglonLeido[]): number => Math.round(rs.reduce((s, r) => s + (r.importe ?? 0), 0) * 100) / 100;
const CUIT_DEL_NEGOCIO = '20-24681357-5';

function renglonesExactos(nombre: string, renglones: RenglonLeido[]): void {
  const esp = esperado[nombre]!.renglones!;
  let bien = 0;
  esp.forEach((e, i) => {
    const r = renglones[i];
    const ok =
      !!r &&
      r.codigo === e.codigo &&
      igual(r.cantidad, e.cantidad) &&
      igual(r.unidadesPorBulto, e.unidadesPorBulto) &&
      igual(r.precioUnitario, e.precioUnitario) &&
      igual(r.importe, e.importe) &&
      r.descripcion === e.descripcion;
    if (ok) bien++;
    else console.log(`   · ${nombre} renglón ${i + 1}: esperado ${JSON.stringify(e)}\n     leído ${JSON.stringify(r ?? null)}`);
  });
  check(bien === esp.length, `${nombre}: ${bien}/${esp.length} renglones exactos (código, cantidad, UxB, precio, importe, descripción)`);
  check(renglones.length === esp.length, `${nombre}: ningún renglón inventado ni perdido`, `leídos ${renglones.length}, esperados ${esp.length}`);
}

function encabezado(nombre: string): void {
  const e = esperado[nombre]!.encabezado;
  const h = leerEncabezado([leer(nombre)], { cuitPropio: CUIT_DEL_NEGOCIO });
  check(h.cuit === e.cuit, `${nombre}: CUIT del emisor ${e.cuit}`, String(h.cuit));
  check(leerEncabezado([leer(nombre)]).cuit === e.cuit, `${nombre}: el CUIT del cliente se descarta aunque no se sepa el del negocio`);
  check(h.razonSocial === e.razonSocial, `${nombre}: razón social "${e.razonSocial}"`, String(h.razonSocial));
  check(h.numero === e.numero, `${nombre}: número ${e.numero}`, String(h.numero));
  check(h.fecha === e.fecha, `${nombre}: fecha de emisión ${e.fecha} (no inicio de actividades ni vencimientos)`, String(h.fecha));
  check(igual(h.total, e.total, 0.005), `${nombre}: total ${e.total}`, String(h.total));
  if (e.letra) check(h.letra === e.letra, `${nombre}: letra ${e.letra}`, String(h.letra));
  check(h.cae !== null && /^\d{14}$/.test(h.cae) && leer(nombre).includes(h.cae), `${nombre}: CAE de 14 dígitos`, String(h.cae));
}

// --- 1. Al Vino Vino: marca de lista "L5", código entre paréntesis, cajas × pack ---
{
  const texto = leer('alvinovino');
  const rs = parsearTexto(texto);
  renglonesExactos('alvinovino', rs);
  const ron = rs[0]!;
  check(
    ron.cantidad === 2 && ron.unidadesPorBulto === 12 && ron.estado === 'corregido' && /12/.test(ron.motivo ?? '') && /24/.test(ron.motivo ?? ''),
    'alvinovino: 2 cajas × 12 × 960,002 = 23.040,05 → pack deducido de la cuenta, corregido y con motivo',
    `${ron.cantidad} × ${ron.unidadesPorBulto} · ${ron.estado} · ${ron.motivo}`,
  );
  check(rs.slice(1).every((r) => r.estado === 'ok' && r.unidadesPorBulto === null), 'alvinovino: el resto en ok, sin pack inventado ("(12X750)" en la descripción no es UxB)');
  check(rs[0]!.precioUnitario === 960.002 && rs[3]!.precioUnitario === 1444.583, 'alvinovino: precios con 3 decimales');
  const t = totalesDelTexto(texto);
  check(t.total === 48122.16 && t.subtotal === 48122.16, 'alvinovino: totalesDelTexto → TOTAL y Subtotal 48.122,16 (el "Total:" sin número del encabezado no cuenta)', JSON.stringify(t));
  check(suma(rs) === t.total, 'alvinovino: la suma de los renglones es el total impreso', `${suma(rs)} / ${t.total}`);
  encabezado('alvinovino');
  check(leerEncabezado([texto]).otrosNombres.some((n) => /S\.A\.$/.test(n)), 'alvinovino: "de … S.A." queda como otro nombre del emisor', JSON.stringify(leerEncabezado([texto]).otrosNombres));
}

// --- 2. Bernardi: códigos cortos en la primera columna ---------------------------
{
  const texto = leer('bernardi');
  const e = esperado.bernardi!;
  const rs = parsearTexto(texto);
  check(rs.length === e.cantidadRenglones, `bernardi: ${e.cantidadRenglones} renglones`, String(rs.length));
  check(JSON.stringify(rs.map((r) => r.codigo)) === JSON.stringify(e.codigos), 'bernardi: los 19 códigos cortos (926, 1023, 29071…) de la primera columna', rs.map((r) => r.codigo).join(','));
  check(rs.every((r) => r.estado === 'ok'), 'bernardi: todo en ok');
  check(rs[0]!.cantidad === 72 && rs[0]!.unidadesPorBulto === null && rs[0]!.precioUnitario === 37.03, 'bernardi: la cantidad es la columna Cantidad (unidades); Bultos se ignora', JSON.stringify(rs[0]));
  check(igual(suma(rs), e.suma!, 0.001), `bernardi: suma de renglones ${e.suma}`, String(suma(rs)));
  const t = totalesDelTexto(texto);
  check(t.total === 49519.4 && t.subtotal === 49519.4, 'bernardi: totalesDelTexto → "Subtotal: $ 49.519,40 … Total: $ 49.519,40"', JSON.stringify(t));
  check(igual(suma(rs), t.total, 0.05), 'bernardi: la suma coincide con el total (tolerancia 0,05)', `${suma(rs)} / ${t.total}`);
  check(rs[3]!.descripcion === 'FANTA-NARANJA 12X500 PET' && rs[1]!.descripcion === 'AGUA BONAQUA 6X11/5' && rs[18]!.descripcion === 'POWERADE F.TROP. 6X500', 'bernardi: las marcas de birome (*, _, •) no quedan en la descripción', `${rs[3]!.descripcion} / ${rs[1]!.descripcion} / ${rs[18]!.descripcion}`);
  encabezado('bernardi');
  // Un solo renglón no alcanza para decir que el número de adelante es un código.
  const uno = parsearTexto('1023 AGUA BONAQUA 12X500 6,00 72,00 37,03 2.665,87');
  check(uno.length === 1 && uno[0]!.codigo === null && uno[0]!.cantidad === 72, 'código corto: con un solo renglón no se confirma el patrón (no se inventa)', JSON.stringify(uno[0]));
  // …pero con todas las hojas juntas sí.
  const lineas = texto.split('\n');
  const iTabla = lineas.findIndex((l) => l.startsWith('1023'));
  const hojas = unirHojas([lineas.slice(0, iTabla + 18).join('\n'), lineas.slice(iTabla + 18).join('\n')]);
  check(hojas.length === 19 && hojas[18]!.codigo === '976' && hojas[18]!.hoja === 2, 'código corto: una segunda hoja con un solo renglón toma el patrón de la factura', JSON.stringify(hojas[18] ?? null));
}

// --- 3. Roa: renglón con viñeta, total cortado, CUIT del cliente ------------------
{
  const texto = leer('roa');
  const rs = parsearTexto(texto);
  renglonesExactos('roa', rs);
  check(rs.every((r) => r.estado === 'ok'), 'roa: todo en ok');
  check(/^•/.test(rs[4]!.original) && rs[4]!.cantidad === 4 && rs[4]!.importe === 2040, 'roa: el renglón que empieza con viñeta ("• 4.00 CERVEZA LATA…") no se pierde', rs[4]!.original);
  const t = totalesDelTexto(texto);
  check(t.total === 27070, 'roa: total cortado ("Importe Total: $ 27070.") → 27.070', JSON.stringify(t));
  check(suma(rs) === t.total, 'roa: la suma de los renglones es el total impreso', `${suma(rs)} / ${t.total}`);
  encabezado('roa');
  check(leerEncabezado([texto]).otrosNombres.includes('Maria Laura Fernandez'), 'roa: la "Razón Social:" del emisor queda como otro nombre');
}

// --- 4. Regla dura: descripción + importe nunca se pierde en silencio -------------
{
  const tabla = (medio: string): RenglonLeido[] =>
    parsearTexto(['2 (1047) RON BACARDI 960.00 1920.00', medio, '3 (641) GIN BULLDOG 1320.00 3960.00'].join('\n'));

  // Prefijo desconocido corto delante del código entre paréntesis ("Ls" es la
  // marca de lista "L5" con el 5 leído como letra): el código se reconoce, el
  // prefijo no queda en la descripción y la cantidad, que no se leyó sino que
  // se dedujo del importe, nunca sale en ok.
  for (const prefijo of ['Ls', 'L5', 'Ł5', '•']) {
    const rara = tabla(`${prefijo} (2051) GIN BOMBAY 1880.00 11280.00`);
    const r = rara[1];
    check(
      rara.length === 3 && !!r && r.codigo === '2051' && r.descripcion === 'GIN BOMBAY' && r.cantidad === 6 && r.importe === 11280 && r.precioUnitario === 1880 && r.estado !== 'ok' && /6/.test(r.motivo ?? ''),
      `prefijo "${prefijo}" delante del código entre paréntesis, sin cantidad: código 2051, descripción limpia, cantidad 6 deducida (corregido o revisar, nunca ok)`,
      JSON.stringify(r ?? null),
    );
  }
  const sinNada = tabla('?? GIN BOMBAY SAPHIRE 1880.00 11281.00');
  check(sinNada.length === 3 && sinNada[1]!.estado === 'revisar' && sinNada[1]!.importe === 11281 && sinNada[1]!.motivo !== null, 'sin cantidad ni código y la cuenta no cierra, entre renglones → revisar con motivo', JSON.stringify(sinNada[1] ?? null));
  const noCierra = tabla('L5 5 (2051) GIN BOMBAY 1880.00 11280.00');
  check(noCierra.length === 3 && noCierra[1]!.codigo === '2051' && noCierra[1]!.estado !== 'ok' && noCierra[1]!.motivo !== null, 'la cuenta no cierra con lo leído → nunca en ok, siempre con motivo', JSON.stringify(noCierra[1] ?? null));
  const unImporte = tabla('6 GIN BOMBAY SAPHIRE 11280.00');
  check(unImporte.length === 3 && unImporte[1]!.estado === 'revisar' && unImporte[1]!.cantidad === 6 && unImporte[1]!.importe === 11280, 'cantidad, descripción y un solo importe → revisar (no se descarta)', JSON.stringify(unImporte[1] ?? null));
  const texto = tabla('NETFLIX');
  check(texto.length === 2, 'una palabra suelta entre renglones (sin importe) no es un renglón');
  const pie = parsearTexto(['2 (1047) RON BACARDI 960.00 1920.00', 'Subtotal: 1920.00', 'Descto.: 0.00% 0.00', 'TOTAL: 1920.00', '3 (641) GIN BULLDOG 1320.00 3960.00'].join('\n'));
  check(pie.length === 2, 'subtotal, descuento general y total entre hojas no pasan por renglones', String(pie.length));

  // Pack deducido: sólo cuando no puede ser una cantidad mal leída.
  const uno = (l: string): RenglonLeido => parsearTexto(l)[0]!;
  const pack = uno('2 (1047) RON BACARDI 12 X 1 LT 960.002 23040.05');
  check(pack.cantidad === 2 && pack.unidadesPorBulto === 12 && pack.estado === 'corregido', 'pack: figura en la descripción ("12 X 1") → 2 × 12', JSON.stringify(pack));
  const conUnidad = uno('0012345 2 UN Yerba X x1kg 1.000,00 12.000,00');
  check(conUnidad.cantidad === 12 && conUnidad.unidadesPorBulto === null && conUnidad.estado === 'corregido', 'pack: con unidad escrita ("2 UN") sigue siendo una cantidad mal leída', JSON.stringify(conUnidad));
  const dudoso = uno('2 (1047) RON BACARDI 960.00 2880.00');
  check(dudoso.estado !== 'ok' && dudoso.unidadesPorBulto === null, 'pack: 2 leído y la cuenta da 3 → no se inventa un pack', JSON.stringify(dudoso));
}

// --- 5. Encabezado: bordes ----------------------------------------------------------
{
  check(cuitValido('30712492437') && cuitValido('27248159362') && !cuitValido('30712492438') && !cuitValido('00231784560'), 'cuitValido: dígito verificador');
  const vacio = leerEncabezado([]);
  check(vacio.cuit === null && vacio.numero === null && vacio.fecha === null && vacio.total === null && vacio.razonSocial === null, 'sin texto → todo en null, sin romper');
  check(leerEncabezado([undefined as unknown as string, '']).cuit === null, 'texto inválido no rompe');

  const propio = leerEncabezado(['DISTRIBUIDORA DEL SUR S.A.\nCUIT: 30-71249243-7\nFecha: 02/10/2026\nFACTURA A N° 0003-00001234'], { cuitPropio: '30712492437' });
  check(propio.cuit === null && propio.razonSocial === 'DISTRIBUIDORA DEL SUR S.A.' && propio.numero === '0003-00001234' && propio.fecha === '2026-10-02' && propio.letra === 'A', 'el CUIT del propio negocio nunca es el del proveedor', JSON.stringify(propio));
  const malLeido = leerEncabezado(['DISTRIBUIDORA DEL SUR S.A.\nCUIT: 30-71249243-1']);
  check(malLeido.cuit === null, 'un CUIT con el dígito verificador mal no sale');
  const dos = leerEncabezado(['MAYORISTA NORTE S.R.L.\nC.U.I.T.: 33-71513700-9\nSeñor: JUAN PEREZ\nCUIT: 27-24815936-2\nPie de imprenta CUIT 30-71249243-7']);
  check(dos.cuit === '33715137009', 'dos CUIT válidos: gana el del bloque de arriba', String(dos.cuit));
  const fechas = leerEncabezado(['ALGO S.A.\nInicio de Actividades: 01/02/2016\nVto. CAE: 28/01/2021 Fecha: 18/01/2021']);
  check(fechas.fecha === '2021-01-18', 'la fecha con rótulo "Fecha" gana aunque venga después de otras en la misma línea', String(fechas.fecha));
  const soloOtras = leerEncabezado(['ALGO S.A.\nInicio de Actividades: 01/02/2016\nVencimiento: 28/01/2021']);
  check(soloOtras.fecha === null, 'si sólo hay inicio de actividades y vencimiento, la fecha queda en null', String(soloOtras.fecha));
  const remito = leerEncabezado(['ALGO S.A.\nREMITO NRO: 0002-00000077\nORDEN DE COMPRA: 0000-00000000\nFactura B 0005-00012345']);
  check(remito.numero === '0005-00012345' && remito.letra === 'B', 'el número de remito y los casilleros en cero no son el número de la factura', String(remito.numero));
  const variasHojas = leerEncabezado(['ALGO S.A.\nCUIT: 30-71249243-7\n2 (10) COSA 10.00 20.00', '3 (11) OTRA 10.00 30.00\nTOTAL: 50.00']);
  check(variasHojas.total === 50 && variasHojas.cuit === '30712492437', 'varias hojas: el total sale de la última y el CUIT de la primera', JSON.stringify(variasHojas));

  check(totalesDelTexto('Total Ahorro - 813,72\nTotal IVA: 21%').total === null, 'totalesDelTexto: "Total Ahorro" y "Total IVA" no son el total');
  const vital = totalesDelTexto('SUBTOTAL 1.651,24 0,00 1.651,24\nIVA 21,00 346,76\nTOTAL 1 1.998,00 1.998,00');
  check(vital.total === 1998 && vital.subtotal === 1651.24, 'totalesDelTexto: varios números tras el rótulo → el último con decimales', JSON.stringify(vital));
  check(totalesDelTexto('').total === null && totalesDelTexto(undefined as unknown as string).subtotal === null, 'totalesDelTexto: texto vacío o inválido → null');
}

{
  // Buen Sol: la hoja no trae el CUIT del emisor y el del comprador va debajo
  // de su condición de IVA. Ese CUIT NUNCA es el del proveedor (con o sin el
  // CUIT de la empresa cargado).
  const bs = readFileSync(join(here, 'fixtures', 'facturas', 'buensol.txt'), 'utf8');
  check(leerEncabezado([bs]).cuit !== '20258369417', 'buensol: el CUIT del cliente (bajo "Responsable Monotributista") no sale como emisor', String(leerEncabezado([bs]).cuit));
  check(leerEncabezado([bs], { cuitPropio: '20258369417' }).cuit === null, 'buensol: con el CUIT de la empresa cargado, tampoco');
}

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
