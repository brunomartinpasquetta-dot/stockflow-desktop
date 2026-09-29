/**
 * Íconos CHICOS de Windows (16, 20, 24, 32, 40, 48, 64 px), dibujados para su
 * tamaño en vez de achicar el de 1024.
 *
 * El ícono grande es una placa clara con el cubo de trazos finos en el medio.
 * Achicado a 32 px el cubo ocupa la mitad del cuadrado y sus trazos quedan de
 * un píxel (se ve granulado); a 16 px se desarma en puntos sueltos. Es lo que
 * Windows muestra en la barra de tareas, el escritorio y la esquina de la
 * ventana, así que ahí StockFlow se veía "pixelado" al lado de cualquier otro
 * programa. En Mac no pasa: la pantalla tiene el doble de píxeles y el Dock
 * usa los tamaños grandes.
 *
 * Para los chicos: placa AZUL a sangre (el cuadrado entero) con el cubo en
 * BLANCO ocupando casi todo, y el trazo engrosado para que nunca baje de
 * ~1,6 px al tamaño final. Se trabaja a 16× y se reduce con Lanczos.
 *
 *   node scripts/compose-icon-small.mjs      → build/icon-small/<n>.png
 *   (después node scripts/generate-icons.mjs arma el .ico con ellos)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, '..', 'build');
const outDir = join(buildDir, 'icon-small');
mkdirSync(outDir, { recursive: true });

export const TAMANIOS_CHICOS = [16, 20, 24, 32, 40, 48, 64];
const ESCALA = 16;
/** Grosor mínimo del trazo al tamaño final, en píxeles. */
const TRAZO_MIN = 1.6;

// Máscara del cubo: la SILUETA (alfa) del recorte, no el color. El centro de
// cada trazo del logo es de un azul más claro; filtrar por "azul fuerte" —como
// hace compose-icon.mjs para el grande— lo descarta y a este tamaño el trazo
// sale hueco, dos líneas finitas en vez de una llena.
async function mascaraCubo(lado) {
  const { data, info } = await sharp(join(buildDir, 'logo-cubo.png'))
    .trim()
    .resize(lado, lado, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = Buffer.alloc(info.width * info.height);
  for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
    const a = data[i + 3];
    // Se descarta el halo muy tenue del recorte y se lleva el resto a pleno.
    m[p] = Math.max(0, Math.min(255, Math.round((a - 40) * 1.6)));
  }
  return { m, w: info.width, h: info.height };
}

/**
 * 16 px: el cubo con sus curvas no entra en 12 píxeles útiles. Se dibuja el
 * mismo cubo reducido a su forma —hexágono y las tres aristas— con trazo
 * de 2 px, que es lo que se reconoce a ese tamaño.
 */
function cuboSimple(L) {
  const c = L / 2, r = L * 0.41, t = L * 0.09;
  const pt = (ang) => [c + r * Math.cos(ang), c + r * Math.sin(ang)];
  const hex = [0, 1, 2, 3, 4, 5].map((k) => pt(-Math.PI / 2 + (k * Math.PI) / 3));
  const d = hex.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z';
  const [, b, , d2, , f] = [hex[0], hex[1], hex[2], hex[3], hex[4], hex[5]];
  const aristas = [b, d2, f].map(([x, y]) => `M${c},${c} L${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<path d="${d}" fill="none" stroke="#fff" stroke-width="${t}" stroke-linejoin="round"/>
  <path d="${aristas}" fill="none" stroke="#fff" stroke-width="${t}" stroke-linecap="round"/>`;
}

/** Engrosa la máscara `r` píxeles: desenfoque + umbral bajo (dilatación suave). */
async function engrosar(m, w, h, r) {
  if (r <= 0) return m;
  const { data, info } = await sharp(m, { raw: { width: w, height: h, channels: 1 } })
    .blur(r)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(w * h);
  for (let p = 0; p < w * h; p++) {
    const v = data[p * info.channels];
    // Umbral bajo = dilata; rampa corta = borde antialiasado.
    out[p] = Math.max(0, Math.min(255, Math.round((v - 40) * 4)));
  }
  return out;
}

for (const n of TAMANIOS_CHICOS) {
  const L = n * ESCALA;
  const R = Math.round(L * (n <= 20 ? 0.18 : 0.22));
  const fondo = `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#1636b8"/>
  </linearGradient></defs>
  <rect x="0" y="0" width="${L}" height="${L}" rx="${R}" ry="${R}" fill="url(#g)"/>`;

  if (n === 16) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}" height="${L}">${fondo}${cuboSimple(L)}</svg>`;
    const final = await sharp(Buffer.from(svg)).resize(n, n, { kernel: 'lanczos3' }).png().toBuffer();
    writeFileSync(join(outDir, `${n}.png`), final);
    console.log(`  ✓ icon-small/${n}.png (cubo simplificado)`);
    continue;
  }

  // El cubo ocupa ~78% del cuadrado (antes ~50% por la placa con margen).
  const lado = Math.round(L * 0.78);
  const { m, w, h } = await mascaraCubo(lado);
  // El trazo del logo mide ~7% del ancho del cubo (medido). Se engrosa lo
  // necesario para que al tamaño final no baje de TRAZO_MIN.
  const trazoActual = lado * 0.07;
  const trazoQuerido = TRAZO_MIN * ESCALA;
  const r = Math.max(0, (trazoQuerido - trazoActual) / 2);
  const mm = await engrosar(m, w, h, r);

  const blanco = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    blanco[p * 4] = 255;
    blanco[p * 4 + 1] = 255;
    blanco[p * 4 + 2] = 255;
    blanco[p * 4 + 3] = mm[p];
  }
  const cubo = await sharp(blanco, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

  // Placa azul a sangre con esquinas redondeadas, degradé suave.
  const placa = `<svg xmlns="http://www.w3.org/2000/svg" width="${L}" height="${L}">${fondo}</svg>`;
  const grande = await sharp(Buffer.from(placa))
    .composite([{ input: cubo, left: Math.round((L - w) / 2), top: Math.round((L - h) / 2) }])
    .png()
    .toBuffer();
  const final = await sharp(grande).resize(n, n, { kernel: 'lanczos3' }).png().toBuffer();
  writeFileSync(join(outDir, `${n}.png`), final);
  console.log(`  ✓ icon-small/${n}.png (trazo engrosado ${r.toFixed(1)} px a escala ×${ESCALA})`);
}
