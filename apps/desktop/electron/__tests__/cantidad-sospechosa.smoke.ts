/**
 * Freno a la cantidad escaneada por error (8-oct-2026): un código de barras
 * tipeado en el casillero de CANTIDAD dejó una compra de 215.841 unidades por
 * $485 millones. Avisa, no bloquea.
 *   pnpm --filter @stockflow/desktop test:cantidad-sospechosa
 */
import { cantidadSospechosa } from '../../src/lib/cantidadSospechosa';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}
const padron = (v: string) => v === '7792798810639' || v === '2000000009827';
const s = (c: string | number) => cantidadSospechosa(c, padron);

// Lo normal NO molesta.
check(s('1') === null, 'una unidad: no avisa');
check(s('12') === null, 'una docena: no avisa');
check(s('144') === null, 'un bulto grande: no avisa');
check(s('1500') === null, 'mil quinientas unidades: no avisa');
check(s('0.5') === null, 'medio kilo: no avisa');
check(s('2,5') === null, 'con coma decimal: no avisa');
check(s('') === null, 'vacío: no avisa');
check(s('0') === null, 'cero: no avisa (de eso se encarga el total)');
check(s('abc') === null, 'texto suelto: no rompe');
check(s('-5') === null, 'negativo: no avisa acá');

// Lo que sí hay que frenar.
check(s('7792798810639') === 'parece-codigo', 'el código de barras de un artículo del padrón');
check(s('2000000009827') === 'parece-codigo', 'otro código del padrón');
check(s('77927988') === 'parece-codigo', 'ocho dígitos ya es un código de barras');
check(s('215841') === 'muy-alta', 'el caso real del comercio: 215.841 unidades');
check(s('10000') === 'muy-alta', 'justo en el límite de lo creíble');
check(s('9999') === null, 'un poco por debajo del límite: no molesta');
check(s('99999999999') === 'parece-codigo', 'un número enorme de muchos dígitos');

// Sin padrón a mano sigue funcionando por la cantidad de dígitos.
check(cantidadSospechosa('7792798810639') === 'parece-codigo', 'sin padrón, por los dígitos');
check(cantidadSospechosa('500') === null, 'sin padrón, una cantidad normal no molesta');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
