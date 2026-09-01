/**
 * PRIMEROS PASOS (E5) — canales del onboarding.
 *
 * `onboarding:status` computa la checklist contra la base y la config reales
 * (nunca hay progreso "guardado" que pueda desincronizarse). En MODO DEMO la
 * checklist se oculta: el usuario está practicando; al quitar la demo la base
 * vuelve virgen y la checklist reaparece intacta.
 */
import Database from 'better-sqlite3';

import { readDemoState } from '../../demo/DemoManager';
import { computeSteps, dismissOnboarding, isOnboardingDismissed, type OnboardingStep } from '../../onboarding/onboarding';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

export interface OnboardingStatus {
  /** true → la UI no muestra nada (descartado o en modo demo). */
  hidden: boolean;
  steps: OnboardingStep[];
  pending: number;
}

function counts(dbPath: string): { companies: number; articles: number; sales: number } {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const q = (sql: string): number => (raw.prepare(sql).get() as { n: number }).n;
    return {
      companies: q('SELECT COUNT(*) n FROM companies'),
      articles: q('SELECT COUNT(*) n FROM articles'),
      sales: q('SELECT COUNT(*) n FROM sales'),
    };
  } finally {
    raw.close();
  }
}

export function buildOnboardingHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'onboarding:status': withSession(deps, async (): Promise<OnboardingStatus> => {
      if (isOnboardingDismissed(deps.userDataDir) || readDemoState(deps.userDataDir).active) {
        return { hidden: true, steps: [], pending: 0 };
      }
      const steps = computeSteps(counts(deps.dbPath), deps.hardware.getConfig());
      const pending = steps.filter((s) => !s.done).length;
      // Todo hecho → no molestar más (sin necesidad de descarte manual).
      return { hidden: pending === 0, steps, pending };
    }),

    'onboarding:dismiss': withSession(deps, async (): Promise<{ ok: true }> => {
      dismissOnboarding(deps.userDataDir);
      return { ok: true };
    }),
  };
}
