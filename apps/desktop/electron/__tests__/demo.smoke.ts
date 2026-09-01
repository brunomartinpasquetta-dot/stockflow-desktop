/**
 * Pruebas del MODO DEMO (E5) — máquina de estados y restauración por snapshot.
 * Corre con: pnpm --filter @stockflow/desktop test:demo
 *
 * Solo la parte de archivos (estado + descarte al boot): no necesita DB ni
 * Electron. El sembrado completo se ejercita con el script de marketing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPendingDemoDiscard, readDemoState, requestDemoDiscard, writeDemoState } from '../demo/DemoManager';

let fails = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) fails++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  → ${extra}` : ''}`);
}

const dir = mkdtempSync(join(tmpdir(), 'stockflow-demo-smoke-'));
const dbPath = join(dir, 'stockflow.db');

/* Estado inicial */
check('sin demo.json → estado inactivo', readDemoState(dir).active === false);

/* requestDemoDiscard sin demo activa */
let r = requestDemoDiscard(dir);
check('quitar sin demo activa → rechazado', !r.ok && /no hay una demo activa/.test(r.motivo ?? ''));

/* Demo activa SIN respaldo: jamás se descarta nada */
writeDemoState(dir, { active: true, loadedAt: Date.now(), preDemoBackup: 'stockflow.db.pre-demo' });
r = requestDemoDiscard(dir);
check('quitar sin el archivo de respaldo → rechazado', !r.ok && /falta el respaldo/.test(r.motivo ?? ''));

/* Ciclo completo: snapshot manual + demo + descarte al boot */
writeFileSync(join(dir, 'stockflow.db.pre-demo'), 'BASE-VIRGEN');
writeFileSync(dbPath, 'BASE-CON-DEMO');
writeFileSync(`${dbPath}-wal`, 'WAL-DEMO');
writeFileSync(`${dbPath}-shm`, 'SHM-DEMO');
r = requestDemoDiscard(dir);
check('quitar con respaldo presente → aceptado', r.ok);
check('… queda marcado discardOnRestart', readDemoState(dir).discardOnRestart === true);

/* Boot SIN flag: no toca nada */
writeDemoState(dir, { active: true, preDemoBackup: 'stockflow.db.pre-demo' });
let boot = applyPendingDemoDiscard(dir, dbPath);
check('boot sin descarte pendiente → no restaura', !boot.restored && readFileSync(dbPath, 'utf8') === 'BASE-CON-DEMO');

/* Boot CON flag: restaura el snapshot, conserva la demo, limpia wal/shm */
writeDemoState(dir, { active: true, preDemoBackup: 'stockflow.db.pre-demo', discardOnRestart: true });
boot = applyPendingDemoDiscard(dir, dbPath);
check('boot con descarte → restaurado', boot.restored);
check('… la base vuelve byte-exacta al estado pre-demo', readFileSync(dbPath, 'utf8') === 'BASE-VIRGEN');
check('… la base demo se conserva renombrada', readdirSync(dir).some((f) => f.startsWith('stockflow.db.demo-descartada-')));
check('… wal/shm de la demo eliminados', !existsSync(`${dbPath}-wal`) && !existsSync(`${dbPath}-shm`));
check('… el estado queda inactivo', readDemoState(dir).active === false && !readDemoState(dir).discardOnRestart);

/* Boot con flag pero respaldo desaparecido: NO toca la base */
writeFileSync(dbPath, 'BASE-CON-DEMO-2');
writeDemoState(dir, { active: true, preDemoBackup: 'no-existe.db', discardOnRestart: true });
boot = applyPendingDemoDiscard(dir, dbPath);
check('boot con respaldo ausente → NO toca la base', !boot.restored && readFileSync(dbPath, 'utf8') === 'BASE-CON-DEMO-2');
check('… y limpia el flag para no reintentar a ciegas', readDemoState(dir).discardOnRestart === false);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);
