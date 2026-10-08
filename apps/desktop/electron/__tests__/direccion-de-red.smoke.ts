/**
 * Avisar cuando la dirección de la PC servidor no le sirve a las terminales.
 * Un comercio escribió en la otra PC una dirección 169.254 (la que Windows se
 * inventa cuando no consigue una del router) y nunca conectó (8-oct-2026).
 *   pnpm --filter @stockflow/desktop test:direccion-de-red
 */
import { direccionInservible, motivoDireccionInservible } from '../../src/lib/direccionDeRed';

let fallas = 0;
function check(ok: boolean, que: string): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}`);
}

check(!direccionInservible('192.168.1.50'), 'una dirección normal del router sirve');
check(!direccionInservible('192.168.18.179'), 'otra dirección normal sirve');
check(!direccionInservible('10.0.0.8'), 'una red 10.x sirve');
check(!direccionInservible('172.16.4.2'), 'una red 172.16 sirve');
check(direccionInservible('169.254.154.210'), 'la del caso real: 169.254 NO sirve');
check(direccionInservible('169.254.0.1'), 'cualquier 169.254 no sirve');
check(direccionInservible('127.0.0.1'), 'la de esta misma PC no le sirve a las otras');
check(direccionInservible('localhost'), '«localhost» tampoco');
check(!direccionInservible(''), 'sin dato no se avisa nada');
check(!direccionInservible(null), 'sin dirección tampoco');
check(!direccionInservible('169.255.1.1'), 'una parecida pero válida sí sirve');

check((motivoDireccionInservible('169.254.154.210') ?? '').includes('router'), 'el aviso del 169.254 manda a revisar el router');
check((motivoDireccionInservible('127.0.0.1') ?? '').includes('esta misma PC'), 'el aviso de 127.0.0.1 explica por qué no sirve');
check(motivoDireccionInservible('192.168.1.50') === null, 'una dirección buena no muestra aviso');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
