/**
 * Calculador de vuelto de Ventas (casilla "Calcular vuelto"): la cuenta es
 * informativa y se hace sobre lo que se cobra en efectivo.
 *   pnpm --filter @stockflow/desktop test:vuelto
 */
import { calcularVuelto } from '../../src/lib/vuelto';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

const a = calcularVuelto(10000, 7350);
check(a.vuelto === 2650 && a.falta === 0, 'paga con $10.000 una venta de $7.350 → vuelto $2.650', JSON.stringify(a));
const b = calcularVuelto(5000, 7350);
check(b.vuelto === 0 && b.falta === 2350, 'si el billete no alcanza, dice cuánto falta', JSON.stringify(b));
const c = calcularVuelto(7350, 7350);
check(c.vuelto === 0 && c.falta === 0, 'pago justo → sin vuelto', JSON.stringify(c));
const d = calcularVuelto(1000.1, 999.99);
check(d.vuelto === 0.11, 'redondea a centavos', JSON.stringify(d));
check(calcularVuelto(0, 500).vuelto === 0 && calcularVuelto(500, 0).vuelto === 0, 'sin "paga con" o sin efectivo no calcula nada');
check(calcularVuelto(Number.NaN, 500).falta === 0, 'un valor inválido no rompe la pantalla');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
