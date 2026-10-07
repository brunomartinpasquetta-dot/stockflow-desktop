/**
 * Dirección del servidor vista por una terminal. El caso que rompió en Nemesis
 * (7-oct-2026): por el acceso remoto se entra con https y sin puerto, la
 * dirección se armaba como http://host:7777, el navegador la bloqueaba, el
 * ping fallaba y la terminal quedaba en SÓLO LECTURA: se podía cargar la
 * compra pero el botón «Pagar» nunca se habilitaba.
 *   pnpm --filter @stockflow/desktop test:direccion-servidor
 */
import { direccionDelServidor, urlDePing } from '../../src/lib/direccionServidor';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// Programa instalado (Electron): no hay página servida, se arma como siempre.
check(direccionDelServidor('192.168.0.15', 7777) === 'http://192.168.0.15:7777', 'programa instalado: http://ip:puerto');
check(direccionDelServidor('192.168.0.15', 7777, null) === 'http://192.168.0.15:7777', 'sin dato de la página: igual que siempre');
check(direccionDelServidor('192.168.0.15', 7777, '') === 'http://192.168.0.15:7777', 'dato vacío: igual que siempre');

// Terminal por navegador en la red local: la página vino por la misma dirección.
check(
  direccionDelServidor('192.168.0.15', 7777, 'http://192.168.0.15:7777') === 'http://192.168.0.15:7777',
  'terminal del local: no cambia nada',
);

// ACCESO REMOTO: https y sin puerto. Es el caso que fallaba.
const remoto = direccionDelServidor('algo.trycloudflare.com', 7777, 'https://algo.trycloudflare.com');
check(remoto === 'https://algo.trycloudflare.com', 'acceso remoto: manda la dirección por la que entró', remoto);
check(!remoto.includes(':7777'), 'acceso remoto: NO se le pega el puerto 7777', remoto);
check(remoto.startsWith('https://'), 'acceso remoto: sigue en https (si no, el navegador lo bloquea)', remoto);
check(
  urlDePing('algo.trycloudflare.com', 7777, 'https://algo.trycloudflare.com') === 'https://algo.trycloudflare.com/lan/ping',
  'el chequeo de conexión va por la misma dirección',
);

// Bordes.
check(direccionDelServidor('10.0.0.2', 7777, 'https://x.com/') === 'https://x.com', 'saca la barra del final');
check(direccionDelServidor('10.0.0.2', 7777, 'https://x.com///') === 'https://x.com', 'saca varias barras del final');
check(direccionDelServidor('10.0.0.2', 7777, 'file://') === 'http://10.0.0.2:7777', 'una página local (file://) no sirve como dirección');
check(direccionDelServidor('10.0.0.2', 7777, 'vaya a saber') === 'http://10.0.0.2:7777', 'un valor raro no rompe: se usa el de siempre');
check(urlDePing('10.0.0.2', 7777) === 'http://10.0.0.2:7777/lan/ping', 'chequeo de conexión en la red local');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
