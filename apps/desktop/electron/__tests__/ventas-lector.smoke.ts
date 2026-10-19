/**
 * Lector de códigos en Ventas (16-oct-2026): Enter ya no confirma la venta y el
 * foco vuelve siempre al buscador. Lógica pura: qué teclas se desvían al
 * buscador y qué se hace con una cantidad con pinta de código de barras.
 *   pnpm --filter @stockflow/desktop test:ventas-lector
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  avisoImporteConCodigo,
  debeIrAlBuscador,
  decidirCantidad,
  decidirImporte,
  esCampoDeTexto,
  esTeclaDeTexto,
} from '../../src/lib/lectorDeCodigos';

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

// ── Qué tecla escribe ──
check(esTeclaDeTexto({ key: '7' }), 'un dígito escribe');
check(esTeclaDeTexto({ key: 'A' }), 'una letra escribe (códigos alfanuméricos)');
check(esTeclaDeTexto({ key: '-' }), 'el guion escribe (EP-IND-07)');
check(!esTeclaDeTexto({ key: ' ' }), 'el espacio NO se desvía (tilda la casilla / aprieta el botón)');
check(!esTeclaDeTexto({ key: '/' }), 'la barra NO se desvía (atajo de la búsqueda general)');
check(!esTeclaDeTexto({ key: 'Enter' }), 'Enter no es una tecla de texto');
check(!esTeclaDeTexto({ key: 'F2' }), 'F2 no es una tecla de texto');
check(!esTeclaDeTexto({ key: 'Tab' }), 'Tab no es una tecla de texto');
check(!esTeclaDeTexto({ key: 'ArrowDown' }), 'las flechas no son teclas de texto');
check(!esTeclaDeTexto({ key: 'c', ctrlKey: true }), 'Ctrl+C es un atajo');
check(!esTeclaDeTexto({ key: 'v', metaKey: true }), 'Cmd+V es un atajo');
check(!esTeclaDeTexto({ key: '7', altKey: true }), 'Alt+7 es un atajo');

// ── Dónde se escribe ──
check(esCampoDeTexto({ tagName: 'INPUT', type: 'text' }), 'campo de texto (cantidad, documento)');
check(esCampoDeTexto({ tagName: 'INPUT', type: '' }), 'input sin tipo explícito');
check(esCampoDeTexto({ tagName: 'INPUT', type: 'number' }), 'campo numérico (descuento en %)');
check(esCampoDeTexto({ tagName: 'TEXTAREA' }), 'área de texto');
check(esCampoDeTexto({ tagName: 'DIV', isContentEditable: true }), 'texto editable');
check(!esCampoDeTexto({ tagName: 'INPUT', type: 'text', readOnly: true }), 'campo de sólo lectura (N°, fecha): no se escribe');
check(!esCampoDeTexto({ tagName: 'INPUT', type: 'checkbox' }), 'casilla');
check(!esCampoDeTexto({ tagName: 'INPUT', type: 'radio' }), 'opción de radio');
check(!esCampoDeTexto({ tagName: 'SELECT' }), 'lista desplegable (forma de pago, lista de precios)');
check(!esCampoDeTexto({ tagName: 'BUTTON' }), 'botón (tacho, cliente, $/%)');
check(!esCampoDeTexto({ tagName: 'BODY' }), 'el fondo (clic en el total)');
check(!esCampoDeTexto(null), 'nada enfocado');

// ── Desvío al buscador: los casos que antes cobraban la venta ──
const lector = (foco: Parameters<typeof esCampoDeTexto>[0], extra: Partial<Parameters<typeof debeIrAlBuscador>[0]> = {}) =>
  debeIrAlBuscador({ tecla: { key: '7' }, foco, focoEnElBuscador: false, dialogoAbierto: false, ...extra });
check(lector({ tagName: 'BUTTON' }), 'tras tocar el tacho de un renglón: el código va al buscador');
check(lector({ tagName: 'BODY' }), 'tras un clic en el total: el código va al buscador');
check(lector(null), 'sin foco: el código va al buscador');
check(lector({ tagName: 'SELECT' }), 'con el foco en la forma de pago: el código va al buscador');
check(lector({ tagName: 'INPUT', type: 'checkbox' }), 'tras tocar una casilla: el código va al buscador');
check(lector({ tagName: 'INPUT', type: 'text', readOnly: true }), 'tras un clic en el N° de la venta: el código va al buscador');
check(!lector({ tagName: 'INPUT', type: 'text' }, { focoEnElBuscador: true }), 'ya en el buscador: no se toca nada');
check(!lector({ tagName: 'INPUT', type: 'text' }), 'en la cantidad de un renglón: la tecla es del campo');
check(!lector({ tagName: 'BUTTON' }, { dialogoAbierto: true }), 'con un diálogo abierto: no se desvía');
check(!lector({ tagName: 'BODY' }, { tecla: { key: 'Enter' } }), 'Enter no se desvía (no carga ni confirma nada fuera del buscador)');
check(!lector({ tagName: 'INPUT', type: 'checkbox' }, { tecla: { key: ' ' } }), 'el espacio sobre una casilla sigue tildándola');

// ── Cantidad con pinta de código de barras ──
const padron = (v: string) => v === '7790000000031' || v === '7792798810639';
const d = (texto: string, anterior = '1') => decidirCantidad(texto, anterior, padron);
check(d('2').tipo === 'aceptar', 'cantidad normal: se acepta');
check(d('2,5').tipo === 'aceptar', 'con coma decimal: se acepta');
check(d('144').tipo === 'aceptar', 'un bulto grande: se acepta');
check(d('').tipo === 'aceptar', 'vacío: se acepta (de eso se encarga el total)');
const c = d('7790000000031');
check(c.tipo === 'codigo' && c.codigo === '7790000000031', 'código del padrón como cantidad: se rechaza y se informa el código', JSON.stringify(c));
const c2 = d('77900000000311');
check(c2.tipo === 'codigo' && c2.codigo === '7790000000031', 'el caso real: código + la cantidad anterior pegada atrás (cursor al principio): se reconoce el código', JSON.stringify(c2));
const c3 = d('27790000000031', '2');
check(c3.tipo === 'codigo' && c3.codigo === '7790000000031', 'la cantidad anterior pegada adelante (cursor al final): se reconoce el código', JSON.stringify(c3));
const c4 = d('99990000000001');
check(c4.tipo === 'codigo' && c4.codigo === '99990000000001', 'un código que no es de ningún artículo: se rechaza igual (se informa tal cual)', JSON.stringify(c4));
check(d('77900000').tipo === 'codigo', 'ocho dígitos: es un código, se rechaza');
check(d('12000').tipo === 'preguntar', 'inusualmente alta: se pide confirmación');
check(d('12000', '12000').tipo === 'aceptar', 'una cantidad alta ya confirmada no se vuelve a preguntar');
check(d(' 3 ', '3').tipo === 'aceptar', 'sin cambios: se acepta');

// ── Precio y descuento con pinta de código de barras (misma protección) ──
const p = (texto: string, anterior = '1500') => decidirImporte(texto, anterior, padron);
check(p('1800').tipo === 'aceptar', 'precio normal: se acepta');
check(p('1234,5').tipo === 'aceptar', 'precio con decimales: se acepta');
check(p('12000').tipo === 'aceptar', 'precio alto: se acepta SIN preguntar (no es una cantidad)');
check(p('15000000,00').tipo === 'aceptar', 'quince millones con decimales: es un importe, se acepta');
check(p('0', '1500').tipo === 'aceptar', 'cero: se acepta');
check(p('', '1500').tipo === 'aceptar', 'vacío: se acepta');
check(p('1500', '1500').tipo === 'aceptar', 'sin cambios: se acepta');
const pc = p('7790000000031');
check(pc.tipo === 'codigo' && pc.codigo === '7790000000031', 'código del padrón como precio: se rechaza y se informa el código', JSON.stringify(pc));
const pc2 = p('15007790000000031');
check(pc2.tipo === 'codigo' && pc2.codigo === '7790000000031', 'código pegado detrás del precio anterior (cursor al final): se reconoce', JSON.stringify(pc2));
const pc3 = p('77900000000311500');
check(pc3.tipo === 'codigo' && pc3.codigo === '7790000000031', 'código pegado delante del precio anterior (cursor al principio): se reconoce', JSON.stringify(pc3));
const pc4 = p('99990000000001');
check(pc4.tipo === 'codigo' && pc4.codigo === '99990000000001', 'un código que no es de ningún artículo: se rechaza igual', JSON.stringify(pc4));
check(p('77900000').tipo === 'codigo', 'ocho dígitos: es un código, se rechaza');
check(p('7790000', '1500').tipo === 'aceptar', 'siete dígitos sin coma: un precio, se acepta');
const dsc = (texto: string, anterior = '0') => decidirImporte(texto, anterior, padron);
check(dsc('100').tipo === 'aceptar', 'descuento normal: se acepta');
check(dsc('15,5').tipo === 'aceptar', 'descuento con decimales: se acepta');
const dc = dsc('7792798810639');
check(dc.tipo === 'codigo' && dc.codigo === '7792798810639', 'código del padrón como descuento: se rechaza', JSON.stringify(dc));
const dc2 = dsc('07792798810639');
check(dc2.tipo === 'codigo' && dc2.codigo === '7792798810639', 'con el 0 del descuento pegado adelante: se reconoce el código', JSON.stringify(dc2));
const dc3 = dsc('77927988106390');
check(dc3.tipo === 'codigo' && dc3.codigo === '7792798810639', 'con el 0 del descuento pegado atrás: se reconoce el código', JSON.stringify(dc3));
// Comercios migrados: el padrón tiene códigos internos cortos que coinciden con los importes de todos los días.
const padronConCortos = (v: string) => ['100', '250', '1500', '15', '124', '7790000000031'].includes(v)
const pcorto = (texto: string, anterior = '1800') => decidirImporte(texto, anterior, padronConCortos)
check(pcorto('1500').tipo === 'aceptar', 'precio 1500 con un artículo de código «1500» en el padrón: es un importe, se acepta', JSON.stringify(pcorto('1500')));
check(pcorto('100').tipo === 'aceptar', 'precio 100 con un artículo de código «100»: se acepta', JSON.stringify(pcorto('100')));
check(pcorto('250').tipo === 'aceptar', 'precio 250 con un artículo de código «250»: se acepta', JSON.stringify(pcorto('250')));
check(pcorto('124').tipo === 'aceptar', 'precio 124 con un artículo de código «124»: se acepta', JSON.stringify(pcorto('124')));
check(pcorto('15', '0').tipo === 'aceptar', 'descuento 15 con un artículo de código «15»: se acepta', JSON.stringify(pcorto('15', '0')));
check(pcorto('100', '0').tipo === 'aceptar', 'descuento 100 con un artículo de código «100»: se acepta', JSON.stringify(pcorto('100', '0')));
check(pcorto('1234567').tipo === 'aceptar', 'siete dígitos: sigue siendo un precio aunque haya códigos cortos en el padrón');
const pcc = pcorto('7790000000031');
check(pcc.tipo === 'codigo' && pcc.codigo === '7790000000031', 'con códigos cortos en el padrón, un código de barras largo sigue protegido', JSON.stringify(pcc));
const pcc2 = pcorto('15007790000000031', '1500');
check(pcc2.tipo === 'codigo' && pcc2.codigo === '7790000000031', 'con códigos cortos en el padrón, el código pegado al precio anterior se sigue reconociendo', JSON.stringify(pcc2));
check(
  avisoImporteConCodigo('precio', 'Coca Cola 1,5 L') === 'El precio ingresado es el código de barras de «Coca Cola 1,5 L». Se mantuvo el precio anterior y el artículo se agregó a la venta.',
  'aviso de precio con artículo conocido',
  avisoImporteConCodigo('precio', 'Coca Cola 1,5 L'),
);
check(
  avisoImporteConCodigo('descuento', null) === 'El descuento ingresado parece un código de barras escaneado por error. Se mantuvo el descuento anterior.',
  'aviso de descuento con código desconocido',
  avisoImporteConCodigo('descuento', null),
);

// ── Enter confirma la venta: eliminado del todo ──
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ventas = readFileSync(join(raiz, 'src', 'pages', 'Ventas.tsx'), 'utf8');
check(!existsSync(join(raiz, 'src', 'lib', 'enterConfirma.ts')), 'lib/enterConfirma.ts ya no existe');
check(!/enterConfirma|enterDebeConfirmar|destinoDelEnter/.test(ventas.replace(/\/\/.*$/gm, '')), 'Ventas ya no usa la lógica de «Enter confirma la venta»');
check(!ventas.includes('Enter confirma la venta</span>'), 'la casilla «Enter confirma la venta» ya no está');
check(ventas.includes('Confirmar venta (F2) — {formatCurrency(totals.total)}'), 'el botón verde dice «Confirmar venta (F2)»');
check(!ventas.includes('Confirmar venta (Enter)'), 'la pantalla de vuelto ya no dice «(Enter)»');
check(/if \(e\.key === 'Enter'\) commitBarcode\(\)/.test(ventas), 'en el buscador, Enter sólo carga el artículo');

// ── Precio y descuento protegidos en la pantalla ──
check((ventas.match(/onBlur=\{\(e\) => cerrarImporte\(i, e\.currentTarget\.value\)\}/g) ?? []).length === 2, 'precio y descuento deciden al salir del campo (también tras el Enter)');
check(ventas.includes("campo: 'precio', valor: l.unitPrice, manual: l.priceManuallySet"), 'el precio guarda al entrar el valor y si era manual, para restaurarlo igual');
check(ventas.includes("campo: 'descuento', valor: l.discount"), 'el descuento guarda al entrar el valor anterior');
check(/if \(entrada\.campo === 'precio'\) setLinePrice\(i, entrada\.valor, entrada\.manual\)/.test(ventas), 'un código en el precio restaura el precio anterior sin marcarlo como manual');
check(/else setLineDiscount\(i, entrada\.valor\)/.test(ventas), 'un código en el descuento restaura el descuento anterior');
check(/toast\.warning\(avisoImporteConCodigo\(entrada\.campo, articulo\?\.description \?\? null\)/.test(ventas) && /if \(articulo\) addArticle\(articulo\)/.test(ventas), 'avisa y, si el código es de un artículo, lo agrega a la venta');

console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
process.exit(fallas ? 1 : 0);
