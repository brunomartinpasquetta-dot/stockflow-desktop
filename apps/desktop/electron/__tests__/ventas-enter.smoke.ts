/**
 * "Enter confirma la venta": con el buscador vacío y artículos cargados, Enter
 * hace lo que F2. Viene activado; la casilla lo apaga y se recuerda en cada PC.
 *   pnpm --filter @stockflow/desktop test:ventas-enter
 */
import { enterDebeConfirmar, guardarEnterConfirma, leerEnterConfirma, MS_ENTRE_AGREGAR_Y_CONFIRMAR } from '../../src/lib/enterConfirma';

let fallas = 0;
function check(ok: boolean, que: string): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}`);
}

const base = { activo: true, busqueda: '', hayArticulos: true, puedeConfirmar: true, repetida: false, msDesdeElUltimoArticulo: 1000 };
check(enterDebeConfirmar(base), 'casilla tildada + buscador vacío + artículos → confirma');
check(!enterDebeConfirmar({ ...base, activo: false }), 'con la casilla destildada no confirma');
check(!enterDebeConfirmar({ ...base, busqueda: '7790001' }), 'con texto en el buscador Enter carga el artículo, no confirma');
check(enterDebeConfirmar({ ...base, busqueda: '   ' }), 'espacios en blanco cuentan como vacío');
check(!enterDebeConfirmar({ ...base, hayArticulos: false }), 'sin artículos no confirma');
check(!enterDebeConfirmar({ ...base, puedeConfirmar: false }), 'si no se puede confirmar (Factura A sin CUIT, venta en curso…) no confirma');
check(!enterDebeConfirmar({ ...base, repetida: true }), 'Enter mantenido apretado no confirma');
check(!enterDebeConfirmar({ ...base, msDesdeElUltimoArticulo: MS_ENTRE_AGREGAR_Y_CONFIRMAR - 1 }), 'el segundo Enter del lector (CR+LF) pegado al primero no confirma');
check(enterDebeConfirmar({ ...base, msDesdeElUltimoArticulo: MS_ENTRE_AGREGAR_Y_CONFIRMAR }), 'una persona que aprieta Enter de nuevo sí confirma');

// Sin almacenamiento (Node): activado y sin romper.
check(leerEnterConfirma() === true, 'por defecto viene ACTIVADO (sin almacenamiento)');
guardarEnterConfirma(false);
const memoria = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => memoria.get(k) ?? null,
  setItem: (k: string, v: string) => void memoria.set(k, v),
};
check(leerEnterConfirma() === true, 'sin valor guardado viene activado');
guardarEnterConfirma(false);
check(leerEnterConfirma() === false, 'se recuerda al destildarla (apagado en esa PC)');
guardarEnterConfirma(true);
check(leerEnterConfirma() === true, 'se recuerda al volver a tildarla');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
