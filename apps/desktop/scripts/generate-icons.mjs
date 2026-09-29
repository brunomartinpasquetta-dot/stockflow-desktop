/**
 * Genera los assets binarios para el packaging (electron-builder) a partir de
 * `build/icon.png` (1024x1024) — fuente autoritativa del branding oficial.
 * Si el PNG no existe, cae al SVG. Idempotente.
 *
 *   pnpm --filter @stockflow/desktop run generate:icons
 *
 * Salidas (todas en `build/`):
 *   - icon.png            (1024x1024) — preservado si ya existe en alta resolución
 *   - icon.icns           (macOS, multi-tamaño)
 *   - icon.ico            (Windows, multi-tamaño)
 *   - dmg-background.png  (540x380, fondo del .dmg)
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import png2icons from 'png2icons';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, '..', 'build');
mkdirSync(buildDir, { recursive: true });

const pngPath = join(buildDir, 'icon.png');
const svgPath = join(buildDir, 'icon.svg');

async function writeFile(name, buf) {
  const target = join(buildDir, name);
  writeFileSync(target, buf);
  console.log(`  ✓ ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log('Generando íconos para packaging...');

// 1) PNG master 1024 — preferimos el icon.png oficial si pesa razonable (>50KB),
// caso contrario lo renderizamos desde el SVG.
let png1024;
if (existsSync(pngPath) && statSync(pngPath).size > 50 * 1024) {
  console.log(`  · usando build/icon.png existente (${(statSync(pngPath).size / 1024).toFixed(1)} KB) como fuente`);
  png1024 = await sharp(pngPath).resize(1024, 1024).png().toBuffer();
} else {
  const svg = readFileSync(svgPath);
  png1024 = await sharp(svg, { density: 384 }).resize(1024, 1024).png().toBuffer();
}
await writeFile('icon.png', png1024);

// 2) ICNS macOS (multi-resolución).
const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
if (!icns) throw new Error('No se pudo generar icon.icns');
await writeFile('icon.icns', icns);

// 3) ICO Windows (multi-resolución). Los tamaños que Windows usa en la barra
// de tareas, el escritorio y la ventana (16–64) NO salen de achicar el de 1024:
// ese es la placa clara con el cubo fino, y achicado se veía granulado (a 16 px
// se desarmaba). Salen de compose-icon-small.mjs, dibujados para su tamaño.
// Los grandes (72–256) sí se reducen del maestro, con Lanczos en vez del
// bilineal de png2icons. Todas las entradas van en PNG (Windows 7 en adelante).
execFileSync(process.execPath, [join(here, 'compose-icon-small.mjs')], { stdio: 'inherit' });
const entradas = [];
for (const n of [256, 128, 96, 72]) {
  entradas.push({ n, png: await sharp(png1024).resize(n, n, { kernel: 'lanczos3' }).png().toBuffer() });
}
for (const n of [64, 48, 40, 32, 24, 20, 16]) {
  entradas.push({ n, png: readFileSync(join(buildDir, 'icon-small', `${n}.png`)) });
}
const cabecera = Buffer.alloc(6 + 16 * entradas.length);
cabecera.writeUInt16LE(0, 0);
cabecera.writeUInt16LE(1, 2);
cabecera.writeUInt16LE(entradas.length, 4);
let offset = cabecera.length;
entradas.forEach(({ n, png }, i) => {
  const o = 6 + 16 * i;
  cabecera.writeUInt8(n >= 256 ? 0 : n, o);
  cabecera.writeUInt8(n >= 256 ? 0 : n, o + 1);
  cabecera.writeUInt8(0, o + 2);
  cabecera.writeUInt8(0, o + 3);
  cabecera.writeUInt16LE(1, o + 4);
  cabecera.writeUInt16LE(32, o + 6);
  cabecera.writeUInt32LE(png.length, o + 8);
  cabecera.writeUInt32LE(offset, o + 12);
  offset += png.length;
});
await writeFile('icon.ico', Buffer.concat([cabecera, ...entradas.map((e) => e.png)]));

// 4) DMG background — gradiente azul + logo a la izquierda.
const dmgSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 540 380" width="540" height="380">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1e40af"/>
      <stop offset="100%" stop-color="#0b1f5c"/>
    </linearGradient>
  </defs>
  <rect width="540" height="380" fill="url(#bg)"/>
  <text x="270" y="60" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="white" text-anchor="middle">StockFlow</text>
  <text x="270" y="92" font-family="Helvetica, Arial, sans-serif" font-size="14" fill="#cbd5ff" text-anchor="middle">Arrastrá la app a Aplicaciones</text>
</svg>`;
const dmgBg = await sharp(Buffer.from(dmgSvg)).png().toBuffer();
await writeFile('dmg-background.png', dmgBg);

// NSIS header/sidebar BMPs no se generan (sharp no soporta BMP). El installer NSIS
// usa los defaults de electron-builder, lo cual es aceptable para esta fase.

console.log('Listo.');
