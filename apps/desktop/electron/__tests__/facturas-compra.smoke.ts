/**
 * TEST: pasaje de una factura escaneada al formulario de Compras
 * (src/lib/facturaACompra.ts). Sólo cuentas: sin base, sin Electron.
 *
 * Qué se controla: la base de los precios (neto / final) contra el modo de
 * precios de la empresa, cantidad × UxB, artículos repetidos, descuentos y
 * qué queda afuera.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  armarPasajeACompras,
  avisosDelRenglon,
  avisoYaCargada,
  cargaTelefonoVisible,
  claseDeComprobante,
  costoParaCompras,
  cuentaCierra,
  cuitConGuiones,
  cuitParaGuardar,
  cuitValido,
  datosArticuloNuevo,
  decidirAtajo,
  estadoDelRenglon,
  fechaCorta,
  intervaloEstadoCompras,
  numeroDeFactura,
  prefillDeFactura,
  proveedoresParecidos,
  proximoCodigoInterno,
  textoDeSeguimiento,
  tipoDeEncabezado,
  type FacturaParaAtajo,
  type RenglonParaCuenta,
  controlDeTotal,
} from '../../src/lib/facturaACompra';

let fallas = 0;
function check(nombre: string, ok: boolean, detalle?: unknown): void {
  if (ok) console.log(`  ✓ ${nombre}`);
  else {
    fallas++;
    console.log(`  ✗ ${nombre}`, detalle ?? '');
  }
}

const r = (x: Partial<RenglonParaCuenta>): RenglonParaCuenta => ({
  codigo: null,
  cantidad: null,
  unidadesPorBulto: null,
  precioUnitario: null,
  importe: null,
  esDescuento: false,
  estado: 'ok',
  articleId: null,
  ...x,
});
const iva: Record<string, number> = { a21: 21, a105: 10.5, a0: 0 };
const alicuota = (id: string): number | null => iva[id] ?? null;

console.log('costoParaCompras');
check('A + empresa neta: pasa tal cual', costoParaCompras(100, 21, 'A', 'net') === 100);
check('A + empresa con IVA incluido: suma el IVA', costoParaCompras(100, 21, 'A', 'gross') === 121);
check('A + IVA incluido, 10,5 %', costoParaCompras(200, 10.5, 'A', 'gross') === 221);
check('B + empresa con IVA incluido: pasa tal cual', costoParaCompras(121, 21, 'B', 'gross') === 121);
check('B + empresa neta: descuenta el IVA', costoParaCompras(121, 21, 'B', 'net') === 100);
check('C y X son finales', costoParaCompras(121, 21, 'C', 'net') === 100 && costoParaCompras(121, 21, 'X', 'gross') === 121);
check('artículo exento: no cambia', costoParaCompras(100, 0, 'A', 'gross') === 100);
check('redondea a 4 decimales', costoParaCompras(27.19, 21, 'A', 'gross') === 32.8999);

console.log('cuentaCierra / estadoDelRenglon');
check('2 × 12 × 27,19 = 652,56', cuentaCierra(2, 12, 27.19, 652.56));
check('no cierra', !cuentaCierra(3, 12, 27.19, 652.56));
check('descuento: importe negativo', cuentaCierra(24, 1, 27.19, -652.56));
check('editado y cierra → ok', estadoDelRenglon({ cantidad: 2, unidadesPorBulto: null, precioUnitario: 50, importe: 100 }).estado === 'ok');
check('sin cantidad → revisar', estadoDelRenglon({ cantidad: null, unidadesPorBulto: 1, precioUnitario: 50, importe: 100 }).motivo === 'Falta la cantidad');
check('no cierra → revisar', estadoDelRenglon({ cantidad: 3, unidadesPorBulto: 1, precioUnitario: 50, importe: 100 }).estado === 'revisar');
// La misma tolerancia que el parser: sin holgura porcentual.
check('3 × 751,24 contra 2.253,12 (un dígito mal) NO cierra', !cuentaCierra(3, 1, 751.24, 2253.12) && estadoDelRenglon({ cantidad: 3, unidadesPorBulto: null, precioUnitario: 751.24, importe: 2253.12 }).estado === 'revisar');
check('importe grande: $250 de diferencia sobre $500.000 NO cierra', !cuentaCierra(10, 1, 50000, 500250));
check('el redondeo del precio a centavos sí se tolera (medio centavo por unidad)', cuentaCierra(24, 1, 27.19, 652.6) && cuentaCierra(3, 1, 751.24, 2253.72));

console.log('armarPasajeACompras');
const factura: RenglonParaCuenta[] = [
  r({ codigo: '111111', cantidad: 2, unidadesPorBulto: 12, precioUnitario: 100, importe: 2400, articleId: 'a21' }),
  r({ codigo: '222222', cantidad: 5, unidadesPorBulto: null, precioUnitario: 200, importe: 1000, articleId: 'a105' }),
  r({ codigo: '333333', cantidad: 1, unidadesPorBulto: 6, precioUnitario: 50, importe: 300 }), // sin artículo
  r({ codigo: '444444', cantidad: null, precioUnitario: 10, importe: 10, articleId: 'a21', estado: 'revisar' }), // sin cantidad
  r({ codigo: '555555', cantidad: 1, precioUnitario: 10, importe: 10, articleId: 'borrado' }), // artículo que ya no está
  r({ codigo: '111111', cantidad: 1, unidadesPorBulto: 12, precioUnitario: 110, importe: 1320, articleId: 'a21', estado: 'revisar' }),
  r({ codigo: null, cantidad: 24, unidadesPorBulto: 1, precioUnitario: 10, importe: -240, esDescuento: true }),
  r({ codigo: null, importe: -60.5, esDescuento: true }),
];

const neta = armarPasajeACompras(factura, 'A', 'net', alicuota);
check('un renglón por artículo', neta.lineas.length === 2, neta.lineas);
const l21 = neta.lineas.find((l) => l.articleId === 'a21');
check('cantidad = cantidad × UxB, repetidos sumados (24 + 12)', l21?.quantity === '36', l21);
check('costo = promedio ponderado ((24×100 + 12×110) ÷ 36)', l21?.unitPrice === '103.3333', l21);
check('sin UxB = 1', neta.lineas.find((l) => l.articleId === 'a105')?.quantity === '5');
check('A + neta: costo tal cual', neta.lineas.find((l) => l.articleId === 'a105')?.unitPrice === '200.0000');
check('sin artículo: 2 (sin vincular + dado de baja)', neta.sinArticulo === 2, neta.sinArticulo);
check('sin datos: 1', neta.sinDatos === 1);
check('por revisar que se cargan: 1', neta.porRevisar === 1);
check('descuentos sumados en positivo', neta.descuentos === 300.5, neta.descuentos);
check('misma base → se precarga el descuento', neta.mismaBase && neta.descuentoACargar === '300.50', neta.descuentoACargar);
check('subtotal de lo que se carga', Math.abs(neta.subtotal - 4720) < 0.01, neta.subtotal);
check(
  'vínculos: un código por artículo cargado, ninguno de los que quedan afuera',
  neta.vinculos.length === 2 && neta.vinculos.every((v) => ['111111', '222222'].includes(v.code)),
  neta.vinculos,
);

const bruta = armarPasajeACompras(factura, 'A', 'gross', alicuota);
check('A + IVA incluido: costo con el IVA del artículo (10,5 %)', bruta.lineas.find((l) => l.articleId === 'a105')?.unitPrice === '221.0000');
check('A + IVA incluido: 21 %', bruta.lineas.find((l) => l.articleId === 'a21')?.unitPrice === '125.0333', bruta.lineas);
check('otra base → el descuento NO se carga', !bruta.mismaBase && bruta.descuentoACargar === '0' && bruta.descuentos === 300.5);

const b = armarPasajeACompras(factura, 'B', 'gross', alicuota);
check('B + IVA incluido: tal cual y con descuento', b.lineas.find((l) => l.articleId === 'a105')?.unitPrice === '200.0000' && b.descuentoACargar === '300.50');
const bNeta = armarPasajeACompras(factura, 'B', 'net', alicuota);
check('B + neta: sin IVA y sin descuento', bNeta.lineas.find((l) => l.articleId === 'a105')?.unitPrice === '180.9955' && bNeta.descuentoACargar === '0');

const comido = armarPasajeACompras(
  [r({ cantidad: 1, precioUnitario: 100, importe: 100, articleId: 'a21' }), r({ importe: -100, esDescuento: true })],
  'A',
  'net',
  alicuota,
);
check('un descuento que se lleva toda la compra no se precarga', comido.descuentoACargar === '0');
check('sin renglones no rompe', armarPasajeACompras([], 'A', 'net', alicuota).lineas.length === 0);

console.log('descuentos en revisar');
const conDescuentoDudoso = armarPasajeACompras(
  [
    r({ cantidad: 1, precioUnitario: 1000, importe: 1000, articleId: 'a21' }),
    r({ importe: -50, esDescuento: true, estado: 'revisar' }),
    r({ importe: null, esDescuento: true }),
    r({ importe: -10, esDescuento: true }),
  ],
  'A',
  'net',
  alicuota,
);
check('los descuentos en revisar o sin importe se avisan', conDescuentoDudoso.descuentosPorRevisar === 2 && conDescuentoDudoso.descuentoACargar === '60.00', conDescuentoDudoso);
check('sin descuentos dudosos: 0', neta.descuentosPorRevisar === 0);

console.log('alícuota de la factura y costo actual');
const harina = r({ codigo: '0012345', cantidad: 4, precioUnitario: 500, importe: 2000, articleId: 'a21', tasaIva: 10.5 });
const pasajeHarina = armarPasajeACompras([harina], 'A', 'gross', alicuota);
check('A + IVA incluido: convierte con la tasa de la FACTURA (552,50, no 605)', pasajeHarina.lineas[0]?.unitPrice === '552.5000', pasajeHarina.lineas);
check('y la tasa viaja a Compras', pasajeHarina.lineas[0]?.vatRate === '10.50');
check('IVA de la factura ≠ IVA del artículo → cuenta como Revisar aunque la cuenta cierre', pasajeHarina.porRevisar === 1);
check(
  'el aviso dice las dos alícuotas',
  avisosDelRenglon(harina, { alicuota: 21, costoActual: null }, 'A', 'gross')[0] === 'IVA de la factura 10,5 % ≠ IVA del artículo 21 %',
  avisosDelRenglon(harina, { alicuota: 21, costoActual: null }, 'A', 'gross'),
);
const igualTasa = armarPasajeACompras([r({ cantidad: 1, precioUnitario: 100, importe: 100, articleId: 'a105', tasaIva: 10.5 })], 'A', 'gross', alicuota);
check('misma alícuota: sin aviso', igualTasa.porRevisar === 0 && igualTasa.lineas[0]?.unitPrice === '110.5000');
check('sin tasa leída: usa la del artículo y no manda vatRate', bruta.lineas.every((l) => l.vatRate === undefined));
const dosTasas = armarPasajeACompras(
  [r({ cantidad: 1, precioUnitario: 100, importe: 100, articleId: 'a21', tasaIva: 21 }), r({ cantidad: 1, precioUnitario: 100, importe: 100, articleId: 'a21' })],
  'A',
  'net',
  alicuota,
);
check('mismo artículo con y sin tasa leída: no se manda vatRate', dosTasas.lineas[0]?.vatRate === undefined);

// Factura por bulto, artículo por unidad: 2 × 9.599 contra un costo actual de 1.200.
const ketchup = r({ cantidad: 2, precioUnitario: 9599, importe: 19198, articleId: 'a21' });
const costos: Record<string, number> = { a21: 1200 };
const porBulto = armarPasajeACompras([ketchup], 'A', 'net', alicuota, (id) => costos[id] ?? null);
check('costo leído ×8 del costo actual → Revisar', porBulto.porRevisar === 1);
check(
  'el aviso pide revisar las unidades por bulto',
  /^Costo leído \$ 9\.599,00; costo actual del artículo \$ 1\.200,00: revise unidades por bulto$/.test(avisosDelRenglon(ketchup, { alicuota: 21, costoActual: 1200 }, 'A', 'net')[0] ?? ''),
  avisosDelRenglon(ketchup, { alicuota: 21, costoActual: 1200 }, 'A', 'net'),
);
check('la comparación es en la base de la empresa (neto 1.000 → 1.210 con IVA contra 1.200)', avisosDelRenglon(r({ precioUnitario: 1000 }), { alicuota: 21, costoActual: 1200 }, 'A', 'gross').length === 0);
check('costo menos de la mitad del actual → aviso', avisosDelRenglon(r({ precioUnitario: 500 }), { alicuota: 21, costoActual: 1200 }, 'A', 'net').length === 1);
check('un aumento del 80 % no avisa (inflación)', avisosDelRenglon(r({ precioUnitario: 2160 }), { alicuota: 21, costoActual: 1200 }, 'A', 'net').length === 0);
check('artículo sin costo cargado: no hay con qué comparar', avisosDelRenglon(ketchup, { alicuota: 21, costoActual: 0 }, 'A', 'net').length === 0);
check('sin costoActualDe no cambia nada', armarPasajeACompras([ketchup], 'A', 'net', alicuota).porRevisar === 0);

console.log('claseDeComprobante');
check('facturas A, B, C y sin QR', [1, 6, 11, 51, 201, null, undefined].every((t) => claseDeComprobante(t) === 'factura'));
check('notas de crédito', [3, 8, 13, 53, 203, 208, 213].every((t) => claseDeComprobante(t) === 'notaCredito'));
check('notas de débito', [2, 7, 12, 52, 202, 207, 212].every((t) => claseDeComprobante(t) === 'notaDebito'));

console.log('numeroDeFactura');
check('0004-00012345', numeroDeFactura(4, 12345) === '0004-00012345');
check('sin punto de venta', numeroDeFactura(null, 12345) === '00012345');
check('sin número', numeroDeFactura(4, null) === '');

console.log('controlDeTotal');
{
  const r = (importe: number | null, extra: { esDescuento?: boolean; tasaIva?: number | null; articleId?: string | null } = {}) => ({
    importe,
    esDescuento: extra.esDescuento ?? false,
    tasaIva: extra.tasaIva ?? null,
    articleId: extra.articleId ?? null,
  });
  const b = controlDeTotal([r(1000), r(500.4), r(-100, { esDescuento: true })], { total: 1400.4 }, 'B');
  check('Factura B: la suma (con el descuento restando) da el total', b.coincide === true && b.suma === 1400.4 && b.diferencia === 0, JSON.stringify(b));
  check('tolerancia de 1 peso', controlDeTotal([r(1000)], { total: 1001 }, 'B').coincide === true && controlDeTotal([r(1000)], { total: 1001.5 }, 'B').coincide === false);
  const falta = controlDeTotal([r(1000)], { total: 1500 }, 'B');
  check('falta un renglón: no coincide y dice por cuánto', falta.coincide === false && falta.diferencia === -500 && falta.total === 1500, JSON.stringify(falta));
  check('sin total leído no hay control', controlDeTotal([r(1000)], { total: null, subtotal: null }, 'B').coincide === null);
  check('el descuento cargado en positivo también resta', controlDeTotal([r(1000), r(100, { esDescuento: true })], { total: 900 }, 'C').coincide === true);
  const a = controlDeTotal([r(1000), r(1000, { tasaIva: 10.5 })], { total: 2315 }, 'A');
  check('Factura A: neto + IVA de cada renglón (21 % si no se leyó) da el total', a.coincide === true && a.sumaConIva === 2315 && a.suma === 2000, JSON.stringify(a));
  check('Factura A: usa el IVA del artículo vinculado', controlDeTotal([r(1000, { articleId: 'x' })], { total: 1105 }, 'A', (x) => (x.articleId === 'x' ? 10.5 : null)).coincide === true);
  check('Factura A con percepciones: coincide si el neto da el subtotal impreso', controlDeTotal([r(1000)], { total: 1260, subtotal: 1000 }, 'A').coincide === true);
  const perc = controlDeTotal([r(1000)], { total: 1260 }, 'A');
  check('Factura A con percepciones y sin subtotal: no coincide (diferencia contra la suma con IVA)', perc.coincide === false && perc.diferencia === -50, JSON.stringify(perc));
  check('Factura B no suma IVA', controlDeTotal([r(1000)], { total: 1210 }, 'B').coincide === false);
  check('sin tipo se prueban las dos cuentas', controlDeTotal([r(1000)], { total: 1210 }, null).coincide === true && controlDeTotal([r(1000)], { total: 1000 }, null).coincide === true);
  check('renglones sin importe no rompen la cuenta', controlDeTotal([r(null), r(200)], { total: 200 }, 'B').coincide === true);
}

console.log('artículos sugeridos y hojas cortadas: se cargan, no se recuerdan');
{
  const pasaje = armarPasajeACompras(
    [
      r({ codigo: null, descripcion: 'CERVEZA IMPERIAL X 1L X 12', cantidad: 7, precioUnitario: 1620, importe: 11340, articleId: 'a21', sugerido: true }),
      r({ codigo: '777', descripcion: 'Otro', cantidad: 1, precioUnitario: 100, importe: 100, articleId: 'a105', codigoDudoso: true }),
      r({ codigo: '888', descripcion: 'Elegido', cantidad: 2, precioUnitario: 50, importe: 100, articleId: 'a0' }),
    ],
    'B',
    'gross',
    alicuota,
  );
  check('los tres renglones se cargan', pasaje.lineas.length === 3, pasaje.lineas);
  check('sólo se recuerda el vínculo confirmado (ni el sugerido ni el de la hoja cortada)', pasaje.vinculos.length === 1 && pasaje.vinculos[0]?.code === '888', pasaje.vinculos);
  check('cuenta los sugeridos y Compras los recibe marcados', pasaje.sugeridos === 1 && pasaje.lineas.find((l) => l.articleId === 'a21')?.sugerido === true && pasaje.lineas.find((l) => l.articleId === 'a0')?.sugerido === undefined);
  const aceptado = armarPasajeACompras([r({ codigo: null, descripcion: 'CERVEZA IMPERIAL X 1L X 12', cantidad: 7, precioUnitario: 1620, importe: 11340, articleId: 'a21' })], 'B', 'gross', alicuota);
  check('aceptado: el proveedor sin códigos se recuerda por la descripción', aceptado.vinculos[0]?.code === 'desc:cerveza imperial x 1l x 12' && aceptado.sugeridos === 0, aceptado.vinculos);
}

console.log('atajo: de la factura leída directo a Compras');
{
  const art: Record<string, { alicuota: number; costo: number | null }> = { a21: { alicuota: 21, costo: 1500 }, a105: { alicuota: 10.5, costo: 1700 } };
  const articuloDe = (id: string) => art[id] ?? null;
  const completa: FacturaParaAtajo = {
    supplierId: 'p1',
    listaParaCargar: true,
    tipoDudoso: false,
    repetida: false,
    totalCoincide: true,
    compraExistente: null,
    yaCargada: null,
    header: { letra: 'B', tipo: null, tipoCmp: 6, ptoVta: 1, nroCmp: 17141, fecha: '2021-01-07' },
    lineas: [
      r({ codigo: '111', cantidad: 7, precioUnitario: 1620, importe: 11340, articleId: 'a21' }),
      r({ codigo: '222', cantidad: 4, precioUnitario: 1710, importe: 6840, articleId: 'a105', sugerido: true }),
    ],
  };
  const ok = decidirAtajo(completa, 'gross', articuloDe);
  check('completa (con un artículo sugerido con confianza) → directo a Compras', ok.directo === true && ok.tipo === 'B' && ok.pasaje.lineas.length === 2 && ok.pasaje.sugeridos === 1, ok);
  const motivo = (cambios: Partial<FacturaParaAtajo>): string => {
    const d = decidirAtajo({ ...completa, ...cambios }, 'gross', articuloDe);
    return d.directo ? '' : d.motivo;
  };
  check('sin proveedor → revisión', /proveedor/.test(motivo({ supplierId: null })));
  check('sin letra ni tipo → revisión', /tipo de comprobante/.test(motivo({ header: { ...completa.header, letra: null, tipo: null } })));
  check('nota de crédito → revisión', /nota de crédito/.test(motivo({ header: { ...completa.header, tipoCmp: 8 } })));
  const fecha = new Date(2026, 8, 21, 10, 30).getTime();
  check('ya cargada → revisión, con la fecha', motivo({ yaCargada: { fecha } }) === 'Esta factura ya fue cargada el 21/09/2026.', motivo({ yaCargada: { fecha } }));
  check('el total no coincide → revisión', /no coincide con el total/.test(motivo({ totalCoincide: false })));
  check('sin total leído → revisión', /No se leyó el total/.test(motivo({ totalCoincide: null })));
  check('un renglón sin artículo → revisión', motivo({ lineas: [...completa.lineas, r({ cantidad: 1, precioUnitario: 10, importe: 10 })] }) === 'Hay 1 renglón sin artículo.');
  check('un gasto (flete) → revisión', /gastos/.test(motivo({ lineas: [...completa.lineas, r({ cantidad: 1, precioUnitario: 500, importe: 500, esGasto: true })] })));
  check('un renglón en revisar → revisión', /para revisar/.test(motivo({ lineas: [completa.lineas[0]!, { ...completa.lineas[1]!, estado: 'revisar' }] })));
  check('un artículo dado de baja → revisión', /dado de baja/.test(motivo({ lineas: [...completa.lineas, r({ cantidad: 1, precioUnitario: 10, importe: 10, articleId: 'borrado' })] })));
  const lejos = decidirAtajo(completa, 'gross', (id) => (id === 'a21' ? { alicuota: 21, costo: 100 } : articuloDe(id)));
  check('el costo leído muy lejos del actual → revisión', !lejos.directo && /IVA o costo/.test(lejos.motivo), lejos);
  check('tipoDeEncabezado: lo elegido manda; M es A; sin letra, null', tipoDeEncabezado({ tipo: 'X', letra: 'A' }) === 'X' && tipoDeEncabezado({ letra: 'M' }) === 'A' && tipoDeEncabezado({ letra: null }) === null && tipoDeEncabezado(null) === null);

  if (ok.directo) {
    const p = prefillDeFactura('f1', { supplierId: 'p1', tipo: ok.tipo, ptoVta: 1, nroCmp: 17141, fecha: '2021-01-07', yaCargada: { fecha } }, ok.pasaje);
    check(
      'prefill: encabezado, renglones, vínculos y el aviso de ya cargada',
      p.facturaId === 'f1' && p.from === 'facturaEscaneada' && p.header.invoiceNumber === '0001-00017141' && p.header.voucherType === 'B' && p.header.dateIso === '2021-01-07' && p.prefilledLines.length === 2 && p.vinculos.length === 1 && p.avisos[0] === 'Esta factura ya fue cargada el 21/09/2026.' && typeof p.lote === 'number',
      p,
    );
    check('prefill sin aviso si no se cargó antes', prefillDeFactura('f1', { supplierId: 'p1', tipo: 'B', ptoVta: null, nroCmp: null, fecha: null }, ok.pasaje).avisos.length === 0);
  }
  check('avisoYaCargada / fechaCorta', avisoYaCargada(null) === null && fechaCorta(new Date(2026, 0, 5).getTime()) === '05/01/2026');
}

console.log('crear artículo desde un renglón');
{
  const ean = datosArticuloNuevo({ codigo: '7790895000997', descripcion: '  Gaseosa  cola 2,25 L ', precioUnitario: 1000, tasaIva: 21 }, 'A', 'gross');
  check('código leído con forma de código de barras → va como código del artículo', ean.barcode === '7790895000997');
  check('descripción limpia', ean.description === 'Gaseosa cola 2,25 L');
  check('Factura A + empresa con IVA: el costo lleva el IVA (la misma regla del pasaje)', ean.costPrice === '1210.0000' && ean.vatRate === '21.00', ean);
  const interno = datosArticuloNuevo({ codigo: '0100695', descripcion: 'Atún', precioUnitario: 825.62, tasaIva: 10.5 }, 'A', 'net');
  check('código interno del proveedor → código vacío (lo escanea o lo genera el usuario)', interno.barcode === '');
  check('Factura A + empresa neta: costo tal cual, IVA de la factura', interno.costPrice === '825.6200' && interno.vatRate === '10.50', interno);
  check('Factura B + empresa neta: se descuenta el IVA', datosArticuloNuevo({ codigo: null, descripcion: 'x', precioUnitario: 121, tasaIva: null }, 'B', 'net').costPrice === '100.0000');
  check('IVA que no es de artículo → 21 %; IVA elegido manda', datosArticuloNuevo({ codigo: null, precioUnitario: 100, tasaIva: 5 }, 'B', 'gross').vatRate === '21.00' && datosArticuloNuevo({ codigo: null, precioUnitario: 100, tasaIva: 21 }, 'A', 'gross', '10.50').costPrice === '110.5000');
  check('sin precio → costo 0', datosArticuloNuevo({ codigo: null, precioUnitario: null }, 'B', 'gross').costPrice === '0.0000');
  check('sin tipo elegido no convierte', datosArticuloNuevo({ codigo: null, precioUnitario: 100, tasaIva: 21 }, null, 'gross').costPrice === '100.0000');
  check('próximo código interno: el mayor corto + 1, con su ancho', proximoCodigoInterno(['0001', '0002', '7790895000997', 'PROMO-01']) === '0003');
  check('próximo código interno: los de barras no cuentan; saltea los usados', proximoCodigoInterno(['15', '9', '16', '7790895000997']) === '17');
  check('próximo código interno sin ninguno: 1', proximoCodigoInterno([]) === '1');
}

console.log('CUIT del proveedor elegido a mano');
{
  const provs = [{ id: 'p1', cuit: null }, { id: 'p2', cuit: '30-71249243-7' }, { id: 'p3', cuit: '' }];
  check('cuitValido', cuitValido('27248159362') && !cuitValido('27248159363') && !cuitValido('12345678901') && cuitConGuiones('27248159362') === '27-24815936-2');
  check('proveedor sin CUIT + CUIT leído válido → se ofrece guardarlo', cuitParaGuardar(provs[0], '27-24815936-2', provs) === '27248159362');
  check('el proveedor ya tiene CUIT → no', cuitParaGuardar(provs[1], '27248159362', provs) === null);
  check('CUIT leído inválido → no', cuitParaGuardar(provs[0], '27248159363', provs) === null);
  check('otro proveedor ya tiene ese CUIT → no (sería un duplicado)', cuitParaGuardar(provs[2], '30712492437', provs) === null);
  check('sin proveedor → no', cuitParaGuardar(null, '27248159362', provs) === null);
  const sugeridos = proveedoresParecidos(
    { razonSocial: 'ROA DISTRIBUCIONES', cuit: '27248159362', otrosNombres: ['Maria Laura Fernandez'] },
    [
      { id: 'x', name: 'Fernandez Maria', cuit: null },
      { id: 'y', name: 'Distribuidora Norte', cuit: null },
      { id: 'z', name: 'Roa Distribuciones S.R.L.', cuit: null },
    ],
  );
  check('sugiere por la razón social normalizada (primero) y por los otros nombres de la hoja', sugeridos[0]?.id === 'z' && sugeridos.some((p) => p.id === 'x') && !sugeridos.some((p) => p.id === 'y'), sugeridos);
}

console.log('Compras: «Cargar con el teléfono»');
{
  check('textoDeSeguimiento: recibiendo', textoDeSeguimiento({ estado: 'recibiendo', hojas: 2, hojasLeidas: 0 }) === 'Recibiendo hoja 2…' && textoDeSeguimiento({ estado: 'recibiendo', hojas: 0, hojasLeidas: 0 }) === 'Esperando la primera hoja…');
  check('textoDeSeguimiento: leyendo', textoDeSeguimiento({ estado: 'leyendo', hojas: 3, hojasLeidas: 1 }) === 'Leyendo hoja 2 de 3…' && textoDeSeguimiento({ estado: 'en_cola', hojas: 3, hojasLeidas: 0 }) === 'Leyendo hoja 1 de 3…');
  check('textoDeSeguimiento: lento y error', /Puede demorar unos minutos/.test(textoDeSeguimiento({ estado: 'leyendo', hojas: 1, hojasLeidas: 0, lento: true })) && textoDeSeguimiento({ estado: 'error', hojas: 1, hojasLeidas: 0, error: 'Falló' }) === 'Falló');
  check('con la opción apagada no hay botón ni sondeo', !cargaTelefonoVisible({ activo: false }) && !cargaTelefonoVisible(undefined) && intervaloEstadoCompras({ activo: false }) === false && intervaloEstadoCompras(undefined) === false);
  check('activa: botón y contador cada 15 s', cargaTelefonoVisible({ activo: true }) && intervaloEstadoCompras({ activo: true }) === 15_000);
  // Lo que dibuja Compras: el botón y el componente que sondea sólo existen con la opción activa.
  const compras = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'pages', 'Compras.tsx'), 'utf8');
  check('Compras: el estado se sondea con intervaloEstadoCompras (apagada, nunca)', /refetchInterval: \(q\) => intervaloEstadoCompras\(q\.state\.data\)/.test(compras));
  check('Compras: «Cargar con el teléfono» sólo con la opción activa', /\{facturasActivas && \(\s*<Button[\s\S]{0,400}?Cargar con el teléfono/.test(compras));
  check('Compras: el seguimiento del teléfono sólo se monta con la opción activa', /\{facturasActivas && \(\s*<CargaTelefonoCompras/.test(compras) && (compras.match(/<CargaTelefonoCompras/g) ?? []).length === 1);
  check('Compras: no pide nada más de facturas que el estado', (compras.match(/api\.facturas\.\w+/g) ?? []).every((c) => c === 'api.facturas.estado' || c === 'api.facturas.marcarCargada'), compras.match(/api\.facturas\.\w+/g));
}

if (fallas > 0) {
  console.log(`\n❌ ${fallas} FALLAS — TEST FACTURAS → COMPRAS`);
  process.exit(1);
}
console.log('\n✅ TODO OK — TEST FACTURAS → COMPRAS');
