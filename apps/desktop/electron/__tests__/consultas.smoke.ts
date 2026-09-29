/**
 * Pruebas de la capa de CONSULTAS CON DATOS de Flowy. Corre con:
 *   pnpm --filter @stockflow/desktop test:consultas
 *
 * Cubre las dos regresiones de la auditoría E0:
 *  (1) PERMISOS: las consultas de datos respetan el RBAC — un rol sin
 *      view_reports/view_cash_general NO recibe cifras por el chat.
 *  (2) SECUESTRO: el patrón amplio de precio ("¿a cuánto está el dólar?") ya
 *      no corta el pipeline cuando no encuentra un artículo — devuelve null y
 *      la pregunta sigue al motor de conocimiento (y al log de misses).
 *
 * Usa repos stub (sin DB): consultas.ts solo necesita los métodos que llama.
 */
import { responderConDatos } from '../assistant/consultas';

let fails = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) fails++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  → ${extra}` : ''}`);
}

const repos = {
  sales: { findByDateRange: async () => [{ total: '1500', status: 'completed' }] },
  cashRegisters: { getCurrentOpen: async () => null },
  cashGeneral: { getBalanceBreakdown: async () => ({ total: '99000', cash: '50000', electronic: '49000' }) },
  accountsReceivable: { listBalances: async () => [] },
  articles: {
    findLowStock: async () => [],
    searchByText: async (t: string) =>
      t.includes('tornillo') ? [{ description: 'Tornillo 4mm', listPrice1: '100', stock: '25' }] : [],
  },
  customers: { findById: async () => null },
  paymentMethods: { byId: async () => new Map() },
  cashMovements: { findByRegister: async () => [] },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const admin = { role: 'admin' } as { role: 'admin' };
const seller = { role: 'seller' } as { role: 'seller' };

const run = async (): Promise<void> => {
  /* (1) RBAC */
  const ventasSeller = await responderConDatos({ repos, user: seller }, 'cuanto vendi hoy');
  check(
    'seller SIN view_reports no recibe las ventas del día',
    ventasSeller != null && /permisos de tu usuario/i.test(ventasSeller) && !ventasSeller.includes('1'),
    ventasSeller?.slice(0, 60) ?? 'null',
  );

  const ventasAdmin = await responderConDatos({ repos, user: admin }, 'cuanto vendi hoy');
  check('admin SÍ recibe las ventas del día', ventasAdmin != null && ventasAdmin.includes('1.500'), ventasAdmin?.slice(0, 60) ?? 'null');

  const cgSeller = await responderConDatos({ repos, user: seller }, 'cuanto hay en caja general');
  check(
    'seller SIN view_cash_general no recibe Caja General',
    cgSeller != null && /permisos de tu usuario/i.test(cgSeller) && !cgSeller.includes('99'),
    cgSeller?.slice(0, 60) ?? 'null',
  );

  const cgAdmin = await responderConDatos({ repos, user: admin }, 'saldo de caja general');
  check('admin SÍ recibe Caja General', cgAdmin != null && cgAdmin.includes('99.000'), cgAdmin?.slice(0, 60) ?? 'null');

  /* (2) Secuestro del patrón amplio de precio */
  const dolar = await responderConDatos({ repos, user: admin }, 'a cuanto esta el dolar');
  check('"¿a cuánto está el dólar?" sin match → null (sigue al motor)', dolar === null, String(dolar).slice(0, 60));

  const plan = await responderConDatos({ repos, user: admin }, 'cuanto sale el plan de stockflow');
  check('"cuánto sale el plan…" sin match → null (sigue al motor)', plan === null, String(plan).slice(0, 60));

  /* Los patrones ESTRICTOS conservan la respuesta útil de "no encontrado" */
  const stockNada = await responderConDatos({ repos, user: admin }, 'stock de bulon fantasma');
  check('"stock de X" sin match conserva el "no encontré"', stockNada != null && /no encontr/i.test(stockNada), stockNada?.slice(0, 60) ?? 'null');

  const stockOk = await responderConDatos({ repos, user: admin }, 'stock de tornillo');
  check('"stock de tornillo" responde con el dato', stockOk != null && stockOk.includes('Tornillo'), stockOk?.slice(0, 60) ?? 'null');

  console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`);
  process.exit(fails === 0 ? 0 : 1);
};

void run();
