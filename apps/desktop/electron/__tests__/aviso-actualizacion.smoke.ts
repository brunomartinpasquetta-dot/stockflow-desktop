/**
 * Aviso de versión nueva. El caso que falló en Nemesis (7-oct-2026): el aviso
 * dependía de que GitHub contestara y de que la descarga de 125 MB terminara;
 * si fallaba, el comercio NO se enteraba nunca de que había versión nueva.
 * Ahora, si GitHub no contesta, se le pregunta a la página de BPSG.
 *   pnpm --filter @stockflow/desktop test:aviso-actualizacion
 */
import { instaladorDeBpsg, versionDesdeBpsg } from '../updater';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// ── Instalador según el sistema ──
check(instaladorDeBpsg('win32') === 'https://bpsgsistemas.com/dl/StockFlow-Setup.exe', 'Windows baja el instalador .exe');
check(instaladorDeBpsg('darwin') === 'https://bpsgsistemas.com/dl/StockFlow.dmg', 'Mac baja el .dmg');
check(!instaladorDeBpsg('win32').includes('.dmg'), 'a Windows NUNCA se le ofrece el instalador de Mac');

// ── Lectura de la versión publicada ──
const con = (texto: string | null) => versionDesdeBpsg(async () => texto);

check((await con('v1.14.3'))?.latestVersion === '1.14.3', 'lee la versión y le saca la "v"');
check((await con('1.14.3'))?.latestVersion === '1.14.3', 'también sin la "v"');
check((await con('v1.14.3\n'))?.latestVersion === '1.14.3', 'ignora el salto de línea del final');
check((await con(' v1.15.0 '))?.latestVersion === '1.15.0', 'ignora espacios');
check((await con('v1.15.0-beta.1'))?.latestVersion === '1.15.0-beta.1', 'acepta una versión de prueba');
check((await con('1.14.3'))?.downloadUrl === instaladorDeBpsg(), 'devuelve el instalador de este sistema');

// ── Nada raro pasa por válido ──
check((await con(null)) === null, 'si la página no contesta, no inventa versión');
check((await con('')) === null, 'respuesta vacía: no hay versión');
check((await con('<!doctype html><title>404</title>')) === null, 'una página de error NO se toma como versión');
check((await con('la última es la 1.14.3')) === null, 'texto suelto: no es una versión');
check((await con('1.14')) === null, 'una versión incompleta no vale');
check((await con('v9'.repeat(40))) === null, 'una respuesta enorme no vale');
check(
  (await versionDesdeBpsg(async () => { throw new Error('sin internet'); })) === null,
  'sin internet no rompe: devuelve nada y se reintenta después',
);

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
