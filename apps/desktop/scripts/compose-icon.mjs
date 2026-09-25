/**
 * Arma el ícono oficial (build/icon.png, 1024x1024) a partir del cubo suelto
 * (build/logo-cubo.png): placa redondeada clara con degradé, sombra suave y el
 * cubo re-renderizado limpio en azul.
 *
 * Por qué: el cubo solo, con fondo transparente y bordes de recorte, en
 * Windows se ve pixelado a 16-48 px (la barra de tareas, el menú Inicio, el
 * escritorio). Una placa con contraste y el cubo con bordes suaves es lo que
 * usan los íconos de Windows 11 y macOS.
 *
 *   node scripts/compose-icon.mjs && node scripts/generate-icons.mjs
 */
import { existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, '..', 'build');
const cuboPath = join(buildDir, 'logo-cubo.png');
const iconPath = join(buildDir, 'icon.png');

// La primera vez, el cubo suelto es el icon.png histórico: se conserva aparte
// como fuente y no se vuelve a tocar.
if (!existsSync(cuboPath)) copyFileSync(iconPath, cuboPath);

const SIZE = 1024;
const CUBO = 620; // el cubo (ya recortado a su contorno) ocupa ~66% de la placa: a 16 px sigue legible

// 1) Máscara limpia del cubo: sólo los píxeles AZULES con alfa firme. El
// recorte original trae franjas cian semitransparentes y un interior lechoso;
// acá se descartan y quedan los trazos.
// `trim` saca los márgenes transparentes del recorte original: si no, el cubo
// queda chico dentro de la placa.
const { data, info } = await sharp(cuboPath).trim().resize(CUBO, CUBO, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).raw().toBuffer({ resolveWithObject: true });
const mask = Buffer.alloc(info.width * info.height);
for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
  const r = data[i], g = data[i + 1], b = data[i + 2], a = info.channels === 4 ? data[i + 3] : 255;
  const azul = b - Math.max(r, g);
  // Franja suave: azul pleno = 255, borde = proporcional, resto = 0.
  const fuerza = a < 60 ? 0 : Math.max(0, Math.min(1, (azul - 20) / 60));
  mask[p] = Math.round(255 * fuerza * (a / 255));
}
// Antialias parejo de la máscara (blur leve), en un solo canal.
// OJO: al desenfocar, sharp puede devolver 3 canales (sRGB) en vez de 1: se
// indexa por `mi.channels`, si no la imagen sale a rayas.
const { data: maskSuaveRaw, info: mi } = await sharp(mask, { raw: { width: info.width, height: info.height, channels: 1 } })
  .blur(0.8)
  .raw()
  .toBuffer({ resolveWithObject: true });
const maskSuave = (p) => maskSuaveRaw[p * mi.channels];

// 2) Cubo: relleno azul con degradé diagonal (más claro arriba-izquierda) y
// la máscara como alfa. Se arma el RGBA a mano: sharp convierte un PNG de un
// canal a sRGB y `joinChannel` deja de ser alfa (se vio: salía un cuadrado).
const lerp = (a, b, t) => Math.round(a + (b - a) * t);
const C1 = [0x2f, 0x6b, 0xff], C2 = [0x16, 0x36, 0xb8];
const rgba = Buffer.alloc(info.width * info.height * 4);
const sombraRaw = Buffer.alloc(info.width * info.height * 4);
for (let y = 0, p = 0; y < info.height; y++) {
  for (let x = 0; x < info.width; x++, p++) {
    const t = (x + y) / (info.width + info.height);
    rgba[p * 4] = lerp(C1[0], C2[0], t);
    rgba[p * 4 + 1] = lerp(C1[1], C2[1], t);
    rgba[p * 4 + 2] = lerp(C1[2], C2[2], t);
    rgba[p * 4 + 3] = maskSuave(p);
    sombraRaw[p * 4] = 0x0b; sombraRaw[p * 4 + 1] = 0x1f; sombraRaw[p * 4 + 2] = 0x5c;
    sombraRaw[p * 4 + 3] = Math.round(maskSuave(p) * 0.55);
  }
}
const cubo = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();

// 3) Sombra del cubo: la misma silueta, azul oscuro, desenfocada y corrida.
const sombra = await sharp(sombraRaw, { raw: { width: info.width, height: info.height, channels: 4 } })
  .blur(14)
  .png()
  .toBuffer();

// 4) Placa: cuadrado redondeado (radio 22%, el de Windows 11 / macOS) con
// degradé gris muy claro y un borde apenas marcado.
const R = Math.round(SIZE * 0.22);
const M = Math.round(SIZE * 0.04); // margen transparente alrededor
const placaSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs>
    <linearGradient id="p" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fafbfc"/><stop offset="100%" stop-color="#e2e6ec"/>
    </linearGradient>
  </defs>
  <rect x="${M}" y="${M}" width="${SIZE - 2 * M}" height="${SIZE - 2 * M}" rx="${R}" ry="${R}" fill="url(#p)"/>
  <rect x="${M + 1.5}" y="${M + 1.5}" width="${SIZE - 2 * M - 3}" height="${SIZE - 2 * M - 3}" rx="${R - 1.5}" ry="${R - 1.5}" fill="none" stroke="#0b1f5c" stroke-opacity="0.10" stroke-width="3"/>
</svg>`;

const left = Math.round((SIZE - info.width) / 2);
const top = Math.round((SIZE - info.height) / 2);
const out = await sharp(Buffer.from(placaSvg))
  .png()
  .composite([
    { input: sombra, left, top: top + 16, blend: 'over' },
    { input: cubo, left, top, blend: 'over' },
  ])
  .png({ compressionLevel: 9 })
  .toBuffer();

await sharp(out).toFile(iconPath);
console.log(`✓ build/icon.png (${(out.length / 1024).toFixed(0)} KB) — placa + cubo limpio. Ahora: node scripts/generate-icons.mjs`);
