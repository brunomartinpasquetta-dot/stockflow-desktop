/**
 * Ventanas de módulo dentro de la pantalla (Nemesis, 6-oct-2026): ninguna abre
 * más grande que el área útil, el mínimo nunca supera la pantalla y, si la
 * página necesita más lugar del que hay, el contenido se achica (zoom ≥ 0,75).
 */
import { medidasDeVentana } from '../medidas-ventana';

let fallas = 0;
function check(ok: boolean, msg: string, extra?: unknown): void {
  console.log(`${ok ? '✅' : '❌'} ${msg}${ok || extra === undefined ? '' : ' → ' + JSON.stringify(extra)}`);
  if (!ok) fallas++;
}

const dentro = (m: ReturnType<typeof medidasDeVentana>, a: { x: number; y: number; width: number; height: number }) =>
  m.x >= a.x && m.y >= a.y && m.x + m.width <= a.x + a.width && m.y + m.height <= a.y + a.height &&
  m.minWidth <= m.width && m.minHeight <= m.height;

// 1366×768 al 125 %: ≈ 1093×574 útiles. La página pide 1360×820 con mínimo 1100×700.
const chica = { x: 0, y: 0, width: 1093, height: 574 };
const m1 = medidasDeVentana(chica, { width: 1360, height: 820, minWidth: 1100, minHeight: 700 });
check(dentro(m1, chica), 'pantalla chica: la ventana y su mínimo entran en el área útil', m1);
check(m1.zoom < 1 && m1.zoom >= 0.75, 'pantalla chica: el contenido se achica con zoom entre 0,75 y 1', m1.zoom);

// 1920×1080 al 100 %: área útil 1920×1040. Respeta lo que pide la página.
const grande = { x: 0, y: 0, width: 1920, height: 1040 };
const m2 = medidasDeVentana(grande, { width: 1360, height: 820, minWidth: 1100, minHeight: 700 });
check(m2.width === 1360 && m2.height === 820 && m2.minWidth === 1100 && m2.minHeight === 700 && m2.zoom === 1,
  'pantalla grande: tamaño y mínimo como los pide la página, sin zoom', m2);

// Sin tamaño pedido: ~92 % del área con tope 1500×900, centrada.
const m3 = medidasDeVentana(grande, {});
check(m3.width === 1500 && m3.height === 900 && m3.x === 210 && m3.y === 70, 'por defecto: 92 % con tope y centrada', m3);

// Segundo monitor a la derecha: la ventana queda en ESE monitor.
const segundo = { x: 1920, y: 0, width: 1280, height: 984 };
const m4 = medidasDeVentana(segundo, { width: 1200, height: 760, minWidth: 1000, minHeight: 600 });
check(dentro(m4, segundo), 'segundo monitor: la ventana se ubica dentro de ese monitor', m4);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
