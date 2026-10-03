/**
 * Facturas por teléfono — asociación automática renglón → artículo (sin Electron, sin base).
 * Catálogo SINTÉTICO (nombres genéricos de kiosco/almacén, al estilo de un comerciante): no hay datos de clientes.
 * Renglones: los 40 del prototipo (tools/ocr-facturas/asociar.py), los de almacén de vital-12 y vital-14
 * (fixtures/facturas/esperado.json), trampas agregadas a mano y los sondeos contra el catálogo real
 * (tools/ocr-facturas/RESULTADOS.md, 3-oct-2026: cerveza 0.0, "330 X 24", rubro en el medio, SIN/CON GAS, ORIG).
 *   pnpm --filter @stockflow/desktop test:facturas-asociador
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  prepararCatalogo,
  proponerArticulo,
  tamanoDeUnidad,
  type ArticuloParaAsociar,
} from '../facturas/asociador';

const here = dirname(fileURLToPath(import.meta.url));

let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${detalle ? `  → ${detalle}` : ''}`);
}

// ───────────────────────── 1) tamaño de la unidad ─────────────────────────

const TAMANOS: Array<[string, number | null, 'ml' | 'g' | 'u' | null]> = [
  ['AGUA BONAQUA 12X500', 500, 'ml'],
  ['AGUA BONAQUA 6X11/5', 1500, 'ml'],
  ['COCA 6X1 1/2', 1500, 'ml'],
  ['AQUARIUS PERA 6X 1/2', 500, 'ml'],
  ['COCA-COLA VIDRIO 8X1 1/4', 1250, 'ml'],
  ['SPRITE VIDRIO 8X11/4', 1250, 'ml'],
  ['COCA-COLA 6X21/4', 2250, 'ml'],
  ['COCA-COLA RETOR. 8X2 LTS', 2000, 'ml'],
  ['SPRITE RETOR. BX2 LTS', 2000, 'ml'],
  ['SPRITE 6X1500', 1500, 'ml'],
  ['AQUARIUS 1.5L PERA', 1500, 'ml'],
  ['IMPERIAL LAGER LATA 473CC', 473, 'ml'],
  ['VINO 750 ML', 750, 'ml'],
  ['CERVEZA HEINEKEN X 1L X 12', 1000, 'ml'],
  ['CERVEZA IMPERIAL STOUT X 500 X 12', 500, 'ml'],
  ['CERVEZA TEMPLE WOLF IPA 6XX473', 473, 'ml'],
  ['GIN BOMBAY X 750 cc. (12X750)', 750, 'ml'],
  ['GIN BEEFEATER x 1 Lt (6x1000cc', 1000, 'ml'],
  ['RON BACARDI BCO. 12 X 1 LI.', 1000, 'ml'],
  ['PACK (12X750)', 750, 'ml'],
  ['PACK 6x1000cc', 1000, 'ml'],
  ['GANCIA 12X1', 1000, 'ml'],
  ['SODA SIFON ESTAMBUL 6X1,75', 1750, 'ml'],
  ['QUILMES STOUT 1 L', 1000, 'ml'],
  ['COCA COLA 2.25L DESC', 2250, 'ml'],
  ['Limpiador POETT suavidad de bebex4lt', 4000, 'ml'],
  ['Atun S&P desmenuzado en aceite x170gr', 170, 'g'],
  ['Mayonesa NATURA d/p x1kg', 1000, 'g'],
  ['Galletitas CHOCOLINAS x250/262grs', 250, 'g'],
  ['Levadura LEVEX sobre 2x10g', 10, 'g'],
  ['Arroz largo fino MOLINOS ALA g.selx500gr', 500, 'g'],
  ['CALDO ALICANTE X 12U x 7.5 G GALLINA', 7.5, 'g'],
  ['MAIZ PISINGALLO TRIMACER X 5 KG.', 5000, 'g'],
  ['Caldo KNORR gallina deshidratado x12u', 12, 'u'],
  ['Te LA VIRGINIA verde x20sq', 20, 'u'],
  ['Bolsa resid VIRUTEX 45x60 plana 10u', 10, 'u'],
  ['TOALLA diseños surtidos 70x140cm', null, null],
  ['Lampara led PHILIPS ecohome fria 10/12w', null, null],
  ['TORO VINO TINTO T.BRIK', null, null],
  ['Rejilla MEDIA NARANJA reforzada', null, null],
  // sondeos (3-oct-2026): "tamaño X bulto" sin unidad y 0.0 sin pisar el tamaño
  ['STELLA ARTOIS 330 X 24', 330, 'ml'],
  ['CORONA 710 X 12', 710, 'ml'],
  ['OREO 118 X 36', 118, 'ml'],
  ['KESITAS 125 X 24', 125, 'ml'],
  ['HEINEKEN 0.0 X 473 X 6', 473, 'ml'],
  ['HEINEKEN 0,0 LATA X 473 X 6', 473, 'ml'],
  ['STELLA ARTOIS 0.0 330CC', 330, 'ml'],
  ['VILLAVICENCIO SIN GAS 500', 500, 'ml'],
];
{
  const mal: string[] = [];
  for (const [texto, valor, unidad] of TAMANOS) {
    const t = tamanoDeUnidad(texto);
    const ok = valor === null ? t === null : t !== null && Math.abs(t.valor - valor) < 0.001 && t.unidad === unidad;
    if (!ok) mal.push(`${texto} → ${t ? `${t.valor} ${t.unidad}` : 'null'} (esperado ${valor ?? 'null'} ${unidad ?? ''})`);
  }
  check(mal.length === 0, `tamaño de la unidad: ${TAMANOS.length} formatos`, mal.join(' | '));
}

// ───────────────────────── 2) catálogo sintético ─────────────────────────

const DESCRIPCIONES: string[] = [
  // bebidas sin alcohol
  'AQUARIUS 500CC PERA', 'AQUARIUS 500CC MANZANA', 'AQUARIUS 500CC NARANJA', 'AQUARIUS 500CC POMELO',
  'AQUARIUS 1.5L PERA', 'AQUARIUS 1.5L MANZANA', 'AQUARIUS 1.5L NARANJA', 'AQUARIUS 1.5L POMELO',
  'COCA COLA  500CC', 'COCA COLA ZERO 500CC', 'COCA COLA VIDRIO 1.25L RET', 'COCA COLA  2L RET', 'COCA COLA 2.25L DESC',
  'COCA COLA ZERO 2.25L DESC', 'COCA COLA  LATA 354CC', 'COCA COLA ZERO LATA 354CC', 'COCA COLA VIDRIO 237CC',
  'COCA COLA  1.5L', 'COCA COLA ZERO 1.5L', 'SPRITE 1.25L VIDRIO RET', 'SPRITE 2L RET', 'SPRITE 500CC', 'SPRITE 1.5L',
  'SPRITE ZERO 1.5L', 'SPRITE LATA 354CC', 'FANTA 500CC', 'FANTA 2L RET', 'FANTA 1.5L', 'FANTA LATA 354CC',
  'AGUA BONAQUA 500CC', 'AGUA BONAQUA 1.5L', 'AGUA BONAQUA CON GAS 500CC', 'AGUA BONAQUA CON GAS 1.5L',
  'POWERADE MOUNTAIN BLAST 500CC', 'POWERADE F. TROP 500CC', 'POWERADE MANZANA 500CC', 'POWERADE NARANJA 500CC',
  'SCHWEPPES POMELO ZERO 1.5L', 'SCHWEPPES POMELO 1.5L', 'SCHWEPPES TONICA 1.5L', 'SCHWEPPES POMELO 500CC',
  'CEPITA DURAZNO 1L', 'CEPITA NARANJA 1L', 'CEPITA MANZANA 1L', 'CEPITA NARANJA 200CC',
  'LEVITE NARANJA 500ML', 'LEVITE POMELO 500ML', 'LEVITE MANZANA 1.5L', 'SPEED LATA 250CC', 'SPEED LATA 473CC',
  'SODA SIFON IVESS 2L', 'AGUA VILLAVICENCIO 2L', 'AGUA VILLAVICENCIO 500CC',
  // cervezas y bebidas con alcohol
  'IMPERIAL LAGER 1L', 'IMPERIAL GOLDEN 1L', 'IMPERIAL LAGER LATA 473CC', 'IMPERIAL GOLDEN LATA 473CC',
  'IMPERIAL APA LATA 473CC', 'HEINEKEN 1L', 'HEINEKEN LATA 473CC', 'HEINEKEN PORRON 330CC', 'MILLER 1L',
  'MILLER LATA 473CC', 'QUILMES STOUT 1 L', 'QUILMES CLASICA 1L', 'QUILMES LATA 473CC', 'GOYENECHE HONEY 500CC',
  'GOYENECHE IPA 500CC', 'GIN BOMBAY 750CC', 'GIN GORDONS 700CC', 'FERNET BRANCA 750CC', 'FERNET BRANCA 1L',
  'FERNET BRANCA 450CC', 'FERNET 1882 750CC', 'GANCIA 1L', 'GANCIA 450CC', 'TORO VINO TINTO T.BRIK',
  'TORO VINO BLANCO T.BRIK', 'VINO TERMIDOR TINTO T.BRIK 1L', 'RON HAVANA 750CC', 'VODKA SMIRNOFF 700CC',
  // almacén
  'ATUN S&P DESMENUZADO ACEITE 170G', 'ATUN S&P DESMENUZADO NATURAL 170G', 'ATUN S&P TROZOS ACEITE 170G',
  'ATUN LA CAMPAGNOLA DESMENUZADO ACEITE 170G', 'ATUN LA CAMPAGNOLA LOMITOS ACEITE 170G',
  'CABALLA PUGLISI NATURAL 380G', 'CABALLA PUGLISI ACEITE 380G',
  'FIDEOS FAVORITA SPAGHETTI 500G', 'FIDEOS FAVORITA TALLARIN 500G', 'FIDEOS FAVORITA MOSTACHOL 500G',
  'FIDEOS LUCCHETTI CODITOS 500G', 'FIDEOS LUCCHETTI TIRABUZON 500G', 'FIDEOS LUCCHETTI MOSTACHOL 500G',
  'FIDEOS MATARAZZO SPAGHETTI 500G', 'PREMEZCLA CHIPA LUCCHETTI 400G',
  'CHOCOLINAS 250G', 'CHOCOLINAS 170G', 'GALLETITAS KESITAS 75G', 'GALLETITAS KESITAS 125G', 'GALLETITAS REX 75G',
  'GALLETITAS REX 125G', 'SONRISAS 108G', 'SONRISAS LIMON 108G', 'GALLETITAS OREO 118G', 'GALLETITAS CRIOLLITAS 300G',
  'LEVADURA LEVEX X2', 'MANI S&P FRITO SALADO 250G', 'MANI S&P FRITO SALADO 500G',
  'PIMENTON ALICANTE 25G', 'PROVENZAL ALICANTE 25G', 'OREGANO ALICANTE 25G', 'PIMENTON ALICANTE 50G',
  'CHIMICHURRI LA CAMPAGNOLA 23G', 'PROVENZAL LA CAMPAGNOLA 23G', 'PIMENTON LA CAMPAGNOLA 23G',
  'RAPIDITAS BIMBO 275G', 'RAPIDITAS BIMBO LIGHT 275G', 'SAL FINA DOS ESTRELLAS 500G', 'SAL GRUESA DOS ESTRELLAS 1KG',
  'SAL FINA CELUSAL 500G', 'TE LA VIRGINIA 25 SAQ', 'TE LA VIRGINIA VERDE 20 SAQ', 'TE LA VIRGINIA 50 SAQ',
  'YERBA LA MERCED DE CAMPO 500G', 'YERBA LA MERCED BARBACUA 1KG', 'YERBA ROSAMONTE SUAVE 500G', 'YERBA ROSAMONTE 500G',
  'YERBA ROSAMONTE SUAVE 1KG', 'YERBA PLAYADITO 500G', 'YERBA PLAYADITO 1KG',
  'ARROZ MOLINOS ALA LARGO FINO 1KG', 'ARROZ MOLINOS ALA LARGO FINO 500G', 'ARROZ MOLINOS ALA DOBLE CAROLINA 1KG',
  'ARROZ GALLO ORO 1KG', 'ARROZ GALLO ORO 500G', 'ARROZ GALLO INTEGRAL 1KG',
  'CALDO KNORR GALLINA X6', 'CALDO KNORR GALLINA X12', 'CALDO KNORR VERDURA X12', 'CALDO KNORR CARNE X6',
  'CALDO ALICANTE GALLINA X12', 'SOPA KNORR VERDURA 60G',
  'MAYONESA NATURA 250G DOYPACK', 'MAYONESA NATURA 1KG', 'MAYONESA NATURA SACHET 125G', 'MAYONESA NATURA 500G DOYPACK',
  'MAYONESA HELLMANNS 250G DOYPACK', 'MAYONESA HELLMANNS LIGHT 250G', 'MAYONESA HELLMANNS 1KG',
  'MAYONESA MAYOLIVA SACHET 125G', 'MAYONESA MAYOLIVA 250G DOYPACK', 'KETCHUP NATURA 250G', 'MOSTAZA NATURA 250G',
  'MOSTAZA DANICA 60G', 'KETCHUP DANICA 60G',
  // limpieza y varios
  'DET CIF LIMA 450ML', 'DET CIF LIMON 450ML', 'DETERGENTE MAGISTRAL LIMON 500ML', 'DETERGENTE MAGISTRAL LIMON 750ML',
  'LAVANDINA AYUDIN 1L', 'LAVANDINA AYUDIN 2L', 'LAVANDINA AYUDIN 4L', 'JABON LIQUIDO ALA 3L', 'JABON LIQUIDO ALA 800ML',
  'JABON LIQUIDO GRANBY 800ML', 'JABON EN POLVO ALA 800G', 'SHAMPOO PLUSBELLE 970ML',
  'ANTITRANSPIRANTE DOVE ORIGINAL AEROSOL 150ML', 'OFF FAMILY AEROSOL 165CC', 'OFF FAMILY CREMA 200G',
  'ESPIRALES RAID X12', 'ESPONJA MORTIMER CUADRICULADA', 'ESPONJA MORTIMER ACERO', 'REJILLA MEDIA NARANJA',
  'TRAPO DE PISO MEDIA NARANJA', 'CEPILLO COLGATE TWISTER MEDIO', 'CEPILLO COLGATE EXTRA CLEAN',
  'BOLSA RESIDUOS VIRUTEX 45X60 10U', 'BOLSA RESIDUOS VIRUTEX 60X90 10U',
  // sondeos contra el catálogo real (3-oct-2026), reescritos acá
  'HEINEKEN LATA 473 CC SIN ALCOHOL', 'STELLA ARTOIS 330CC', 'STELLA ARTOIS 0.0 330CC', 'CORONA 710CC', 'CORONA 330CC',
  'VILLAVICENCIO AGUA 1.5L', 'VILLAVICENCIO AGUA C GAS 500ML', 'SPEED CAFE LATA 250CC',
  'ATUN LA CAMPAGNOLA AL AGUA 170G', 'LA VIRGINIA CAFE TORRADO 250G', 'SIDRA 1888 ORIG LATA 473CC',
];

const articulos: ArticuloParaAsociar[] = DESCRIPCIONES.map((descripcion, i) => ({
  id: `art-${String(i + 1).padStart(3, '0')}`,
  descripcion,
}));
// Un artículo dado de baja idéntico a uno activo: si se tuviera en cuenta, empataría y dejaría en blanco.
articulos.push({ id: 'art-baja', descripcion: 'HEINEKEN 1L', activo: false });

const idDe = new Map(articulos.filter((a) => a.activo !== false).map((a) => [a.descripcion, a.id]));
const descDe = new Map(articulos.map((a) => [a.id, a.descripcion]));
check(idDe.size === DESCRIPCIONES.length, `catálogo sintético: ${DESCRIPCIONES.length} artículos sin repetidos`);

const catalogo = prepararCatalogo(articulos);

// ───────────────────────── 3) casos ─────────────────────────

/** [renglón de la factura, artículo correcto o null si no existe / es ambiguo] */
type Caso = [string, string | null];

const PROTOTIPO: Caso[] = [
  ['AGUA BONAQUA 12X500', 'AGUA BONAQUA 500CC'], ['AGUA BONAQUA 6X11/5', 'AGUA BONAQUA 1.5L'],
  ['COCA-COLA 12X500 PET', 'COCA COLA  500CC'], ['FANTA-NARANJA 12X500 PET', 'FANTA 500CC'],
  ['COCA-COLA S/AZUC 12X500', 'COCA COLA ZERO 500CC'], ['AQUARIUS PERA 6X 1/2', 'AQUARIUS 500CC PERA'],
  ['AQUARIUS MANZANA 6X 1/2', 'AQUARIUS 500CC MANZANA'], ['AQUARIUS NARANJA 6X 1/2', 'AQUARIUS 500CC NARANJA'],
  ['COCA-COLA VIDRIO 8X1 1/4', 'COCA COLA VIDRIO 1.25L RET'], ['SPRITE VIDRIO 8X11/4', 'SPRITE 1.25L VIDRIO RET'],
  ['FANTA NARANJA VIDRIO 8X11/4', null], ['CERVEZA TEMPLE WOLF IPA 6XX473', null], ['CERVEZA TEMPLE HONEY 6X473', null],
  ['CERVEZA TEMPLE SCOTTISH 6X473', null], ['COCA-COLA RETOR. 8X2 LTS', 'COCA COLA  2L RET'],
  ['SPRITE RETOR. BX2 LTS', 'SPRITE 2L RET'], ['SPEED CON CAFE 24X24', null],
  ['POWERADE MOUNTAIN BLAST 6X500', 'POWERADE MOUNTAIN BLAST 500CC'], ['POWERADE F.TROP. 6X500', 'POWERADE F. TROP 500CC'],
  ['CERVEZA IMPERIAL X 1L X 12', null], ['CERVEZA HEINEKEN X 1L X 12', 'HEINEKEN 1L'],
  ['CERVEZA BARRIL X 30L IMPERIAL', null], ['CERVEZA IMPERIAL STOUT X 500 X 12', null],
  ['CERVEZA LATA IMP IPA X 473 X 6', null], ['GIN BOMBAY X 750 cc. (12X750)', 'GIN BOMBAY 750CC'],
  ['RON BACARDI BCO. 12 X 1 LI.', null], ['GIN BEEFEATER x 1 Lt (6x1000cc', null],
  ['FERNET BRANCA 12X750', 'FERNET BRANCA 750CC'], ['GANCIA 12X1', 'GANCIA 1L'],
  ['SCHWEPPES POMELO ZERO 6X1500', 'SCHWEPPES POMELO ZERO 1.5L'], ['SPRITE 6X1500', 'SPRITE 1.5L'],
  ['COCA-COLA 6X1500 PET', 'COCA COLA  1.5L'], ['COCA-COLA 6X21/4', 'COCA COLA 2.25L DESC'],
  ['CERVEZA MILLER 12X1LT', 'MILLER 1L'], ['TORO TINTO T.BRIK 12X1', 'TORO VINO TINTO T.BRIK'],
  ['SODA SIFON ESTAMBUL 6X1,75', null], ['AQUARIUS NARANJA 6X1500', 'AQUARIUS 1.5L NARANJA'],
  ['AQUARIUS POMELO 6X1500', 'AQUARIUS 1.5L POMELO'], ['CEPITA HF DURAZNO 6X1LT', 'CEPITA DURAZNO 1L'],
  ['CEPITA HF NARANJA 6X1LT', 'CEPITA NARANJA 1L'],
];

/** Respuesta correcta de cada renglón de almacén contra el catálogo sintético (armada a mano). */
const VERDAD_ALMACEN: Record<string, string | null> = {
  // vital-12
  'Atun S&P desmenuzado en aceite x170gr': 'ATUN S&P DESMENUZADO ACEITE 170G',
  'Atun S&P trozos aceite abre facil x170g': 'ATUN S&P TROZOS ACEITE 170G',
  'Caballa PUGLISI al agua x380g': 'CABALLA PUGLISI NATURAL 380G',
  'Fideos CICA tirabuzon forti x500g': null,
  'Fideos FAVORITA spaghetti x500gr': 'FIDEOS FAVORITA SPAGHETTI 500G',
  'Galletitas CHOCOLINAS x250/262grs': 'CHOCOLINAS 250G',
  'Galletitas KESITAS x75gr': 'GALLETITAS KESITAS 75G',
  'Galletitas REX bolsa x75gr': 'GALLETITAS REX 75G',
  'Galletitas SONRISAS frambuesa x108g': 'SONRISAS 108G',
  'Levadura LEVEX sobre 2x10g': 'LEVADURA LEVEX X2',
  'Magdalena BON MASE c/chips x175g': null,
  'Mani frito S&P salado s/piel x250gr': 'MANI S&P FRITO SALADO 250G',
  'Maq afeitar desc SOLEIL x2u': null,
  'Pimenton ALICANTE x25gr': 'PIMENTON ALICANTE 25G',
  'Provenzal ALICANTE x25gr': 'PROVENZAL ALICANTE 25G',
  'Rapiditas BIMBO clasicas x275gr': 'RAPIDITAS BIMBO 275G',
  'Sal fina DOS ESTRELLAS x500gr': 'SAL FINA DOS ESTRELLAS 500G',
  'Te LA VIRGINIA tilo/manza./cedron x25sq': null,
  'Te LA VIRGINIA verde x20sq': 'TE LA VIRGINIA VERDE 20 SAQ',
  'Yerba LA MERCED campo sur liviana x1kg': null,
  'Yerba ROSAMONTE PLUS SUAVE 55 ani.x500gr': 'YERBA ROSAMONTE SUAVE 500G',
  'ALICANTE ESPECIAS D3U15%': null,
  // vital-14
  'Acond PLUSBELLE ESEN hidrat int x970ml': null,
  'Antitr DOVE duraz/lech roll-on x50ml': null,
  'Antitr DOVE original tam.ec x250ml': null,
  'Arroz largo fino MOLINOS ALA g.sel. x1kg': 'ARROZ MOLINOS ALA LARGO FINO 1KG',
  'Bolsa resid VIRUTEX 45x60 plana 10u': 'BOLSA RESIDUOS VIRUTEX 45X60 10U',
  'Caldo KNORR gallina deshidratado x12u': 'CALDO KNORR GALLINA X12',
  'Caldo KNORR gallina deshidratado x6u': 'CALDO KNORR GALLINA X6',
  'Caldo KNORR verdura deshidratado x12u': 'CALDO KNORR VERDURA X12',
  'Caldo KNORR verdura deshidratado x6u': null,
  'Capelettini GIACOMO tridicci x500gr': null,
  'Cepillo dental COLGATE twister med. 3x2': 'CEPILLO COLGATE TWISTER MEDIO',
  'Chimichurri LA CAMPAGNOLA x23gr': 'CHIMICHURRI LA CAMPAGNOLA 23G',
  'Crema dent SENSODYNE antisarro x90g': null,
  'Detergente CIF Bioactive lima d/p x450ml': 'DET CIF LIMA 450ML',
  'Espirales RAID x12u': 'ESPIRALES RAID X12',
  'Esponja MORTIMER de bronce doble cara': null,
  'Esponja MORTIMER de fibra cuadriculada': 'ESPONJA MORTIMER CUADRICULADA',
  'Fideos LUCCHETTI coditos x500gr': 'FIDEOS LUCCHETTI CODITOS 500G',
  'Fideos LUCCHETTI nido fettuccine x500gr': null,
  'Jabon liq ALA matic ecolavado d/p x3lt': 'JABON LIQUIDO ALA 3L',
  'Jabon liq GRANBY matic limon d/p x3lt': null,
  'Jabon liq GRANBY matic rosas d/p x3lt': null,
  'Lampara led PHILIPS ecohome fria 10/12w': null,
  'Mayonesa CADA DIA doy pack x250gr': null,
  'Mayonesa CADA DIA sachet x125g': null,
  'Mayonesa MAYOLIVA sachet x125gr': 'MAYONESA MAYOLIVA SACHET 125G',
  'Mayonesa NATURA d/p x1kg': 'MAYONESA NATURA 1KG',
  'Mayonesa NATURA doy pack x250gr': 'MAYONESA NATURA 250G DOYPACK',
  'Mostaza DANICA seleccion granos x60g': 'MOSTAZA DANICA 60G',
  'Premezcla LUCCHETTI chipa x400grs': 'PREMEZCLA CHIPA LUCCHETTI 400G',
  'Provenzal LA CAMPAGNOLA x23g': 'PROVENZAL LA CAMPAGNOLA 23G',
  'Rejilla MEDIA NARANJA reforzada': 'REJILLA MEDIA NARANJA',
  'Repelente OFF family aerosol x165ml': 'OFF FAMILY AEROSOL 165CC',
};

/** Trampas agregadas a mano (variedades hermanas, envase, tamaños, abreviaturas). */
const TRAMPAS: Caso[] = [
  ['COCA-COLA LATA 6X354', 'COCA COLA  LATA 354CC'],
  ['COCA-COLA VIDRIO 24X237', 'COCA COLA VIDRIO 237CC'],
  ['COCA-COLA VIDRIO 6X354', null], // de 354 sólo hay lata
  ['COCA-COLA LIGHT 6X1500', null], // LIGHT no es ZERO
  ['COCA-COLA DESC. 6X2', null], // de 2 L sólo hay retornable
  ['SPRITE SIN AZUCAR 6X1500', 'SPRITE ZERO 1.5L'],
  ['CERVEZA IMPERIAL LAGER X 1L X 12', 'IMPERIAL LAGER 1L'],
  ['CERVEZA LATA IMP LAGER X 473 X 6', 'IMPERIAL LAGER LATA 473CC'],
  ['CERVEZA LATA IMPERIAL X 473 X 24', null], // lager, golden o apa: no se sabe
  ['CERVEZA QUILMES STOUT X 1L X 12', 'QUILMES STOUT 1 L'],
  ['FERNET BRANCA 6X1', 'FERNET BRANCA 1L'],
  ['GANCIA 12X450', 'GANCIA 450CC'],
  ['SCHWEPPES POMELO 6X1500', 'SCHWEPPES POMELO 1.5L'],
  ['POWERADE FRUTAS TROPICALES 6X500', 'POWERADE F. TROP 500CC'],
  ['Arroz GALLO ORO x1kg', 'ARROZ GALLO ORO 1KG'],
  ['Arroz GALLO ORO x500gr', 'ARROZ GALLO ORO 500G'],
  ['Arroz GALLO x1kg', null], // oro o integral
  ['Caldo KNORR carne x12u', null], // de carne sólo hay x6
  ['Mayonesa HELLMANNS doy pack x250gr', 'MAYONESA HELLMANNS 250G DOYPACK'],
  ['Mayonesa NATURA sachet x250gr', null], // de 250 sólo hay doy pack
  ['Ketchup NATURA x250gr', 'KETCHUP NATURA 250G'],
  ['Atun LA CAMPAGNOLA desmenuzado aceite x170g', 'ATUN LA CAMPAGNOLA DESMENUZADO ACEITE 170G'],
  ['Atun S&P desmenuzado al natural x170g', 'ATUN S&P DESMENUZADO NATURAL 170G'],
  ['Lavandina AYUDIN original x4lt', 'LAVANDINA AYUDIN 4L'],
  ['Yerba PLAYADITO x1kg', 'YERBA PLAYADITO 1KG'],
  ['Detergente MAGISTRAL limon x750ml', 'DETERGENTE MAGISTRAL LIMON 750ML'],
];

/**
 * Sondeos contra el catálogo real (RESULTADOS.md, 3-oct-2026): el único vínculo equivocado encontrado (cerveza 0.0 →
 * la con alcohol) y los falsos negativos más frecuentes. null = debe quedar en blanco aunque haya un candidato cercano.
 */
const SONDEOS: Caso[] = [
  // 1) "0.0" / "0,0" / "SIN ALCOHOL" es variedad: si está en un lado y no en el otro, no es el mismo producto
  ['CERVEZA HEINEKEN 0.0 X 473 X 6', 'HEINEKEN LATA 473 CC SIN ALCOHOL'],
  ['HEINEKEN 0,0 LATA X 473 X 6', 'HEINEKEN LATA 473 CC SIN ALCOHOL'],
  ['HEINEKEN 0.0% X 473 X 6', 'HEINEKEN LATA 473 CC SIN ALCOHOL'],
  ['HEINEKEN SIN ALCOHOL X 473 X 6', 'HEINEKEN LATA 473 CC SIN ALCOHOL'],
  ['CERVEZA HEINEKEN S/ALCOHOL 6X473', 'HEINEKEN LATA 473 CC SIN ALCOHOL'],
  ['HEINEKEN X 473 X 6', 'HEINEKEN LATA 473CC'], // y no a la 0.0
  ['CERVEZA LATA HEINEKEN 6X473', 'HEINEKEN LATA 473CC'],
  ['STELLA ARTOIS 0.0 X 330 X 24', 'STELLA ARTOIS 0.0 330CC'],
  ['STELLA ARTOIS X 330 X 24', 'STELLA ARTOIS 330CC'],
  ['HEINEKEN 0.0 X 330 X 24', null], // de 330 sólo hay porrón con alcohol
  // 2) "tamaño X bulto" sin unidad: el 24 es el bulto, no 24 unidades
  ['STELLA ARTOIS 330 X 24', 'STELLA ARTOIS 330CC'],
  ['CORONA 710 X 12', 'CORONA 710CC'],
  ['CORONA 330 X 24', 'CORONA 330CC'],
  ['OREO 118 X 36', 'GALLETITAS OREO 118G'],
  ['KESITAS 125 X 24', 'GALLETITAS KESITAS 125G'],
  ['SMIRNOFF 700 X 12', 'VODKA SMIRNOFF 700CC'],
  ['SPEED 250 X 24', 'SPEED LATA 250CC'], // la de café tiene una palabra de más
  ['SPEED CON CAFE 250 X 24', 'SPEED CAFE LATA 250CC'],
  // 3) rubro en el medio del nombre: no es palabra sobrante
  ['VILLAVICENCIO 1.5L X 6', 'VILLAVICENCIO AGUA 1.5L'],
  ['AGUA VILLAVICENCIO 6X1500', 'VILLAVICENCIO AGUA 1.5L'],
  ['VILLAVICENCIO X 1500 X 6', 'VILLAVICENCIO AGUA 1.5L'],
  ['Cafe LA VIRGINIA torrado x250gr', 'LA VIRGINIA CAFE TORRADO 250G'], // el rubro de adelante cubre al del medio
  ['Cafe LA VIRGINIA x250gr', null], // le falta TORRADO
  ['Atun LA CAMPAGNOLA al agua x170g', 'ATUN LA CAMPAGNOLA AL AGUA 170G'],
  ['Atun LA CAMPAGNOLA x170g', null], // "AL AGUA" es variedad, no categoría: desmenuzado, lomitos o al agua
  // 4) SIN GAS / CON GAS como rasgo con negación
  ['VILLAVICENCIO SIN GAS 500', null], // ni la C GAS ni (por las dudas) la que no dice nada
  ['VILLAVICENCIO S/GAS 12X500', null],
  ['AGUA BONAQUA SIN GAS 12X500', null],
  ['VILLAVICENCIO CON GAS 12X500', 'VILLAVICENCIO AGUA C GAS 500ML'],
  ['VILLAVICENCIO GAS 12X500', 'VILLAVICENCIO AGUA C GAS 500ML'],
  ['AGUA VILLAVICENCIO C/GAS X 500 X 12', 'VILLAVICENCIO AGUA C GAS 500ML'],
  ['AGUA BONAQUA C/GAS 6X1500', 'AGUA BONAQUA CON GAS 1.5L'],
  ['AGUA BONAQUA GASIFICADA 6X1500', 'AGUA BONAQUA CON GAS 1.5L'],
  ['AGUA VILLAVICENCIO 12X500', 'AGUA VILLAVICENCIO 500CC'], // sin decir nada de gas: la que no dice nada
  // 5) ORIG ↔ ORIGINAL (de los dos lados)
  ['Antitr DOVE orig aerosol x150ml', 'ANTITRANSPIRANTE DOVE ORIGINAL AEROSOL 150ML'],
  ['SIDRA 1888 ORIGINAL LATA X 473 X 6', 'SIDRA 1888 ORIG LATA 473CC'],
];

const esperado = JSON.parse(
  readFileSync(join(here, 'fixtures', 'facturas', 'esperado.json'), 'utf8'),
) as Record<string, Array<{ descripcion: string; precioUnitario: number | null; unidadesPorBulto: number | null }>>;

interface Renglon {
  origen: string;
  descripcion: string;
  precioUnitario: number | null;
  unidadesPorBulto: number | null;
  real: string | null;
}
const renglones: Renglon[] = [];
for (const [descripcion, real] of PROTOTIPO) {
  renglones.push({ origen: 'bebidas', descripcion, precioUnitario: null, unidadesPorBulto: null, real });
}
const vistos = new Set<string>();
for (const hoja of ['vital-12', 'vital-14']) {
  for (const r of esperado[hoja] ?? []) {
    if (vistos.has(r.descripcion)) continue; // los descuentos vienen repetidos
    vistos.add(r.descripcion);
    if (!(r.descripcion in VERDAD_ALMACEN)) {
      check(false, `renglón de ${hoja} sin respuesta cargada`, r.descripcion);
      continue;
    }
    renglones.push({ origen: hoja, ...r, real: VERDAD_ALMACEN[r.descripcion] ?? null });
  }
}
for (const [descripcion, real] of TRAMPAS) {
  renglones.push({ origen: 'trampas', descripcion, precioUnitario: null, unidadesPorBulto: null, real });
}
for (const [descripcion, real] of SONDEOS) {
  renglones.push({ origen: 'sondeos', descripcion, precioUnitario: null, unidadesPorBulto: null, real });
}
for (const r of renglones) {
  if (r.real !== null && !idDe.has(r.real)) check(false, 'la respuesta esperada no está en el catálogo', r.real);
}

let bien = 0;
let mal = 0;
let blancoCorrecto = 0;
let blancoSugerido = 0;
let blancoPrimero = 0;
let blancoPerdido = 0;
const corto = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);

console.log('\n── Tabla de resultados ──');
for (const r of renglones) {
  const p = proponerArticulo(r, catalogo);
  const propuesto = p.articuloId ? (descDe.get(p.articuloId) ?? p.articuloId) : null;
  const sugeridos = p.candidatos.map((c) => descDe.get(c.articuloId) ?? c.articuloId);
  let marca: string;
  if (propuesto !== null && propuesto === r.real) {
    bien++;
    marca = '✓ vinculó bien';
  } else if (propuesto !== null) {
    mal++;
    marca = `✗ VINCULÓ MAL (real: ${r.real ?? 'no existe'})`;
  } else if (r.real === null) {
    blancoCorrecto++;
    marca = '· en blanco, correcto';
  } else {
    const lugar = sugeridos.indexOf(r.real);
    if (lugar >= 0) {
      blancoSugerido++;
      if (lugar === 0) blancoPrimero++;
    } else blancoPerdido++;
    marca = `· en blanco, existía: ${lugar >= 0 ? `sugerencia ${lugar + 1}` : 'NO SUGERIDO'} [${r.real}] — ${p.motivo ?? ''}`;
  }
  console.log(`${corto(r.origen, 8)} ${corto(r.descripcion, 42)} → ${corto(propuesto ?? '—', 34)} ${marca}`);
}

const existen = bien + blancoSugerido + blancoPerdido;
const blancoExistiendo = blancoSugerido + blancoPerdido;
console.log(
  `\n${renglones.length} renglones: vinculó bien ${bien} · VINCULÓ MAL ${mal} · en blanco correcto ${blancoCorrecto} · ` +
    `en blanco existiendo ${blancoExistiendo} (${blancoSugerido} entre los 3 candidatos, ${blancoPrimero} como primero, ${blancoPerdido} sin sugerir)\n`,
);

check(mal === 0, 'VINCULÓ MAL = 0', `${mal}`);
check(bien / existen >= 0.5, 'vinculó bien ≥ 50 % de los que existen', `${bien}/${existen} = ${Math.round((100 * bien) / existen)} %`);
check(
  blancoExistiendo === 0 || blancoSugerido / blancoExistiendo >= 0.85,
  'en blanco existiendo: el correcto está entre los 3 candidatos en ≥ 85 %',
  `${blancoSugerido}/${blancoExistiendo}`,
);
check(
  proponerArticulo({ descripcion: 'ALICANTE ESPECIAS D3U15%', precioUnitario: -112.69 }, catalogo).candidatos.length === 0,
  'renglón de descuento (precio negativo): ni vínculo ni candidatos',
);

// ───────────────────────── 4) pistas secundarias e inactivos ─────────────────────────
{
  const dobles = prepararCatalogo([
    { id: 'a', descripcion: 'COCA COLA 500CC', proveedorId: 'prov-1', costo: 900 },
    { id: 'b', descripcion: 'COCA COLA 500 CC', proveedorId: 'prov-2', costo: 2000 },
    { id: 'c', descripcion: 'COCA COLA ZERO 500CC', proveedorId: 'prov-9', costo: 1000 },
    { id: 'd', descripcion: 'SPRITE 500CC', marca: 'SPRITE' },
    { id: 'e', descripcion: 'GASEOSA LIMA LIMON 500CC', marca: 'Sprite' },
    { id: 'f', descripcion: 'FANTA 500CC', activo: false },
  ]);
  const r = { descripcion: 'COCA-COLA 12X500 PET', precioUnitario: 1000 };
  check(proponerArticulo({ descripcion: r.descripcion }, dobles).articuloId === null, 'dos artículos iguales sin pistas → en blanco');
  check(proponerArticulo({ descripcion: r.descripcion }, dobles, { proveedorId: 'prov-2' }).articuloId === 'b', 'el proveedor desempata entre dos iguales');
  check(proponerArticulo(r, dobles).articuloId === 'a', 'el costo (±15 %) desempata entre dos iguales');
  const zero = proponerArticulo({ descripcion: 'COCA-COLA 12X500', precioUnitario: 1000 }, prepararCatalogo([
    { id: 'c', descripcion: 'COCA COLA ZERO 500CC', proveedorId: 'prov-9', costo: 1000 },
  ]), { proveedorId: 'prov-9' });
  check(zero.articuloId === null && zero.candidatos[0]?.articuloId === 'c', 'proveedor y costo no habilitan solos (otra variedad → sugerencia)');
  check(proponerArticulo({ descripcion: 'SPRITE LIMA LIMON 12X500' }, dobles).articuloId === 'e', 'la marca cargada aparte cubre palabras del renglón');
  const baja = proponerArticulo({ descripcion: 'FANTA 12X500' }, dobles);
  check(baja.articuloId === null && baja.candidatos.length === 0, 'artículo dado de baja: no se propone ni se sugiere');
  const conImportada = prepararCatalogo([
    { id: 'i1', descripcion: 'IMPERIAL LAGER LATA 473CC' },
    { id: 'i2', descripcion: 'CERVEZA IMPORTADA LAGER LATA 473CC' },
  ]);
  check(
    proponerArticulo({ descripcion: 'CERVEZA LATA IMP LAGER X 473 X 6' }, conImportada).articuloId === null,
    'IMP no se expande a IMPERIAL si en el catálogo hay otra palabra que empieza igual',
  );

  // Sondeos (3-oct-2026): los "viceversa" necesitan catálogos donde SÓLO exista la variante cercana.
  const soloSinAlcohol = prepararCatalogo([{ id: 'h0', descripcion: 'HEINEKEN LATA 473 CC SIN ALCOHOL' }]);
  check(proponerArticulo({ descripcion: 'HEINEKEN X 473 X 6' }, soloSinAlcohol).articuloId === null, 'HEINEKEN común no se vincula a la 0.0 aunque sea la única');
  const soloConGas = prepararCatalogo([{ id: 'cg', descripcion: 'VILLAVICENCIO AGUA C GAS 500ML' }]);
  check(proponerArticulo({ descripcion: 'VILLAVICENCIO SIN GAS 500' }, soloConGas).articuloId === null, 'SIN GAS no se vincula a la C GAS aunque sea la única');
  check(proponerArticulo({ descripcion: 'VILLAVICENCIO 12X500' }, soloConGas).articuloId === null, 'sin decir nada de gas no se vincula a la C GAS');
  const soloSinGas = prepararCatalogo([{ id: 'sg', descripcion: 'AGUA VILLAVICENCIO SIN GAS 500CC' }]);
  check(proponerArticulo({ descripcion: 'VILLAVICENCIO CON GAS 12X500' }, soloSinGas).articuloId === null, 'CON GAS no se vincula a la SIN GAS');
  check(proponerArticulo({ descripcion: 'VILLAVICENCIO S/GAS 12X500' }, soloSinGas).articuloId === 'sg', 'S/GAS = SIN GAS');
  const gasOrden = proponerArticulo({ descripcion: 'AGUA BONAQUA SIN GAS 12X500' }, catalogo).candidatos.map((c) => descDe.get(c.articuloId));
  check(gasOrden[0] === 'AGUA BONAQUA 500CC', 'SIN GAS: la que no dice nada va antes que la CON GAS entre los candidatos', gasOrden.join(' | '));
  const soloCafe = prepararCatalogo([{ id: 'sc', descripcion: 'SPEED CAFE LATA 250CC' }]);
  check(proponerArticulo({ descripcion: 'SPEED 24X250' }, soloCafe).articuloId === null, 'CAFE en el medio es variedad, no rubro: SPEED no se vincula a SPEED CAFE');
  const atunes = prepararCatalogo([
    { id: 'agua', descripcion: 'ATUN LA CAMPAGNOLA AL AGUA 170G' },
    { id: 'aceite', descripcion: 'ATUN LA CAMPAGNOLA ACEITE 170G' },
  ]);
  check(proponerArticulo({ descripcion: 'Atun LA CAMPAGNOLA x170g' }, atunes).articuloId === null, '"AL AGUA" detrás del rubro es variedad: atún sin aclarar queda en blanco');
  check(proponerArticulo({ descripcion: 'LA CAMPAGNOLA X 170 X 24' }, prepararCatalogo([{ id: 'agua', descripcion: 'ATUN LA CAMPAGNOLA AL AGUA 170G' }])).articuloId === null, 'ídem aunque sea el único');
  const marcaAdelante = prepararCatalogo([
    { id: 'mayo', descripcion: 'NATURA MAYONESA 250G DOYPACK' },
    { id: 'ket', descripcion: 'NATURA KETCHUP 250G' },
  ]);
  check(proponerArticulo({ descripcion: 'Mayonesa NATURA doy pack x250gr' }, marcaAdelante).articuloId === 'mayo', 'el rubro de adelante del renglón cubre al mismo rubro en el medio del artículo');
  check(proponerArticulo({ descripcion: 'Ketchup NATURA x250gr' }, marcaAdelante).articuloId === 'ket', 'ídem ketchup (la mayonesa tiene una palabra de más)');
  check(proponerArticulo({ descripcion: 'NATURA x250gr' }, marcaAdelante).articuloId === null, 'sin rubro en el renglón, MAYONESA/KETCHUP en el medio siguen siendo variedad');
  const gaseosaEnMedio = prepararCatalogo([{ id: 'g', descripcion: 'VILLAVICENCIO GASEOSA 1.5L' }]);
  check(proponerArticulo({ descripcion: 'AGUA VILLAVICENCIO 6X1500' }, gaseosaEnMedio).articuloId === null, 'rubro en el medio también se compara: AGUA ≠ GASEOSA');
}

// ───────────────────────── 5) rendimiento ─────────────────────────
{
  const marcas = Array.from({ length: 200 }, (_, i) => `MARCA${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + (Math.floor(i / 26) % 26))}${i}`);
  const rubros = ['FIDEOS', 'GALLETITAS', 'YERBA', 'MAYONESA', 'ARROZ', 'CERVEZA', 'GASEOSA', 'DETERGENTE', 'JABON', 'ATUN'];
  const variedades = ['NARANJA', 'LIMON', 'MANZANA', 'CLASICO', 'ZERO', 'LIGHT', 'SUAVE', 'INTENSO', 'DURAZNO', 'POMELO'];
  const medidas = ['500CC', '1L', '1.5L', '2.25L', '250G', '500G', '1KG', 'LATA 354CC', 'LATA 473CC', 'X12'];
  const grande: ArticuloParaAsociar[] = [];
  for (let i = 0; i < 20000; i++) {
    const m = marcas[i % marcas.length]!;
    const v = variedades[Math.floor(i / marcas.length) % variedades.length]!;
    const t = medidas[Math.floor(i / (marcas.length * variedades.length)) % medidas.length]!;
    grande.push({ id: `g${i}`, descripcion: `${rubros[i % rubros.length]} ${m} ${v} ${t}`, proveedorId: `p${i % 40}`, costo: 500 + (i % 900) });
  }
  const filas = Array.from({ length: 100 }, (_, i) => {
    const m = marcas[(i * 7) % marcas.length]!;
    const v = variedades[(i * 3) % variedades.length]!;
    return { descripcion: `${rubros[((i * 7) % marcas.length) % rubros.length]} ${m} ${v} ${i % 2 ? '12X500' : 'x1kg'}`, precioUnitario: 700 };
  });
  const t0 = performance.now();
  const cat = prepararCatalogo(grande);
  const t1 = performance.now();
  let vinculados = 0;
  for (const f of filas) if (proponerArticulo(f, cat, { proveedorId: 'p3' }).articuloId) vinculados++;
  const t2 = performance.now();
  check(
    t2 - t0 < 1000,
    'rendimiento: 20.000 artículos + 100 renglones en < 1 s',
    `índice ${Math.round(t1 - t0)} ms · 100 renglones ${Math.round(t2 - t1)} ms · ${vinculados} vinculados`,
  );
  check(vinculados > 50, 'rendimiento: el catálogo grande también vincula', `${vinculados}/100`);
}

console.log(fallas === 0 ? '\n✅ Asociador de facturas: todo bien' : `\n❌ Asociador de facturas: ${fallas} falla(s)`);
process.exit(fallas === 0 ? 0 : 1);
