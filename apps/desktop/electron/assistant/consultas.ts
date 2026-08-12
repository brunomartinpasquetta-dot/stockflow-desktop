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
 */
import type { Repositories } from '@stockflow/db';

export interface ConsultaCtx {
  repos: Repositories;
}

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
  responder: (ctx: ConsultaCtx, pregunta: string) => Promise<string | null>;
}

const CONSULTAS: Consulta[] = [
  {
    id: 'ventas-de-hoy',
    frases: [
      'cuanto vendi hoy', 'cuanto vendimos hoy', 'ventas de hoy', 'venta del dia',
      'cuanto se vendio hoy', 'total vendido hoy', 'cuanto facture hoy',
      'cuanto lleve vendido', 'como venimos hoy', 'cuanto va la venta',
    ],
    async responder({ repos }) {
      const { desde, hasta } = hoy();
      const ventas = await repos.sales.findByDateRange({ from: desde, to: hasta });
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

/** Consultas de un artículo puntual: precio y stock. */
const PATRON_ARTICULO = [
  /(?:tengo|hay|queda|quedan)\s+stock\s+de\s+(.+)/,
  /(?:cuanto|cuantos|cuantas)\s+(?:stock\s+)?(?:tengo|hay|quedan?)\s+de\s+(.+)/,
  /stock\s+de\s+(.+)/,
  /(?:cuanto|a cuanto)\s+(?:cuesta|sale|esta|vale)\s+(?:el|la|los|las)?\s*(.+)/,
  /precio\s+de\s+(?:la|el|los|las)?\s*(.+)/,
];

async function consultarArticulo(ctx: ConsultaCtx, pregunta: string): Promise<string | null> {
  const n = norm(pregunta);
  let termino: string | null = null;
  let quierePrecio = false;
  for (const rx of PATRON_ARTICULO) {
    const m = n.match(rx);
    if (m?.[1]) {
      termino = m[1].trim();
      quierePrecio = /cuesta|sale|vale|precio|esta/.test(rx.source);
      break;
    }
  }
  if (!termino || termino.length < 3) return null;

  const encontrados = await ctx.repos.articles.searchByText(termino, 5);
  if (!encontrados.length) {
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

  for (const c of CONSULTAS) {
    if (c.frases.some((f) => n.includes(f))) {
      try {
        return await c.responder(ctx, pregunta);
      } catch {
        // Si la consulta falla, mejor que conteste el motor de siempre que
        // devolver un error al usuario.
        return null;
      }
    }
  }

  try {
    return await consultarArticulo(ctx, pregunta);
  } catch {
    return null;
  }
}
