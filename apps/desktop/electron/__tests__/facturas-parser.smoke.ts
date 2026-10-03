/**
 * Facturas por teléfono — parser de renglones y QR fiscal (sin Electron, sin base).
 * Fixtures: texto real leído por GLM-OCR de fotos de facturas + planilla correcta.
 *   pnpm --filter @stockflow/desktop test:facturas-parser
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import jpeg from 'jpeg-js';
import QRCode from 'qrcode';
import { aLineas, detectarFormato, MOTIVO_REPETIDO, MOTIVO_SIGNO_DESCUENTO, parsearTexto, unirHojas, type RenglonLeido } from '../facturas/parser';
import { decodificarUrlQr, leerQrFiscal } from '../facturas/qrFiscal';

const here = dirname(fileURLToPath(import.meta.url));
const dirFixtures = join(here, 'fixtures', 'facturas');
const dirMuestras = join(here, '..', '..', '..', '..', 'tools', 'ocr-facturas', 'muestras');

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
const leer = (nombre: string): string => readFileSync(join(dirFixtures, `${nombre}.txt`), 'utf8');

const igual = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.00005;
const ult6 = (c: string | null): string | null => (c === null ? null : c.slice(-6));

/**
 * Un renglón está bien si coinciden cantidad, UxB, precio e importe, y el código
 * por los últimos 6 dígitos. Si el código esperado NO está en el texto leído
 * (quedó fuera de la foto), lo correcto es que el parser no invente uno.
 */
function renglonBien(r: RenglonLeido | undefined, e: Esperado, texto: string): boolean {
  if (!r) return false;
  const codigoOk =
    e.codigo !== null && !texto.includes(e.codigo) ? r.codigo === null : ult6(r.codigo) === ult6(e.codigo);
  return (
    codigoOk &&
    igual(r.cantidad, e.cantidad) &&
    igual(r.unidadesPorBulto, e.unidadesPorBulto) &&
    igual(r.precioUnitario, e.precioUnitario) &&
    igual(r.importe, e.importe)
  );
}

const tabla: Array<{ fixture: string; bien: number; total: number; leidos: number }> = [];
function medir(nombre: string): { renglones: RenglonLeido[]; bien: number; total: number } {
  const texto = leer(nombre);
  const esp = esperado[nombre]!;
  const renglones = parsearTexto(texto);
  let bien = 0;
  esp.forEach((e, i) => {
    if (renglonBien(renglones[i], e, texto)) bien++;
    else console.log(`   · ${nombre} renglón ${i + 1}: esperado ${JSON.stringify(e)}\n     leído ${JSON.stringify(renglones[i] ?? null)}`);
  });
  tabla.push({ fixture: nombre, bien, total: esp.length, leidos: renglones.length });
  return { renglones, bien, total: esp.length };
}

// --- 1. Meta: 100 % en las facturas con importe por renglón ------------------
for (const nombre of ['vital-12', 'vital-13', 'vital-14', 'vital-15', 'buensol']) {
  const { renglones, bien, total } = medir(nombre);
  check(bien === total, `${nombre}: ${bien}/${total} renglones exactos`);
  check(renglones.length === total, `${nombre}: ningún renglón inventado ni perdido`, `leídos ${renglones.length}, esperados ${total}`);
  const basura = renglones.filter((r) => /total ahorro|\*{3,}|cuenta y orden|cupones|subtotal|descripcion del articulo|www\./i.test(r.original));
  check(basura.length === 0, `${nombre}: encabezados, totales y separadores no son renglones`, basura.map((r) => r.original).join(' / '));
  check(renglones.every((r) => r.hoja === 1 && r.original.length > 0), `${nombre}: cada renglón trae hoja y texto original`);
}

// --- 2. Estados y descuentos -------------------------------------------------
{
  const v15 = parsearTexto(leer('vital-15'));
  const r0 = v15[0]!;
  check(r0.cantidad === 3 && r0.estado === 'corregido', 'vital-15: la cantidad leída 2 se corrige a 3 por la cuenta', `${r0.cantidad} ${r0.estado} · ${r0.motivo}`);
  check(/2/.test(r0.motivo ?? '') && /3/.test(r0.motivo ?? ''), 'vital-15: el motivo dice qué se leyó y qué corresponde', r0.motivo ?? '');
  check(v15.slice(1).every((r) => r.estado === 'ok' && r.motivo === null), 'vital-15: el resto queda en ok');
  check(v15[1]!.unidadesPorBulto === 10 && v15[4]!.unidadesPorBulto === 3 && v15[5]!.unidadesPorBulto === 12, 'vital-15: UxB de los bultos (10, 3, 12)');
  const desc = v15.filter((r) => r.esDescuento);
  check(desc.length === 2 && desc.every((r) => r.codigo === null && r.importe! < 0 && r.precioUnitario! < 0), 'vital-15: 2 descuentos sin código, en negativo');
  check(desc[0]!.descripcion === 'ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10%', 'vital-15: el "10%" de la promoción queda en la descripción', desc[0]!.descripcion);

  const v12 = parsearTexto(leer('vital-12'));
  check(v12.every((r) => r.estado === 'ok'), 'vital-12: todo en ok');
  check(v12.filter((r) => r.esDescuento).length === 2 && v12.filter((r) => !r.esDescuento).length === 21, 'vital-12: 21 artículos + 2 promociones');
  check(v12[0]!.descripcion === 'Atun S&P desmenuzado en aceite x170gr', 'vital-12: descripción sin la unidad ni la marca OF', v12[0]!.descripcion);
  check(v12[5]!.precioUnitario === 1900 && v12[5]!.importe === 5700, 'vital-12: precio con IVA sin decimales (2299) no confunde');

  const v13 = parsearTexto(leer('vital-13'));
  check(v13.every((r) => r.estado === 'ok'), 'vital-13: todo en ok (incluye descuentos con redondeo: 20 × 34,30 = 685,96)');
  check(v13.filter((r) => r.esDescuento).length === 14, 'vital-13: 14 promociones');

  const v14 = parsearTexto(leer('vital-14'));
  check(v14.every((r) => r.estado === 'ok'), 'vital-14 (tabla HTML): todo en ok');
  check(v14[6]!.descripcion === 'Caldo KNORR gallina deshidratado x6u' && v14[6]!.unidadesPorBulto === 10, 'vital-14: "BTO" sale de la descripción y el UxB es 10', v14[6]!.descripcion);
  check(v14[4]!.descripcion === 'Bolsa resid VIRUTEX 45x60 plana 10u', 'vital-14: números dentro de la descripción no se tocan', v14[4]!.descripcion);

  const bs = parsearTexto(leer('buensol'));
  check(bs.every((r) => r.estado === 'ok' && !r.esDescuento), 'buensol: todo en ok');
  check(bs[3]!.cantidad === 12 && bs[7]!.cantidad === 6, 'buensol: con CANT. en 0,00 la cantidad es la columna UN./KG.', `${bs[3]!.cantidad}, ${bs[7]!.cantidad}`);
  check(bs[0]!.codigo === '016203711000' && bs[20]!.codigo === '050508920012', 'buensol: el n.º de renglón no es el código (y el último renglón no lo trae)');
  check(bs[18]!.descripcion === 'CALDO ALICANTE X 12U x 7,5 G CHAMP Y HONGOS # SIN TACC', 'buensol: "7,5" en la descripción no es una columna', bs[18]!.descripcion);
  check(bs[0]!.precioUnitario === 18671.716, 'buensol: precio con 4 decimales', String(bs[0]!.precioUnitario));
}

// --- 3. Mejor esfuerzo: documentos sin importe por renglón -------------------
{
  const m = medir('pedido-munini');
  check(m.renglones.length > 0 && m.renglones.every((r) => r.estado === 'revisar'), `pedido-munini (precio en otra línea): ${m.bien}/${m.total}, todo en revisar`);
  const b = medir('bebidas');
  check(b.renglones.length > 0 && b.renglones.every((r) => r.estado === 'revisar' && r.cantidad === null), `bebidas (sólo descripción y precio): ${b.bien}/${b.total}, todo en revisar`);
  check(detectarFormato(leer('bebidas')) === 'ingles' && detectarFormato(leer('pedido-munini')) === 'ingles', 'formato 1,234.56 detectado en bebidas y pedido-munini');
  check(detectarFormato(leer('buensol')) === 'argentino' && detectarFormato(leer('vital-14')) === 'argentino', 'formato 1.234,56 detectado en buensol y vital-14');
}

// --- 4. Bordes ---------------------------------------------------------------
{
  check(parsearTexto('').length === 0 && parsearTexto('   \n\n').length === 0, 'texto vacío → sin renglones');
  check(parsearTexto(undefined as unknown as string).length === 0, 'texto inválido no rompe');
  check(parsearTexto('FACTURA A\nNro 0004-00012345\nFecha 01/10/2026\nCUIT 30-12345678-9').length === 0, 'una hoja sin renglones → vacío');

  const pie = parsearTexto(
    ['0100695 2 UN Atun x170gr 825,62 21,00 999,00 1.651,24', 'SUBTOTAL 1.651,24 0,00 1.651,24', 'IVA 21,00 346,76', 'TOTAL 1 1.998,00 1.998,00', 'Total Ahorro - 813,72'].join('\n'),
  );
  check(pie.length === 1 && pie[0]!.codigo === '0100695', 'pie con subtotal, IVA y total: no se cuelan como renglones', String(pie.length));

  const mal = parsearTexto('0100695 7 UN Atun x170gr 825,62 21,00 999,00 1.700,00');
  check(mal.length === 1 && mal[0]!.estado === 'revisar' && mal[0]!.cantidad === 7 && mal[0]!.precioUnitario === 825.62 && mal[0]!.importe === 1700, 'cuenta que no cierra ni se puede corregir → revisar con lo leído', JSON.stringify(mal[0]));

  const sinCant = parsearTexto('0100695 Atun x170gr 825,62 21,00 999,00 2.476,86');
  check(sinCant.length === 1 && sinCant[0]!.cantidad === 3 && sinCant[0]!.estado === 'corregido', 'cantidad que no se leyó → calculada por el importe (corregido)', JSON.stringify(sinCant[0]));

  const tasa = parsearTexto('0100695 5 UN Atun x170gr 825,62 21,00 999,00 1.764,00');
  check(tasa[0]!.estado === 'revisar', 'la tasa de IVA (21,00) nunca se toma como precio para corregir', JSON.stringify(tasa[0]));

  const usa = parsearTexto('A1234 COCA COLA 2.25 6 1,250.50 7,503.00\nB5678 FANTA 2.25 2 1,100.00 2,200.00');
  check(usa.length === 2 && usa[0]!.cantidad === 6 && usa[0]!.precioUnitario === 1250.5 && usa[0]!.importe === 7503, 'formato 1,234.56 con cantidad pegada al precio', JSON.stringify(usa[0]));

  const corto = parsearTexto('482 3 UN Yerba x1kg 4.607,44 21,00 5575,00 13.822,32');
  check(corto[0]!.codigo === '482' && corto[0]!.cantidad === 3 && corto[0]!.estado === 'ok', 'código corto (3 cifras) delante de la cantidad', JSON.stringify(corto[0]));

  const cortada = parsearTexto('<table><tr><td>0183509</td><td>1</td><td>Acond x970ml</td><td></td><td>4.169,28</td><td>21,00</td><td>5044,83</td><td>4.169,28</td></tr><tr><td>0188760</td><td>3</td><td>Antitr x50ml</td><td></td><td>2.147,93</td><td>21,00</td><td>2599,00</td><td>6.443,79</td><td>OF');
  check(cortada.length === 2 && cortada[1]!.importe === 6443.79, 'tabla HTML cortada a mitad (límite de tokens) se aprovecha igual', String(cortada.length));

  const md = parsearTexto('| Código | Cant | Descripción | Precio | Importe |\n|---|---|---|---|---|\n| 0100695 | 2 | Atun x170gr | 825,62 | 1.651,24 |');
  check(md.length === 1 && md[0]!.cantidad === 2 && md[0]!.importe === 1651.24, 'tabla Markdown');
  check(aLineas('<tr><td>a &amp; b</td><td>1</td></tr>')[0] === 'a & b 1', 'entidades HTML');

  const hojas = unirHojas([leer('vital-12'), leer('vital-13'), '', leer('vital-15')]);
  check(hojas.length === 23 + 24 + 10, 'unirHojas: suma los renglones de todas las hojas', String(hojas.length));
  check(hojas[0]!.hoja === 1 && hojas[23]!.hoja === 2 && hojas[47]!.hoja === 4, 'unirHojas: cada renglón sabe de qué hoja salió');
  const pocos = unirHojas([leer('bebidas'), 'AGUA SABORIZADA 6X1500 1,100.00']);
  check(pocos.length === 6 && pocos[5]!.precioUnitario === 1100 && pocos[5]!.hoja === 2, 'unirHojas: el formato de números se decide con todas las hojas', JSON.stringify(pocos[5] ?? null));
}

// --- 5. QR fiscal -------------------------------------------------------------
{
  const datos = { ver: 1, fecha: '2026-09-25', cuit: 30711234567, ptoVta: 4, tipoCmp: 1, nroCmp: 12345, importe: 150233.45, moneda: 'PES', ctz: 1, tipoDocRec: 80, nroDocRec: 20258369417, tipoCodAut: 'E', codAut: 76391234567890 };
  const b64 = Buffer.from(JSON.stringify(datos)).toString('base64');
  const qr = decodificarUrlQr(`https://www.afip.gob.ar/fe/qr/?p=${b64}`);
  check(
    !!qr && qr.fecha === '2026-09-25' && qr.cuit === '30711234567' && qr.ptoVta === 4 && qr.tipoCmp === 1 && qr.letra === 'A' && qr.nroCmp === 12345 && qr.importe === 150233.45 && qr.codAut === '76391234567890',
    'decodificarUrlQr: URL de AFIP → datos del comprobante',
    JSON.stringify(qr),
  );
  const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check(decodificarUrlQr(`https://serviciosweb.afip.gob.ar/genericos/comprobantes/cae.aspx?p=${encodeURIComponent(b64)}`)?.nroCmp === 12345, 'decodificarUrlQr: base64 con % y otro host');
  check(decodificarUrlQr(`https://www.arca.gob.ar/fe/qr/?p=${urlSafe}`)?.codAut === '76391234567890', 'decodificarUrlQr: base64 url-safe y sin relleno');
  const letra = (tipoCmp: number): string | null | undefined =>
    decodificarUrlQr(`https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify({ ...datos, tipoCmp })).toString('base64')}`)?.letra;
  check(letra(6) === 'B' && letra(11) === 'C' && letra(3) === 'A' && letra(999) === null, 'decodificarUrlQr: tipoCmp 1/6/11 → letra A/B/C');
  check(
    decodificarUrlQr('') === null && decodificarUrlQr('https://www.afip.gob.ar/fe/qr/') === null && decodificarUrlQr('https://www.afip.gob.ar/fe/qr/?p=@@@') === null && decodificarUrlQr('https://ejemplo.com/?p=' + Buffer.from('{"hola":1}').toString('base64')) === null && decodificarUrlQr('texto cualquiera') === null,
    'decodificarUrlQr: basura → null, sin romper',
  );
  check(leerQrFiscal(Buffer.from('no soy un jpeg')) === null && leerQrFiscal(Buffer.alloc(0)) === null, 'leerQrFiscal: lo que no es JPEG → null, sin romper');

  // De punta a punta con una hoja armada: QR nítido dentro de una hoja blanca, pasado a JPEG.
  const hojaConQr = (anchoHoja: number, altoHoja: number, pxModulo: number, x0: number, y0: number): Buffer => {
    const { modules } = QRCode.create(`https://www.afip.gob.ar/fe/qr/?p=${b64}`, { errorCorrectionLevel: 'M' });
    const data = Buffer.alloc(anchoHoja * altoHoja * 4, 255);
    for (let fy = 0; fy < modules.size; fy++) {
      for (let fx = 0; fx < modules.size; fx++) {
        if (!modules.get(fy, fx)) continue;
        for (let dy = 0; dy < pxModulo; dy++) {
          for (let dx = 0; dx < pxModulo; dx++) {
            const o = ((y0 + fy * pxModulo + dy) * anchoHoja + x0 + fx * pxModulo + dx) * 4;
            data[o] = data[o + 1] = data[o + 2] = 0;
          }
        }
      }
    }
    return jpeg.encode({ data, width: anchoHoja, height: altoHoja }, 85).data;
  };
  const grande = leerQrFiscal(hojaConQr(1200, 900, 6, 600, 60));
  check(grande?.nroCmp === 12345 && grande.cuit === '30711234567' && grande.letra === 'A', 'leerQrFiscal: QR nítido en una hoja JPEG → datos del comprobante', JSON.stringify(grande));
  const chico = leerQrFiscal(hojaConQr(2000, 1500, 3, 1500, 1100));
  check(chico?.codAut === '76391234567890', 'leerQrFiscal: QR chico en una esquina (se encuentra por zonas o a tamaño original)', JSON.stringify(chico));
  check(leerQrFiscal(jpeg.encode({ data: Buffer.alloc(400 * 300 * 4, 255), width: 400, height: 300 }, 80).data) === null, 'leerQrFiscal: hoja sin QR → null');

  // Fotos reales (no van en el repo de los clientes: si no están, se informa y sigue).
  for (const nombre of ['vital-15.jpg', 'vital-12.jpg']) {
    const ruta = join(dirMuestras, nombre);
    if (!existsSync(ruta)) {
      console.log(`ℹ️  ${nombre}: muestra no disponible, se saltea`);
      continue;
    }
    const t0 = Date.now();
    const r = leerQrFiscal(readFileSync(ruta));
    console.log(`ℹ️  leerQrFiscal(${nombre}) en ${Date.now() - t0} ms → ${r ? JSON.stringify(r) : 'no se pudo leer el QR (mejor esfuerzo)'}`);
  }
}

// --- Plata: bonificación por renglón, repetidos entre hojas, tasa de IVA ----------
{
  const uno = (linea: string): RenglonLeido => parsearTexto(linea)[0]!;

  // Columna %BONIF entre el precio y el importe: el % NO es el precio.
  const b10 = uno('0012345 5 UN Yerba X x1kg 1.000,00 10,00 4.500,00');
  check(b10.cantidad === 5 && b10.precioUnitario === 900 && b10.importe === 4500 && b10.estado === 'corregido' && /Bonificación 10 %/.test(b10.motivo ?? ''), 'bonificación 10 %: cantidad leída 5, precio neto 900 (no 450 × 10)', JSON.stringify(b10));
  const b20 = uno('0012345 12 UN Fideos x500 850,00 20,00 8.160,00');
  check(b20.cantidad === 12 && b20.precioUnitario === 680 && b20.estado === 'corregido', 'bonificación 20 %: 12 × 680 (no 408 × 20)', JSON.stringify(b20));
  const b75 = uno('0012345 3 UN Arroz largo fino 751,24 7,50 2.084,69');
  check(b75.cantidad === 3 && Math.abs((b75.precioUnitario ?? 0) - 694.897) < 0.0001 && b75.estado === 'corregido', 'bonificación 7,5 %: precio neto con 4 decimales', JSON.stringify(b75));
  // El % que no explica el importe: no se inventa una cantidad que no se parece a la leída.
  const raro = uno('0012345 5 UN Yerba X x1kg 1.000,00 10,00 4.800,00');
  check(raro.estado === 'revisar' && raro.cantidad === 5 && raro.precioUnitario === 1000, 'un % que no cierra queda en revisar con lo leído (no «480 × 10»)', JSON.stringify(raro));
  const lejos = uno('0012345 5 UN Yerba X x1kg 10,00 4.500,00');
  check(lejos.estado === 'revisar' && lejos.cantidad === 5, 'cantidad deducida 450 contra leída 5: no se corrige sola', JSON.stringify(lejos));
  // Lo que SÍ se sigue corrigiendo: un dígito mal leído o una cantidad parecida.
  const cerca = uno('0012345 2 UN Yerba X x1kg 1.000,00 3.000,00');
  check(cerca.estado === 'corregido' && cerca.cantidad === 3, 'cantidad leída 2, por el importe 3: se corrige', JSON.stringify(cerca));
  const digito = uno('0012345 2 UN Yerba X x1kg 1.000,00 12.000,00');
  check(digito.estado === 'corregido' && digito.cantidad === 12, 'cantidad leída 2, por el importe 12 (un dígito de menos): se corrige', JSON.stringify(digito));

  // Tasa de IVA del renglón (sólo cuando el precio con IVA la confirma).
  const harina = uno('0012345 4 UN Harina 000 x1kg 500,00 10,50 552,50 2.000,00');
  check(harina.estado === 'ok' && harina.precioUnitario === 500 && harina.tasaIva === 10.5, 'guarda la tasa de IVA leída (10,5 %)', JSON.stringify(harina));
  const atun = uno('0152743 3 UN Atun trozos 2.128,10 21,00 2575,00 6.384,30');
  check(atun.tasaIva === 21 && atun.estado === 'ok', 'guarda la tasa de IVA leída (21 %)', JSON.stringify(atun));
  check(uno('0012345 2 UN Yerba X x1kg 1.000,00 2.000,00').tasaIva === null && b10.tasaIva === null, 'sin columna de tasa (o con bonificación) la tasa queda en null');

  // Fotos que se solapan: el renglón del borde sale en las dos hojas.
  const borde = '0152743 3 UN Atun trozos 2.128,10 21,00 2575,00 6.384,30';
  const promo = '0100000 - 276,78';
  const dos = unirHojas([`0100000 1 UN Otra cosa 100,00 100,00\n${borde}`, `${borde}\n0100001 2 UN Otra 50,00 100,00`]);
  check(dos.length === 4 && dos[1]!.estado === 'ok' && dos[2]!.estado === 'revisar' && dos[2]!.motivo === MOTIVO_REPETIDO && dos[3]!.estado === 'ok', 'renglón repetido entre hojas: no se borra, el segundo queda en revisar', dos.map((r) => r.estado).join(','));
  const misma = unirHojas([`${borde}\n${borde}`]);
  check(misma.every((r) => r.estado === 'ok'), 'dos renglones iguales en la MISMA hoja no se tocan');
  const lejosDelBorde = unirHojas([`${borde}\n0100000 1 UN A 1,00 1,00\n0100001 1 UN B 1,00 1,00\n0100002 1 UN C 1,00 1,00`, `0100003 1 UN D 1,00 1,00\n${borde}`]);
  check(lejosDelBorde.every((r) => r.estado === 'ok'), 'el mismo artículo lejos del borde de la hoja no se marca');
  const descuentos = unirHojas([`${borde}\n${promo}`, `${promo}\n0100001 2 UN Otra 50,00 100,00`]);
  check(descuentos.filter((r) => r.esDescuento).every((r) => r.motivo !== MOTIVO_REPETIDO), 'los descuentos repetidos (promociones) quedan fuera de la regla', JSON.stringify(descuentos.map((r) => [r.esDescuento, r.estado])));
}

// --- Signo perdido en descuentos ------------------------------------------------------
// En la sección PROMOCIONES de Vital los renglones son negativos ("- 112,31 21,00
// -135,90 - 673,88 PR"). Cuando el lector pierde el "-" del importe, el renglón
// salía positivo y en ok: un descuento cargado como compra. Lecturas reales:
{
  const uno = (linea: string): RenglonLeido => parsearTexto(linea)[0]!;
  const esDescuentoCorregido = (r: RenglonLeido, cantidad: number, precio: number, importe: number): boolean =>
    r.esDescuento && r.cantidad === cantidad && r.precioUnitario === precio && r.importe === importe && r.estado === 'corregido' && r.motivo === MOTIVO_SIGNO_DESCUENTO;

  // (a) Un número negativo con el signo pegado en la línea (el precio con IVA) delata el renglón.
  const d1 = uno('00239767 6 UN ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10% B 112,31 21,00 -135,90 1 673,88 PR');
  check(esDescuentoCorregido(d1, 6, -112.31, -673.88), 'signo perdido: "112,31 21,00 -135,90 1 673,88 PR" → 6 × -112,31 = -673,88, corregido con motivo', JSON.stringify(d1));
  const d2 = uno('00239799 1 UN CUIDADO R DE E LA ROPA 15% 1.090,78 21,00 -1319,85 1.090,78 PR');
  check(esDescuentoCorregido(d2, 1, -1090.78, -1090.78), 'signo perdido: "1.090,78 21,00 -1319,85 1.090,78 PR" → 1 × -1.090,78', JSON.stringify(d2));
  const d3 = uno('00239853 3 UN LA CAMPAGNOLA ESPECIAS E D3015% 165,50 21,00 -200,25 496,49 PR');
  check(esDescuentoCorregido(d3, 3, -165.5, -496.49), 'signo perdido: "165,50 21,00 -200,25 496,49 PR" → 3 × -165,50 = -496,49', JSON.stringify(d3));
  const d4 = uno('00239848 3 UN ALICANTE ESPECIAS D3U15% E 158,55 21,00 -191,85 d 475,66 PR');
  check(esDescuentoCorregido(d4, 3, -158.55, -475.66), 'signo perdido: "158,55 21,00 -191,85 d 475,66 PR" (marca de birome en el medio) → 3 × -158,55 = -475,66', JSON.stringify(d4));
  // Sin sección, sólo con el número negativo pegado: también.
  const soloNegativo = uno('3 UN ACEITES 10% 276,78 21,00 -334,90 830,33');
  check(esDescuentoCorregido(soloNegativo, 3, -276.78, -830.33), 'sin sección ni marca PR, el precio con IVA negativo alcanza', JSON.stringify(soloNegativo));

  // (b) Sección PROMOCIONES sin NINGÚN signo: la sección (o la marca PR) decide.
  const hoja = parsearTexto(
    [
      '0153115 3 UN Vinagre de alcohol S&P x500cc 742,98 21,00 899,01 2.228,94',
      '************** PROMOCIONES *********',
      '3 UN ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10% 276,78 21,00 334,90 830,33 PR',
      '3 UN ACEITES, ADEREZOS Y LIMPIEZA DEL HOGAR 10% 633,80 21,00 766,90 1.901,41',
      'Total Ahorro - 2.731,74',
      '0100695 2 UN Atun x170gr 825,62 21,00 999,00 1.651,24',
    ].join('\n'),
  );
  check(hoja.length === 4, 'sección PROMOCIONES sin signos: 4 renglones (el encabezado y el Total Ahorro no)', String(hoja.length));
  check(hoja[0]!.estado === 'ok' && !hoja[0]!.esDescuento && hoja[0]!.importe === 2228.94, 'sección PROMOCIONES sin signos: el renglón ANTERIOR al encabezado sigue positivo y en ok', JSON.stringify(hoja[0]));
  check(esDescuentoCorregido(hoja[1]!, 3, -276.78, -830.33), 'sección PROMOCIONES sin signos: el renglón con marca PR es descuento (corregido con motivo)', JSON.stringify(hoja[1]));
  check(esDescuentoCorregido(hoja[2]!, 3, -633.8, -1901.41), 'sección PROMOCIONES sin signos: el renglón sin marca PR también, por la sección', JSON.stringify(hoja[2]));
  check(hoja[3]!.estado === 'ok' && !hoja[3]!.esDescuento && hoja[3]!.importe === 1651.24, 'sección PROMOCIONES sin signos: después del Total Ahorro la sección terminó', JSON.stringify(hoja[3]));
  const soloPR = uno('3 UN ACEITES 10% 276,78 21,00 334,90 830,33 PR');
  check(esDescuentoCorregido(soloPR, 3, -276.78, -830.33), 'sin sección ni negativos, la marca PR sola alcanza', JSON.stringify(soloPR));
  // Duda razonable (sin sección, sin PR, sin ningún negativo): se deja como está.
  const comun = uno('3 UN ACEITES 10% 276,78 21,00 334,90 830,33');
  check(comun.estado === 'ok' && !comun.esDescuento && comun.importe === 830.33 && comun.precioUnitario === 276.78, 'sin sección, sin PR y sin negativos: renglón positivo común, en ok', JSON.stringify(comun));
  // Una nota con la palabra adentro no abre una sección.
  const nota = parsearTexto(['0153115 3 UN Vinagre x500cc 742,98 21,00 899,01 2.228,94', 'Precios sin descuento por pronto pago', '0100695 2 UN Atun x170gr 825,62 21,00 999,00 1.651,24'].join('\n'));
  check(nota.length === 2 && nota.every((r) => r.estado === 'ok' && !r.esDescuento), 'una nota con "descuento" adentro no es un encabezado de sección', JSON.stringify(nota.map((r) => [r.estado, r.esDescuento])));

  // (c) Un renglón de descuento nunca queda en ok con importe positivo; y el que
  // ya se leyó en negativo (vital-12/13/14/15) no se toca.
  for (const [nombre, cuantos] of [['vital-12', 2], ['vital-13', 14], ['vital-15', 2]] as const) {
    const rs = parsearTexto(leer(nombre));
    const desc = rs.filter((r) => r.esDescuento);
    check(desc.length === cuantos && desc.every((r) => r.estado === 'ok' && r.importe! < 0 && r.precioUnitario! < 0 && r.motivo === null), `${nombre}: los ${cuantos} descuentos leídos con signo siguen en ok, en negativo y sin motivo`);
    check(rs.every((r) => !(r.esDescuento && r.importe !== null && r.importe > 0)), `${nombre}: ningún descuento con importe positivo`);
  }
  const sumaDesc13 = parsearTexto(leer('vital-13')).filter((r) => r.esDescuento).reduce((s, r) => s + r.importe!, 0);
  check(Math.abs(sumaDesc13 - -10502.37) <= 0.011, 'vital-13: la suma de los 14 descuentos sigue dando el Total Ahorro impreso (-10.502,37, ±1 centavo de redondeo de la factura)', sumaDesc13.toFixed(2));
}

// --- Código SOLO en una línea: ¿de qué renglón es? ----------------------------------
{
  const codigos = (rs: RenglonLeido[]): string => JSON.stringify(rs.map((r) => [r.codigo, r.codigoSuelto === true]));
  // Hoja con columna de código: la inclinación separó el código de UN renglón → va al siguiente, sin marca.
  const inclinada = parsearTexto('0100695 2 UN Atun x170gr 825,62 1.651,24\n0100683\n3 UN Caballa x380g 100,00 300,00\n0100693 1 UN Yerba x1kg 500,00 500,00');
  check(inclinada.length === 3 && inclinada[1]!.codigo === '0100683' && !inclinada[1]!.codigoSuelto && inclinada[0]!.codigo === '0100695' && inclinada[2]!.codigo === '0100693', 'columna de código + un código suelto → al renglón siguiente, confiable', codigos(inclinada));
  // Columna de código, pero el renglón ANTERIOR también quedó sin código: no se sabe de cuál es → dudoso.
  const ambigua = parsearTexto('0100695 2 UN Atun x170gr 825,62 1.651,24\n2 UN Fideos x500g 200,00 400,00\n0100683\n3 UN Caballa x380g 100,00 300,00');
  check(ambigua.length === 3 && ambigua[2]!.codigo === '0100683' && ambigua[2]!.codigoSuelto === true && ambigua[1]!.codigo === null, 'anterior y siguiente sin código → se pega al siguiente, pero dudoso', codigos(ambigua));
  // Sin columna de código y el código de barras impreso DEBAJO de cada producto:
  // cada código es del renglón ANTERIOR (y queda dudoso: pegado al revés
  // vincularía toda la factura corrida en uno, con EAN válidos y sin aviso).
  const debajo = parsearTexto('COCA COLA 2L 6 1.000,00 6.000,00\n7790895000997\nFANTA 2L 6 900,00 5.400,00\n7790895001234');
  check(debajo.length === 2 && debajo[0]!.codigo === '7790895000997' && debajo[1]!.codigo === '7790895001234' && debajo.every((r) => r.codigoSuelto === true), 'EAN debajo de cada producto → al renglón anterior, dudoso', codigos(debajo));
  // Sin columna y el código ENCIMA de cada producto → al siguiente, dudoso.
  const encima = parsearTexto('7790895000997\nCOCA COLA 2L 6 1.000,00 6.000,00\n7790895001234\nFANTA 2L 6 900,00 5.400,00');
  check(encima.length === 2 && encima[0]!.codigo === '7790895000997' && encima[1]!.codigo === '7790895001234' && encima.every((r) => r.codigoSuelto === true), 'código encima de cada producto → al renglón siguiente, dudoso', codigos(encima));
  // Un código suelto nunca pisa el código propio del renglón.
  const propio = parsearTexto('0100683\n0100695 2 UN Atun x170gr 825,62 1.651,24');
  check(propio.length === 1 && propio[0]!.codigo === '0100695' && !propio[0]!.codigoSuelto, 'el renglón ya traía código: el suelto se descarta', codigos(propio));
}

// --- Tabla final --------------------------------------------------------------
console.log('\nFixture          Renglones exactos   Leídos');
for (const t of tabla) {
  const pct = t.total ? Math.round((t.bien / t.total) * 100) : 0;
  console.log(`${t.fixture.padEnd(16)} ${`${t.bien}/${t.total}`.padEnd(8)} ${`${pct} %`.padEnd(10)} ${t.leidos}`);
}

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
