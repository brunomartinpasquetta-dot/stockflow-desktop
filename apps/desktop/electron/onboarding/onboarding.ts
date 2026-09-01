/**
 * PRIMEROS PASOS (E5) — checklist de onboarding COMPUTADA contra la realidad.
 *
 * No se almacena "progreso": cada paso se evalúa contra la base y la config
 * reales (¿hay empresa? ¿hay artículos? ¿hubo una venta? ¿impresora y backup
 * configurados?). La realidad ES el estado — no hay drift posible y "retomar"
 * es gratis. Lo único persistido es el descarte ("No mostrar más"), en
 * {userData}/onboarding.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type OnboardingStepId = 'empresa' | 'articulos' | 'venta' | 'impresora' | 'backup';

export interface OnboardingStep {
  id: OnboardingStepId;
  /** Etiqueta para la UI (sustantivos neutros, sin tecnicismos). */
  label: string;
  /** pageKey del registry a abrir al tocar el paso. */
  screen: string;
  done: boolean;
}

export interface OnboardingCounts {
  companies: number;
  articles: number;
  sales: number;
}

export interface OnboardingHardware {
  printer: unknown | null;
  backup?: { autoOnCashClose?: boolean; autoOnAppQuit?: boolean } | null;
}

export function computeSteps(c: OnboardingCounts, hw: OnboardingHardware): OnboardingStep[] {
  return [
    { id: 'empresa', label: 'Cargar los datos de tu comercio', screen: 'empresa', done: c.companies > 0 },
    { id: 'articulos', label: 'Cargar tu primer artículo (o importar tu Excel)', screen: 'articulos', done: c.articles > 0 },
    { id: 'venta', label: 'Hacer tu primera venta', screen: 'ventas', done: c.sales > 0 },
    { id: 'impresora', label: 'Configurar la impresora de tickets', screen: 'configuracion', done: hw.printer != null },
    {
      id: 'backup',
      label: 'Activar el backup automático',
      screen: 'configuracion',
      done: hw.backup?.autoOnCashClose === true || hw.backup?.autoOnAppQuit === true,
    },
  ];
}

const STATE_FILE = 'onboarding.json';

export function isOnboardingDismissed(userDataDir: string): boolean {
  try {
    return JSON.parse(readFileSync(join(userDataDir, STATE_FILE), 'utf8')).dismissed === true;
  } catch {
    return false;
  }
}

export function dismissOnboarding(userDataDir: string): void {
  writeFileSync(join(userDataDir, STATE_FILE), JSON.stringify({ dismissed: true, at: Date.now() }, null, 1));
}
