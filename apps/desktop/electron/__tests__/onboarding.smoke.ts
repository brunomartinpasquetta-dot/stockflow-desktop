/**
 * Pruebas de PRIMEROS PASOS (E5). Corre con:
 *   pnpm --filter @stockflow/desktop test:onboarding
 * Lógica pura (computeSteps) + persistencia del descarte. Sin DB ni Electron.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeSteps, dismissOnboarding, isOnboardingDismissed } from '../onboarding/onboarding';

let fails = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) fails++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  → ${extra}` : ''}`);
}

/* Base virgen: todo pendiente */
let steps = computeSteps({ companies: 0, articles: 0, sales: 0 }, { printer: null, backup: null });
check('base virgen → 5 pasos, todos pendientes', steps.length === 5 && steps.every((s) => !s.done));
check('cada paso apunta a una pantalla', steps.every((s) => s.screen.length > 0));

/* Progreso real: los tildes salen de la realidad */
steps = computeSteps(
  { companies: 1, articles: 44, sales: 0 },
  { printer: { kind: 'system' }, backup: { autoOnCashClose: true } },
);
const byId = Object.fromEntries(steps.map((s) => [s.id, s.done]));
check('empresa cargada → tildada', byId.empresa === true);
check('artículos cargados → tildado', byId.articulos === true);
check('sin ventas → pendiente', byId.venta === false);
check('impresora configurada → tildada', byId.impresora === true);
check('backup con auto → tildado', byId.backup === true);

/* backup sin ningún automático NO cuenta como hecho */
steps = computeSteps({ companies: 1, articles: 1, sales: 1 }, { printer: null, backup: { autoOnCashClose: false, autoOnAppQuit: false } });
check('backup sin automáticos → pendiente', steps.find((s) => s.id === 'backup')!.done === false);

/* Descarte persistente */
const dir = mkdtempSync(join(tmpdir(), 'stockflow-onb-'));
check('sin archivo → no descartado', isOnboardingDismissed(dir) === false);
dismissOnboarding(dir);
check('tras descartar → descartado', isOnboardingDismissed(dir) === true);
rmSync(dir, { recursive: true, force: true });

console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`);
process.exit(fails === 0 ? 0 : 1);
