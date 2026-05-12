// Marca dist-electron/ como CommonJS para que Electron cargue main.js/preload.js
// correctamente aunque el package.json de la app declare "type": "module".
import { mkdirSync, writeFileSync } from 'node:fs';

mkdirSync('dist-electron', { recursive: true });
writeFileSync('dist-electron/package.json', `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);
