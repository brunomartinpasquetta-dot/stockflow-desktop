// Crea una base de StockFlow VACÍA (migraciones al día + usuario admin), igual
// a la que deja la app al abrirse por primera vez. Es la base destino de
// `migrar.py migrar`. Se corre con el Electron del repo, que trae el
// better-sqlite3 compilado para su ABI:
//
//   cd apps/desktop && ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron \
//     node_modules/tsx/dist/cli.mjs ../../tools/migracion/crear-db-vacia.ts /ruta/stockflow.db
//
// Después de usarlo en la misma terminal: `unset ELECTRON_RUN_AS_NODE`, o la
// app de escritorio arranca como Node pelado y no abre.
import { existsSync } from 'node:fs';
// Ruta relativa y no `@stockflow/db`: esta carpeta no es un workspace de pnpm
// y el paquete no se resuelve desde acá.
import { closeLocalDb, initLocalDb } from '../../packages/db/src/index';

const destino = process.argv[2];
if (!destino) throw new Error('Falta la ruta destino, p.ej. /tmp/stockflow.db');
if (existsSync(destino)) throw new Error(`Ya existe ${destino}: borralo o elegí otra ruta (tiene que nacer vacía)`);

const { db } = initLocalDb(destino, { seed: true });
const users = db.$client.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
console.log(`Base vacía lista: ${destino} (usuarios: ${users.n}). Ahora: python3 migrar.py migrar ${destino} PRECIO2`);
closeLocalDb(db);
