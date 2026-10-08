/**
 * Cuentas del cierre de caja: cuánto es «electrónico» y cuánto pasa a Caja
 * General con el cambio que queda en el cajón (pedido de Bruno, 8-oct-2026).
 *   pnpm --filter @stockflow/desktop test:caja-cierre
 */
import {
  cambioSuperaLoContado,
  netoElectronico,
  totalParaCajaGeneral,
} from '../../src/lib/caja';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// ── Electrónico ───────────────────────────────────────────────────────────
check(netoElectronico([]) === '0.00', 'sin medios, cero');
check(
  netoElectronico([{ isPhysicalCash: true, net: '5000' }]) === '0.00',
  'el efectivo NO cuenta como electrónico',
);
check(
  netoElectronico([
    { isPhysicalCash: false, net: '1000' },
    { isPhysicalCash: false, net: '500' },
  ]) === '1500.00',
  'suma los medios no efectivo',
);
// EL BUG que trababa el cierre: con piso cero POR MEDIO daba 1000 en pantalla
// y 600 en el servidor, y el cierre se rechazaba (DEPOSIT_OVER_ELECTRONIC).
check(
  netoElectronico([
    { isPhysicalCash: false, net: '1000' },
    { isPhysicalCash: false, net: '-400' },
  ]) === '600.00',
  'una devolución por transferencia BAJA lo cobrado (bug del cierre trabado)',
);
check(
  netoElectronico([
    { isPhysicalCash: false, net: '100' },
    { isPhysicalCash: false, net: '-400' },
  ]) === '0.00',
  'si el neto da negativo, es cero: no se lleva plata del efectivo',
);
check(
  netoElectronico([{ isPhysicalCash: null, net: '300' }]) === '300.00',
  'un medio sin el dato de efectivo físico cuenta como electrónico',
);

// ── Lo que pasa a Caja General ────────────────────────────────────────────
const sinCambio = totalParaCajaGeneral('10000', '0', '2000');
check(
  sinCambio.efectivo === '10000.00' && sinCambio.total === '12000.00',
  'sin cambio: entra todo el efectivo contado más lo electrónico',
);
const conCambio = totalParaCajaGeneral('10000', '3000', '2000');
check(
  conCambio.efectivo === '7000.00' && conCambio.total === '9000.00',
  'el cambio que queda en el cajón NO entra a Caja General',
);
const todoCambio = totalParaCajaGeneral('5000', '5000', '0');
check(
  todoCambio.efectivo === '0.00' && todoCambio.total === '0.00',
  'si todo el efectivo queda de cambio, no entra nada',
);
const soloElectronico = totalParaCajaGeneral('0', '0', '4500');
check(
  soloElectronico.total === '4500.00',
  'un día sin efectivo igual ingresa lo cobrado por medios electrónicos',
);
check(
  totalParaCajaGeneral('1000', '4000', '0').efectivo === '0.00',
  'un cambio mayor que lo contado nunca produce un efectivo negativo',
);

// ── Tope del cambio ───────────────────────────────────────────────────────
check(cambioSuperaLoContado('10000', '3000') === false, 'un cambio menor a lo contado se acepta');
check(cambioSuperaLoContado('10000', '10000') === false, 'dejar TODO lo contado se acepta');
check(
  cambioSuperaLoContado('10000', '10001') === true,
  'dejar más de lo contado se rechaza (la caja abriría con plata que no existe)',
);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
