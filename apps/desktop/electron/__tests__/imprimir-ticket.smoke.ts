/**
 * "Imprimir ticket": la casilla de Ventas tiene que valer también para las
 * devoluciones aunque la PC no tenga configuración de impresora guardada.
 *   pnpm --filter @stockflow/desktop test:imprimir-ticket
 */
import { guardarImprimirTicketLocal, imprimirTicketActivado, leerImprimirTicketLocal } from '../../src/lib/imprimirTicket';

let fallas = 0;
function check(ok: boolean, que: string): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}`);
}

// Sin almacenamiento (Node): activado, sin romper.
check(leerImprimirTicketLocal() === null, 'sin almacenamiento no hay elección local');
check(imprimirTicketActivado(null) === true, 'sin configuración ni elección: activado (como siempre)');
guardarImprimirTicketLocal(false);

const memoria = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => memoria.get(k) ?? null,
  setItem: (k: string, v: string) => void memoria.set(k, v),
};
check(leerImprimirTicketLocal() === null, 'nunca se tocó: null');
check(imprimirTicketActivado(null) === true, 'nunca se tocó: activado');

guardarImprimirTicketLocal(false);
check(leerImprimirTicketLocal() === false, 'destildada en esta PC: se recuerda');
check(imprimirTicketActivado(null) === false, 'PC SIN configuración de impresora y casilla destildada: NO imprime (el caso del cliente)');
check(imprimirTicketActivado(undefined) === false, 'configuración inexistente (undefined): lo elegido en la PC');
check(imprimirTicketActivado({}) === false, 'configuración vieja sin el valor: lo elegido en la PC');

check(imprimirTicketActivado({ autoPrintOnSale: true }) === true, 'la configuración de la impresora manda cuando trae el valor (activado)');
guardarImprimirTicketLocal(true);
check(imprimirTicketActivado({ autoPrintOnSale: false }) === false, 'la configuración de la impresora manda cuando trae el valor (apagado)');
check(imprimirTicketActivado(null) === true, 'tildada en esta PC y sin configuración: imprime');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
