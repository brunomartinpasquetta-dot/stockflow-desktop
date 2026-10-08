/**
 * Cómo se lee una forma de pago. Bruno, 8-oct-2026: el desplegable decía
 * «Efectivo (efectivo)» — la aclaración sólo sirve cuando el nombre no lo dice.
 *   pnpm --filter @stockflow/desktop test:etiqueta-medio-pago
 */
import { etiquetaMedioPago } from '../../src/lib/etiquetaMedioPago';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}
const e = (name: string, isPhysicalCash = true) => etiquetaMedioPago({ name, isPhysicalCash });

check(e('Efectivo') === 'Efectivo', 'el medio llamado «Efectivo» NO repite la aclaración');
check(e('EFECTIVO') === 'EFECTIVO', 'en mayúsculas tampoco');
check(e('efectivo') === 'efectivo', 'en minúsculas tampoco');
check(e('Contado') === 'Contado', '«Contado» ya se entiende: tampoco aclara');
check(e('Caja chica') === 'Caja chica (efectivo)', 'un nombre que no lo dice SÍ lleva la aclaración');
check(e('Pesos') === 'Pesos (efectivo)', 'otro nombre que no lo dice');
check(e('Transferencia', false) === 'Transferencia', 'los que no son efectivo nunca llevan aclaración');
check(e('Tarjeta de Débito', false) === 'Tarjeta de Débito', 'débito tampoco');
check(e('  Efectivo  ') === 'Efectivo', 'limpia los espacios de los costados');
check(etiquetaMedioPago({ name: 'Efectivo' }) === 'Efectivo', 'sin el dato de efectivo físico, sólo el nombre');
check(e('Efectívo') === 'Efectívo', 'con acento mal puesto lo reconoce igual');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
