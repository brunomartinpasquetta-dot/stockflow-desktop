/**
 * Tema claro / oscuro (pedido de Bruno, 10-oct-2026).
 *
 * Se prueba la parte decidible sin navegador: qué tema queda guardado, qué se
 * lee cuando no hay nada o hay basura, y la regla «¿va oscuro?» según la
 * preferencia y el dispositivo. Lo visual se mira en la ventana real.
 *   pnpm --filter @stockflow/desktop test:tema
 */
import { debeIrOscuro, ETIQUETAS_TEMA, guardarTema, leerTema } from '../../src/lib/tema';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// localStorage mínimo, como el del navegador, para probar leer/guardar.
const memoria = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => memoria.get(k) ?? null,
  setItem: (k: string, v: string) => void memoria.set(k, String(v)),
  removeItem: (k: string) => void memoria.delete(k),
  clear: () => memoria.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

// ── La regla, pura ─────────────────────────────────────────────────────────
check(debeIrOscuro('oscuro', false) === true, '«Oscuro» va oscuro aunque el dispositivo esté en claro');
check(debeIrOscuro('claro', true) === false, '«Claro» va claro aunque el dispositivo esté en oscuro');
check(debeIrOscuro('sistema', true) === true, '«Según el dispositivo» con el dispositivo en oscuro → oscuro');
check(debeIrOscuro('sistema', false) === false, '«Según el dispositivo» con el dispositivo en claro → claro');

// ── Lo guardado en esta PC ─────────────────────────────────────────────────
check(leerTema() === 'claro', 'sin nada guardado, arranca claro (así nadie nota un cambio al actualizar)');
memoria.set('stockflow:tema', 'cualquier cosa');
check(leerTema() === 'claro', 'con basura guardada, vuelve a claro en vez de romper');

guardarTema('oscuro');
check(memoria.get('stockflow:tema') === 'oscuro', 'guardar «oscuro» lo deja en esta PC');
check(leerTema() === 'oscuro', 'y se vuelve a leer «oscuro»');
guardarTema('claro');
check(leerTema() === 'claro', 'cambiar a «claro» pisa lo anterior');

// ── Las etiquetas que ve el usuario ───────────────────────────────────────
check(ETIQUETAS_TEMA.claro === 'Claro', 'la opción por defecto se llama «Claro»');
check(ETIQUETAS_TEMA.sistema === 'Según el dispositivo', 'la de la tablet se llama «Según el dispositivo»');
check(
  Object.keys(ETIQUETAS_TEMA).length === 3,
  'hay exactamente tres opciones: claro, oscuro y según el dispositivo',
);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
