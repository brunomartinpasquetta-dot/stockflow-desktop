/**
 * Genera el ÍNDICE BASE de Flowy con IA: electron/assistant/ia/flowy-indice-base.json
 *
 * Es el índice de significado de toda la base de conocimiento, ya calculado.
 * Viaja con la app para que las PCs de los clientes no tengan que armarlo (sin
 * placa de video tardarían unos minutos). Las PCs sólo calculan las frases
 * que cambien después.
 *
 * Cuándo correrlo: cada vez que cambie la base de Flowy (intents.json) o el
 * manual (sections.json), antes de publicar. Si se olvida no se rompe nada:
 * cada PC calcula sólo lo que cambió.
 *
 * Requiere Ollama corriendo en esta Mac con el modelo embeddinggemma:300m-qat-q8_0.
 *   pnpm --filter @stockflow/desktop flowy:indice
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ARCHIVO_INDICE_BASE, FlowyIA } from '../electron/assistant/ia/flowyIA';

const aqui = dirname(fileURLToPath(import.meta.url));
const destino = join(aqui, '..', 'electron', 'assistant', 'ia', ARCHIVO_INDICE_BASE);
const tmp = mkdtempSync(join(tmpdir(), 'flowy-indice-'));

async function main(): Promise<void> {
  const inicio = Date.now();
  // Reutiliza la base anterior: sólo se calculan las frases nuevas o cambiadas.
  const ia = new FlowyIA({ userDataDir: tmp, rutaIndiceBase: destino, log: (m) => console.log(`  · ${m}`) });
  await ia.configurar({ modo: 'entender' });
  await ia.preparar();
  const e = await ia.estado();
  if (e.indice.estado !== 'listo') {
    console.error(`❌ No se pudo armar el índice: ${e.ultimoError ?? e.indice.estado}`);
    console.error('   ¿Está Ollama abierto y con el modelo embeddinggemma:300m-qat-q8_0 descargado?');
    process.exit(1);
  }
  copyFileSync(join(tmp, 'flowy-ia-indice.json'), destino);
  console.log(`✅ Índice base listo: ${e.indice.vectores} vectores en ${Math.round((Date.now() - inicio) / 1000)} s → ${destino}`);
}

main()
  .catch((err) => {
    console.error('❌', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(() => rmSync(tmp, { recursive: true, force: true }));
