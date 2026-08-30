/**
 * CONSULTAS AL SISTEMA — Flowy responde con los datos reales del negocio.
 *
 * Hasta ahora Flowy explicaba CÓMO hacer las cosas ("andá a Caja y mirá el
 * reporte"). Con esto contesta directamente: "Vendiste $340.500 hoy". El
 * usuario no tiene que ir a buscar nada.
 *
 * Es deterministico a propósito: NO adivina ni interpreta con un modelo. Cada
 * consulta reconoce una forma de preguntar y ejecuta una lectura concreta de
 * la base. Si no está seguro, no responde y deja que siga el motor de siempre
 * — es preferible explicar dónde mirar que inventar un número.
 *
 * PERMISOS: cada consulta declara qué PermissionAction requiere y se valida
 * contra el rol del usuario en sesión. Flowy responde con los MISMOS límites
 * que la UI: un rol sin Reportes no obtiene las ventas del día por el chat.
 */
import { effectivePermissionsFor, type PermissionAction } from '@stockflow/core';
import type { Repositories } from '@stockflow/db';
import type { UserRole } from '@stockflow/shared';

export interface ConsultaCtx {
  repos: Repositories;
  user: { role: UserRole };
}

/** Mismo criterio que la UI: la lista efectiva de permisos del rol. */
function puede(user: { role: UserRole }, permiso: PermissionAction): boolean {
  return effectivePermissionsFor(user.role).includes(permiso);
}

const SIN_PERMISO =
  'Esa información está limitada por los permisos de tu usuario, así que no te la puedo mostrar. ' +
  'Si la necesitás, pedísela a quien administra StockFlow en tu comercio.';

/** Sin acentos y en minúsculas, para comparar como la gente escribe. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const money = (v: string | number): string =>
  `$${Number(v).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Rango de hoy en milisegundos. */
function hoy(): { desde: number; hasta: number } {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const h = new Date();
  h.setHours(23, 59, 59, 999);
  return { desde: d.getTime(), hasta: h.getTime() };
}

interface Consulta {
  id: string;
  /** Frases que disparan la consulta (ya normalizadas). */
  frases: string[];
  /** Permiso necesario para ver este dato — el mismo que exige la UI. */
  permiso: PermissionAction;
  responder: (ctx: ConsultaCtx, pregunta: string) => Promise<string | null>;
}

const CONSULTAS: Consulta[] = [
  {
    id: 'ventas-de-hoy',
    permiso: 'view_reports',
    frases: [
      'cuanto vendi hoy', 'cuanto vendimos hoy', 'ventas de hoy', 'venta del dia',
      'cuanto se vendio hoy', 'total vendido hoy', 'cuanto facture hoy',
      'cuanto lleve vendido', 'como venimos hoy', 'cuanto va la venta',
    ],
    async responder({ repos }) {
      const { desde, hasta } = hoy();
      const ventas = await repos.sales.findByDateRange(desde, hasta);
      const validas = ventas.filter((v) => v.status !== 'voided');
      if (validas.length === 0) return 'Todavía no hay ventas registradas hoy.';
      const total = validas.reduce((a, v) => a + Number(v.total), 0);
      return (
        `Hoy llevás ${validas.length} venta${validas.length === 1 ? '' : 's'} ` +
        `por ${money(total)}.`
      );
    },
  },
  {
    id: 'efectivo-en-caja',
    permiso: 'open_cash',
    frases: [
      'cuanto hay en caja', 'cuanto tengo en caja', 'efectivo en caja',
      'cuanta plata hay en caja', 'saldo de caja', 'cuanto hay en el cajon',
    ],
    async responder({ repos }) {
      const caja = await repos.cashRegisters.getCurrentOpen();
      if (!caja) return 'No hay ninguna caja abierta en este momento.';
      const movs = await repos.cashMovements.findByRegister(caja.id);
      const pms = await repos.paymentMethods.byId();
      let efectivo = Number(caja.openingAmount);
      for (const m of movs) {
        const fisico = m.paymentMethodId == null || pms.get(m.paymentMethodId)?.isPhysicalCash === true;
        if (!fisico) continue;
        efectivo += (m.type === 'income' ? 1 : -1) * Number(m.amount);
      }
      return (
        `En la caja #${caja.number} tenés ${money(efectivo)} en efectivo ` +
        `(abriste con ${money(caja.openingAmount)}).`
      );
    },
  },
  {
    id: 'saldo-caja-general',
    permiso: 'view_cash_general',
    frases: [
      'cuanto hay en caja general', 'saldo de caja general', 'cuanto tengo en la caja fuerte',
      'cuanto hay en la caja general', 'plata en caja general',
    ],
    async responder({ repos }) {
      const b = await repos.cashGeneral.getBalanceBreakdown();
      return (
        `Caja General: ${money(b.total)} en total — ${money(b.cash)} en efectivo ` +
        `y ${money(b.electronic)} en electrónico.`
      );
    },
  },
  {
    id: 'quien-me-debe',
    permiso: 'receive_payment',
    frases: [
      'quien me debe', 'quienes me deben', 'cuanto me deben', 'deudores',
      'clientes que me deben', 'cuentas corrientes pendientes', 'total por cobrar',
    ],
    async responder({ repos }) {
      const saldos = await repos.accountsReceivable.listBalances();
      const conDeuda = saldos.filter((s) => Number(s.totalDebt) > 0);
      if (conDeuda.length === 0) return 'No hay clientes con saldo pendiente. 👌';
      const total = conDeuda.reduce((a, s) => a + Number(s.totalDebt), 0);
      // El saldo viene por id: se traen los nombres para que la respuesta sea
      // útil ("Gómez debe $12.000") y no una lista de códigos.
      const conNombre = await Promise.all(
        conDeuda
          .sort((a, b) => Number(b.totalDebt) - Number(a.totalDebt))
          .slice(0, 5)
          .map(async (s) => {
            const c = await repos.customers.findById(s.customerId);
            const nombre = c ? `${c.lastName}${c.firstName ? ' ' + c.firstName : ''}` : 'Cliente';
            return `• ${nombre}: ${money(s.totalDebt)}`;
          }),
      );
      const resto = conDeuda.length > 5 ? `\n…y ${conDeuda.length - 5} más.` : '';
      return `Te deben ${money(total)} entre ${conDeuda.length} cliente(s):\n${conNombre.join('\n')}${resto}`;
    },
  },
  {
    id: 'stock-bajo',
    permiso: 'view_articles',
    frases: [
      'que articulos tengo que reponer', 'stock bajo', 'articulos con poco stock',
      'que me falta comprar', 'que tengo que pedir', 'articulos sin stock',
      'que se esta por acabar',
    ],
    async responder({ repos }) {
      const bajos = await repos.articles.findLowStock();
      if (!bajos.length) return 'No hay artículos por debajo del stock mínimo. 👌';
      const top = bajos
        .slice(0, 8)
        .map((a) => `• ${a.description}: quedan ${Number(a.stock)}`)
        .join('\n');
      const resto = bajos.length > 8 ? `\n…y ${bajos.length - 8} más.` : '';
      return `Hay ${bajos.length} artículo(s) para reponer:\n${top}${resto}`;
    },
  },
];

/**
 * Consultas de un artículo puntual: precio y stock.
 *
 * `estricto`: los patrones con "stock de X" / "precio de X" son inequívocamente
 * sobre artículos → si no hay resultados se responde "no lo encontré" (útil).
 * El patrón amplio de precio ("cuánto cuesta/sale/está X") matchea CUALQUIER
 * cosa ("¿a cuánto está el dólar?"): si no encuentra el artículo devuelve null
 * para que la pregunta siga al motor de conocimiento y quede en el log de
 * misses — antes secuestraba la pregunta y moría acá.
 */
const PATRON_ARTICULO: { rx: RegExp; estricto: boolean }[] = [
  { rx: /(?:tengo|hay|queda|quedan)\s+stock\s+de\s+(.+)/, estricto: true },
  { rx: /(?:cuanto|cuantos|cuantas)\s+(?:stock\s+)?(?:tengo|hay|quedan?)\s+de\s+(.+)/, estricto: true },
  { rx: /stock\s+de\s+(.+)/, estricto: true },
  { rx: /(?:cuanto|a cuanto)\s+(?:cuesta|sale|esta|vale)\s+(?:el|la|los|las)?\s*(.+)/, estricto: false },
  { rx: /precio\s+de\s+(?:la|el|los|las)?\s*(.+)/, estricto: true },
];

async function consultarArticulo(ctx: ConsultaCtx, pregunta: string): Promise<string | null> {
  // Consultar artículos por chat exige el mismo permiso que verlos en la UI.
  if (!puede(ctx.user, 'view_articles')) return null;
  const n = norm(pregunta);
  let termino: string | null = null;
  let quierePrecio = false;
  let estricto = false;
  for (const { rx, estricto: e } of PATRON_ARTICULO) {
    const m = n.match(rx);
    if (m?.[1]) {
      termino = m[1].trim();
      quierePrecio = /cuesta|sale|vale|precio|esta/.test(rx.source);
      estricto = e;
      break;
    }
  }
  if (!termino || termino.length < 3) return null;

  const encontrados = await ctx.repos.articles.searchByText(termino);
  if (!encontrados.length) {
    if (!estricto) return null; // pregunta ambigua sin match → sigue el motor
    return `No encontré ningún artículo que se llame "${termino}". Probá con otra palabra.`;
  }
  if (encontrados.length === 1) {
    const a = encontrados[0]!;
    return quierePrecio
      ? `${a.description}: ${money(a.listPrice1)}${Number(a.stock) > 0 ? ` (quedan ${Number(a.stock)})` : ' — sin stock'}`
      : `${a.description}: quedan ${Number(a.stock)} — ${money(a.listPrice1)}`;
  }
  const lista = encontrados
    .slice(0, 5)
    .map((a) => `• ${a.description}: ${money(a.listPrice1)} (stock ${Number(a.stock)})`)
    .join('\n');
  return `Encontré varios:\n${lista}`;
}

/**
 * Intenta responder con datos del sistema. Devuelve null si la pregunta no es
 * de este tipo, para que siga el motor de conocimiento habitual.
 */
export async function responderConDatos(
  ctx: ConsultaCtx,
  pregunta: string,
): Promise<string | null> {
  const n = norm(pregunta);
  if (!n) return null;

  // Gana la frase MÁS ESPECÍFICA (más larga) entre todas las consultas, no la
  // primera en orden de lista: "cuánto hay en caja general" contiene también
  // "cuanto hay en caja" y respondía el efectivo de la caja diaria.
  let mejor: { c: Consulta; len: number } | null = null;
  for (const c of CONSULTAS) {
    for (const f of c.frases) {
      if (n.includes(f) && (!mejor || f.length > mejor.len)) mejor = { c, len: f.length };
    }
  }
  if (mejor) {
    // El dato existe pero el rol no puede verlo: se dice honesto y claro,
    // en vez de dejar caer la pregunta al motor (que explicaría dónde
    // mirarlo en una pantalla que el usuario tampoco puede abrir).
    if (!puede(ctx.user, mejor.c.permiso)) return SIN_PERMISO;
    try {
      return await mejor.c.responder(ctx, pregunta);
    } catch {
      // Si la consulta falla, mejor que conteste el motor de siempre que
      // devolver un error al usuario.
      return null;
    }
  }

  try {
    return await consultarArticulo(ctx, pregunta);
  } catch {
    return null;
  }
}
