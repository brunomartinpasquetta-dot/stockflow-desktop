/**
 * "Enter confirma la venta": con el buscador vacío y artículos cargados, Enter
 * hace lo que F2. Viene activado; la casilla lo apaga y se recuerda en cada PC.
 *   pnpm --filter @stockflow/desktop test:ventas-enter
 */
import { destinoDelEnter, enterDebeConfirmar, guardarEnterConfirma, leerEnterConfirma, MS_ENTRE_AGREGAR_Y_CONFIRMAR } from '../../src/lib/enterConfirma';

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


// ── Dónde está el foco (Enter desde cualquier lugar de la pantalla) ──
check(destinoDelEnter({ tagName: 'INPUT', type: 'text' }, true) === 'buscador', 'en el buscador: lo maneja el buscador');
check(destinoDelEnter({ tagName: 'INPUT', type: 'checkbox' }, false) === 'confirmar', 'después de tocar una casilla: confirma');
check(destinoDelEnter({ tagName: 'INPUT', type: 'radio' }, false) === 'confirmar', 'opción de radio: confirma');
check(destinoDelEnter({ tagName: 'SELECT' }, false) === 'confirmar', 'después de cambiar una lista (forma de pago, lista de precios): confirma');
check(destinoDelEnter({ tagName: 'BODY' }, false) === 'confirmar', 'foco en el fondo: confirma');
check(destinoDelEnter(null, false) === 'confirmar', 'sin elemento enfocado: confirma');
check(destinoDelEnter({ tagName: 'INPUT', type: 'text' }, false) === 'confirmar', 'con el cursor en un campo (cantidad, documento…): confirma');
check(destinoDelEnter({ tagName: 'INPUT' }, false) === 'confirmar', 'input sin tipo explícito: confirma');
check(destinoDelEnter({ tagName: 'INPUT', type: 'number' }, false) === 'confirmar', 'campo numérico: confirma');
check(destinoDelEnter({ tagName: 'BUTTON', focusVisible: false }, false) === 'confirmar', 'botón que quedó enfocado por un clic del mouse: confirma (no lo vuelve a activar)');
check(destinoDelEnter({ tagName: 'DIV', role: 'button', focusVisible: false }, false) === 'confirmar', 'elemento con rol de botón enfocado por mouse: confirma');
check(destinoDelEnter({ tagName: 'INPUT', type: 'submit', focusVisible: false }, false) === 'confirmar', 'input de tipo botón enfocado por mouse: confirma');
check(destinoDelEnter({ tagName: 'BUTTON', focusVisible: true }, false) === 'propio', 'botón al que se llegó con Tab: Enter lo activa (accesibilidad)');
check(destinoDelEnter({ tagName: 'A', focusVisible: true }, false) === 'propio', 'enlace al que se llegó con Tab: Enter lo sigue');
check(destinoDelEnter({ tagName: 'BUTTON' }, false) === 'confirmar', 'si no se sabe cómo llegó el foco, se trata como mouse');
check(destinoDelEnter({ tagName: 'TEXTAREA' }, false) === 'propio', 'área de texto: Enter es salto de línea');
check(destinoDelEnter({ tagName: 'DIV', isContentEditable: true }, false) === 'propio', 'texto editable: Enter es suyo');

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
