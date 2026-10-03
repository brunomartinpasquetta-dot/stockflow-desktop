// Prueba: Tesseract (tesseract.js, sin IA pesada) sobre las fotos de muestras/.
// Uso: node leer.mjs [nombre-sin-extensión ...]
import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';

const fotos = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync('muestras').filter((f) => f.endsWith('.jpg')).map((f) => f.replace('.jpg', ''));
mkdirSync('salida', { recursive: true });

const worker = await createWorker('spa', 1, { cachePath: './tessdata' });
await worker.setParameters({
  tessedit_pageseg_mode: PSM.SINGLE_BLOCK, // una tabla = un bloque; conserva renglones
  preserve_interword_spaces: '1',
});

for (const nombre of fotos) {
  const t = Date.now();
  // Preparar la foto: enderezar según EXIF, gris, 2400 px de ancho, más contraste.
  const buf = await sharp(`muestras/${nombre}.jpg`).rotate().grayscale().resize({ width: 3200 }).normalise().threshold(150).toBuffer();
  const { data } = await worker.recognize(buf);
  writeFileSync(`salida/tess2_${nombre}.txt`, data.text);
  // También las palabras con su posición, para armar columnas después.
  writeFileSync(`salida/tess2_${nombre}.json`, JSON.stringify(data.lines?.map((l) => ({
    y: l.bbox.y0, texto: l.text.trim(),
    palabras: l.words.map((w) => ({ x0: w.bbox.x0, x1: w.bbox.x1, t: w.text, c: Math.round(w.confidence) })),
  })) ?? [], null, 0));
  console.log(`${nombre}: ${((Date.now() - t) / 1000).toFixed(1)}s · ${data.text.split('\n').filter(Boolean).length} líneas · confianza ${Math.round(data.confidence)}%`);
}
await worker.terminate();
