/**
 * Genera los assets binarios para el packaging (electron-builder) a partir de
 * `build/icon.svg`. Idempotente: borralos cuando quieras y volvé a correrlo.
 *
 *   pnpm --filter @stockflow/desktop run generate:icons
 *
 * Salidas (todas en `build/`):
 *   - icon.png            (1024x1024)
 *   - icon.icns           (macOS, multi-tamaño)
 *   - icon.ico            (Windows, multi-tamaño)
 *   - dmg-background.png  (540x380, fondo del .dmg)
 *   - installerHeader.bmp (150x57,  NSIS)
 *   - installerSidebar.bmp (164x314, NSIS)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import png2icons from 'png2icons';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, '..', 'build');
mkdirSync(buildDir, { recursive: true });

const svgPath = join(buildDir, 'icon.svg');
const svg = readFileSync(svgPath);

async function renderPng(size) {
  return await sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();
}

async function writeFile(name, buf) {
  const target = join(buildDir, name);
  writeFileSync(target, buf);
  console.log(`  ✓ ${name} (${(buf.length / 1024).toFixed(1)} KB)`);
}

console.log('Generando íconos desde build/icon.svg...');

// 1) PNG master 1024 — usado por linux + base de los otros formatos.
const png1024 = await renderPng(1024);
await writeFile('icon.png', png1024);

// 2) ICNS macOS (multi-resolución).
const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
if (!icns) throw new Error('No se pudo generar icon.icns');
await writeFile('icon.icns', icns);

// 3) ICO Windows (multi-resolución).
const ico = png2icons.createICO(png1024, png2icons.BILINEAR, 0, false, true);
if (!ico) throw new Error('No se pudo generar icon.ico');
await writeFile('icon.ico', ico);

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
