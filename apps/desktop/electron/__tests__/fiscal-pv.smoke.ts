/**
 * Aviso claro cuando ARCA rechaza el punto de venta (11002 / 10005): dice cuál
 * número mandó StockFlow y cuáles tiene habilitados ARCA.
 *   pnpm --filter @stockflow/desktop test:fiscal-pv
 */
import { codigoDePuntoDeVenta, explicarPuntoDeVenta } from '../fiscal/explicar-pv';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

check(
  codigoDePuntoDeVenta('11002: El punto de venta no se encuentra habilitado a usar en el presente WS.') === '11002',
  'reconoce el 11002 cuando es el primer error',
);
check(
  codigoDePuntoDeVenta('ARCA rechazó el comprobante: 10005: NO AUTORIZADO A EMITIR COMPROBANTES') === '10005',
  'reconoce el 10005 dentro de un rechazo',
);
check(codigoDePuntoDeVenta('10015: Factura B: DocTipo inválido') === null, 'otros errores de ARCA no se tocan');
check(codigoDePuntoDeVenta('Error 110020: algo') === null, 'no confunde códigos parecidos');

const a = explicarPuntoDeVenta(4, [{ number: 7 }], '11002');
check(a.includes('punto de venta 4') && a.includes('son: 7') && a.includes('(ARCA 11002)'), 'dice cuál mandó y cuáles tiene ARCA', a);
check(a.includes('borre el 4'), 'indica qué hacer con el número equivocado', a);

const b = explicarPuntoDeVenta(4, [], '11002');
check(b.includes('ningún punto de venta') && b.includes('RECE para aplicativo y web services'), 'sin puntos habilitados: explica cómo darlo de alta', b);

const c = explicarPuntoDeVenta(4, null, '10005');
check(c.includes('Consultar en ARCA') && c.includes('(ARCA 10005)'), 'si no se pudo consultar a ARCA, manda a «Consultar en ARCA»', c);

const d = explicarPuntoDeVenta(7, [{ number: 7, blocked: true }], '11002');
check(d.includes('BLOQUEADO'), 'punto bloqueado en ARCA', d);

const e = explicarPuntoDeVenta(7, [{ number: 7 }], '11002');
check(e.includes('figura habilitado'), 'figura habilitado pero ARCA lo rechaza', e);

const f = explicarPuntoDeVenta(4, [{ number: 7, blocked: true }], '11002');
check(f.includes('ningún punto de venta'), 'los bloqueados no cuentan como habilitados', f);

const g = explicarPuntoDeVenta(4, [{ number: 9 }, { number: 5 }], '11002');
check(g.includes('son: 5, 9'), 'lista ordenada', g);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
