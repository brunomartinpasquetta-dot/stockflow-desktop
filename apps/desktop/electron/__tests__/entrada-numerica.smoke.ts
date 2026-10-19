/**
 * Defensa de pantalla para los casilleros numéricos (19-oct-2026): lo que tiene
 * forma de código de barras y lo que supera el tope no se acepta; lo normal
 * pasa. Lógica pura que usan CurrencyInput, QuantityInput, PercentInput y los
 * controles previos de Ventas, Compras, Presupuestos y Artículos.
 *   pnpm --filter @stockflow/desktop test:entrada-numerica
 */
import { TOPES as TOPES_SERVIDOR } from '@stockflow/shared';
import {
  avisoDeCodigoEnCasillero,
  evaluarEntrada,
  porcentajeValido,
  primerExcesoDelCarrito,
} from '../../src/lib/entradaNumerica';
import { parseCurrencyInput } from '../../src/lib/format';
import { MENSAJE_CANTIDAD_ALTA, MENSAJE_IMPORTE_ALTO, TOPES } from '../../src/lib/topes';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}
const padron = (v: string) => v === '7790000000031' || v === '1234';
const tipo = (t: Parameters<typeof evaluarEntrada>[0], texto: string, anterior = '') => evaluarEntrada(t, texto, anterior, padron).tipo;

// ── Los topes de la pantalla SON los del servidor (un solo lugar) ──
check(JSON.stringify(TOPES) === JSON.stringify(TOPES_SERVIDOR), 'la pantalla lee los mismos topes que el servidor', `${JSON.stringify(TOPES)} vs ${JSON.stringify(TOPES_SERVIDOR)}`);

// ── Lo normal NO molesta ──
check(tipo('importe', '1500') === 'aceptar', 'importe de $1500');
check(tipo('importe', '1234,50') === 'aceptar', 'importe con coma decimal');
check(tipo('importe', '12.000.000') === 'aceptar', 'importe con puntos de miles (aunque sea de 8 dígitos)');
check(tipo('importe', '4180660') === 'aceptar', 'el cierre de caja real más alto ($4.180.660: 7 dígitos)');
check(tipo('importe', '934300') === 'aceptar', 'la apertura real más alta ($934.300)');
check(tipo('precio', '654250') === 'aceptar', 'el precio real más alto ($654.250)');
check(tipo('precio', '3000000') === 'aceptar', 'un arma de $3.000.000');
check(tipo('cantidad', '10800') === 'aceptar', 'la cantidad real más alta (10.800)');
check(tipo('cantidad', '100000') === 'aceptar', '100.000 unidades de un artículo barato');
check(tipo('cantidad', '2,5') === 'aceptar', 'cantidad con coma decimal');
check(tipo('stock', '909') === 'aceptar', 'stock de 909');
check(tipo('importe', '') === 'aceptar', 'vacío');
check(tipo('importe', '12345678', '12345678') === 'aceptar', 'lo que ya estaba (aunque alto) no se vuelve a juzgar');

// ── Los códigos de barras NO entran ──
for (const t of ['importe', 'precio', 'cantidad', 'stock'] as const) {
  check(tipo(t, '7790000000031') === 'codigo', `EAN-13 como ${t}`);
  check(tipo(t, '77900000000311') === 'codigo', `el código pegado a un 1 (el caso real) como ${t}`);
  check(tipo(t, '77927988') === 'codigo', `EAN-8 como ${t}`);
  check(tipo(t, '779000000003') === 'codigo', `UPC-A de 12 dígitos como ${t}`);
}
check(tipo('stock', '10.0007791234567890') === 'codigo' && tipo('cantidad', '1,57790000000031') === 'codigo' && tipo('importe', '1500,5779123456789') === 'codigo', 'un código PEGADO a un valor con decimales («10.000» + código)');
check(tipo('importe', '0,00005') === 'aceptar' && tipo('importe', '12345678,5') === 'aceptar', 'cinco decimales o un importe de 8 dígitos con coma no son códigos');
check(tipo('cantidad', '1234') === 'codigo', 'el código CORTO de un artículo del padrón, como cantidad');
check(tipo('importe', '1234') === 'aceptar', 'pero 1234 como importe es un importe (los códigos cortos del padrón son importes de todos los días)');
check(avisoDeCodigoEnCasillero('importe').includes('12.000.000'), 'el aviso del importe explica cómo escribir un importe grande');
check(!/\btú\b|\bvos\b|\btenés\b|\bescribí\b/i.test(avisoDeCodigoEnCasillero('importe') + avisoDeCodigoEnCasillero('cantidad')), 'avisos sin tutear');

// ── Lo que supera el tope NO entra, aunque no parezca código ──
check(tipo('cantidad', '1.000.001') === 'excede', 'cantidad de 1.000.001 (con separadores)');
check(tipo('cantidad', '1000000') === 'aceptar', 'cantidad EXACTA en el tope');
check(tipo('precio', '100.000.001') === 'excede', 'precio de $100.000.001');
check(tipo('precio', '100.000.000') === 'aceptar', 'precio EXACTO en el tope');
check(tipo('importe', '1.000.000.001') === 'excede', 'importe de $1.000.000.001');
check(tipo('stock', '100.000.001') === 'excede', 'stock de 100.000.001');
check(tipo('importe', '9999999999999999999999999,5') === 'excede', 'un número de 25 dígitos con coma (notación científica al convertir)');
const e = evaluarEntrada('importe', '5.000.000.000');
check(e.tipo === 'excede' && e.mensaje === MENSAJE_IMPORTE_ALTO, 'el aviso del importe es el texto acordado', JSON.stringify(e));
const c = evaluarEntrada('cantidad', '5.000.000');
check(c.tipo === 'excede' && c.mensaje === MENSAJE_CANTIDAD_ALTA, 'el aviso de la cantidad es el texto acordado', JSON.stringify(c));

// ── Parseo de decimales y miles (las otras causas posibles de números altos) ──
check(tipo('importe', '1.234,56') === 'aceptar' && tipo('importe', '1234.56') === 'aceptar' && tipo('importe', '1,5') === 'aceptar', 'los tres formatos de decimales pasan');

// ── parseCurrencyInput: letras y notación científica ya no dan números altos ──
check(parseCurrencyInput('4E10') === '0' && parseCurrencyInput('1e5') === '0' && parseCurrencyInput('0x1F') === '0', 'un código alfanumérico («4E10», «0x1F») ya no se vuelve 40.000.000.000 ni 31');
check(parseCurrencyInput('Infinity') === '0' && parseCurrencyInput('NaN') === '0' && parseCurrencyInput('1e999') === '0', 'Infinity, NaN y desbordes dan cero');
check(/^\d+(\.\d{1,4})?$/.test(parseCurrencyInput('99999999999999999999999')), 'un número de 23 dígitos cumple el contrato decimal (antes salía «1e+23»)', parseCurrencyInput('99999999999999999999999'));
check(parseCurrencyInput('1.234,56') === '1234.56' && parseCurrencyInput('1234.56') === '1234.56' && parseCurrencyInput('1,5') === '1.5' && parseCurrencyInput('$ 1.500,00') === '1500', 'los formatos normales siguen igual');

// ── Control del carrito antes de confirmar ──
check(primerExcesoDelCarrito([{ cantidad: '2', precio: '100', descuento: '0' }], { descuentoGlobal: '0', total: '200' }) === null, 'una venta normal no se frena');
check(primerExcesoDelCarrito([{ cantidad: '7790000000031', precio: '100' }]) === MENSAJE_CANTIDAD_ALTA, 'cantidad = código en el carrito');
check(primerExcesoDelCarrito([{ cantidad: '1', precio: '7790000000031' }]) === MENSAJE_IMPORTE_ALTO, 'precio = código en el carrito');
check(primerExcesoDelCarrito([{ cantidad: '1', precio: '100', descuento: '7790000000031' }]) === MENSAJE_IMPORTE_ALTO, 'descuento = código en el carrito');
check(primerExcesoDelCarrito([{ cantidad: '1', precio: '100' }], { descuentoGlobal: '7790000000031' }) === MENSAJE_IMPORTE_ALTO, 'descuento global = código');
check(primerExcesoDelCarrito([{ cantidad: '1', precio: '100' }], { total: '1e30' }) === MENSAJE_IMPORTE_ALTO, 'total por las nubes');
check(primerExcesoDelCarrito([{ cantidad: '100000', precio: '50' }], { total: '5000000' }) === null, '100.000 unidades a $50 pasan');

// ── Porcentajes ──
check(porcentajeValido('0') && porcentajeValido('10') && porcentajeValido('12,5') && porcentajeValido('100') && porcentajeValido(''), 'porcentajes normales');
check(!porcentajeValido('101') && !porcentajeValido('7790000000031') && !porcentajeValido('-5') && !porcentajeValido('abc'), 'porcentajes imposibles o códigos de barras');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
