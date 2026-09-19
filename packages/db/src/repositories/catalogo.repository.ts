/**
 * Repositorio del ESPEJO DEL CATÁLOGO WEB.
 *
 * Dos responsabilidades: el estado del sincronizador (singleton) y la lista de
 * artículos a publicar.
 *
 * Lo que se publica es ESTADO, no eventos: "este artículo tiene 7 disponibles",
 * nunca "salieron 3". Por eso reenviar un artículo de más no rompe nada y la PC
 * puede estar apagada una semana sin que haya que reconstruir un historial.
 */
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import { rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import {
  articles,
  companies,
  catalogoPedidos,
  catalogoSync,
  sales,
  type CatalogoPedido,
  type CatalogoSync,
} from '../schema/local';

const SYNC_ID = 'singleton';

/** Un artículo tal como viaja al catálogo. */
export interface ArticuloParaCatalogo {
  /** Código de barras: es la clave que une los dos mundos. */
  codigo: string;
  nombre: string;
  precio: number;
  /** Lo que se puede vender por web AHORA (stock real menos lo reservado). */
  stock: number;
  activo: boolean;
  unidad: string;
}

/**
 * Redondea un decimal-como-string a `decimals` posiciones sin pasar por
 * punto flotante. `Number(v).toFixed(decimals)` — lo que hacen los helpers de
 * `@stockflow/shared` — tiene el MISMO problema que `Math.round(v*100)/100`:
 * los dos representan el valor en IEEE-754 antes de redondear, y un límite
 * exacto como '1.005' se guarda como 1.00499999999999989..., así que redondea
 * para abajo (1.00 en vez de 1.01). Acá se redondea sobre el STRING, dígito a
 * dígito, así que el límite exacto siempre cae del lado correcto.
 */
function redondearExacto(valor: string | number, decimals: number): number {
  const s = String(valor);
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [enteroStr, fracStr = ''] = abs.split('.');
  const relleno = (fracStr + '0'.repeat(decimals + 1)).slice(0, decimals + 1);
  let n = BigInt((enteroStr || '0') + relleno.slice(0, decimals));
  if (Number(relleno[decimals]) >= 5) n += 1n;
  const digitos = n.toString().padStart(decimals + 1, '0');
  const entero = digitos.slice(0, digitos.length - decimals) || '0';
  const frac = decimals > 0 ? `.${digitos.slice(digitos.length - decimals)}` : '';
  return Number(`${neg ? '-' : ''}${entero}${frac}`);
}

export class CatalogoRepository {
  constructor(private readonly db: LocalDatabase) {}

  /* ----------------------------- Estado ------------------------------ */

  getState(): CatalogoSync {
    try {
      const row = this.db.select().from(catalogoSync).where(eq(catalogoSync.id, SYNC_ID)).get();
      if (row) return row;
      const now = Date.now();
      const fresh = {
        id: SYNC_ID,
        enabled: false,
        cursor: 0,
        lastRunAt: null,
        lastOkAt: null,
        lastError: null,
        pushedTotal: 0,
        crearFaltantes: true,
        createdAt: now,
        updatedAt: now,
      } satisfies CatalogoSync;
      // onConflictDoNothing: si otro proceso ganó la carrera del primer
      // arranque (dos instancias abriendo el mismo archivo a la vez), esto no
      // revienta por clave primaria duplicada — se re-lee y listo.
      this.db.insert(catalogoSync).values(fresh).onConflictDoNothing().run();
      return this.db.select().from(catalogoSync).where(eq(catalogoSync.id, SYNC_ID)).get() ?? fresh;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Actualiza solo los campos que cambian (antes reescribía `id`/`createdAt`
   *  con su propio valor en cada guardado, por armar el objeto completo). */
  saveState(patch: Partial<Omit<CatalogoSync, 'id' | 'createdAt'>>): CatalogoSync {
    try {
      const current = this.getState();
      const updatedAt = Date.now();
      this.db.update(catalogoSync).set({ ...patch, updatedAt }).where(eq(catalogoSync.id, SYNC_ID)).run();
      return { ...current, ...patch, updatedAt };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /* --------------------------- Artículos ----------------------------- */

  /**
   * Artículos cambiados después de `cursor`, listos para publicar.
   *
   * Van los INACTIVOS también: darlos de baja en el sistema tiene que sacarlos
   * de la web, y para eso el catálogo necesita enterarse.
   *
   * `precioLista` elige qué lista se publica (1, 2 o 3).
   *
   * El cursor es la marca de agua sobre `updatedAt`. Si un UPDATE masivo dejó
   * a muchos artículos con el MISMO milisegundo (por ejemplo el reset de
   * operativa, que pone todo el stock en cero de un saque) y la tanda corta
   * justo en medio de ese grupo, el resto quedaría del otro lado de un cursor
   * `>` que ya no los alcanza — perdidos para siempre, sin que nada lo avise.
   * Por eso, si el corte cae en medio de un empate, la tanda se estira para
   * llevarse el grupo completo en vez de partirlo.
   */
  listarParaPublicar(input: {
    desde: number;
    limite: number;
    precioLista: 1 | 2 | 3;
  }): { articulos: ArticuloParaCatalogo[]; cursorFinal: number } {
    try {
      const col =
        input.precioLista === 3
          ? articles.listPrice3
          : input.precioLista === 2
            ? articles.listPrice2
            : articles.listPrice1;

      const seleccion = {
        codigo: articles.barcode,
        nombre: articles.description,
        precio: col,
        vatRate: articles.vatRate,
        stock: articles.stock,
        activo: articles.active,
        unidad: articles.unit,
        updatedAt: articles.updatedAt,
      };
      // AUDITORÍA sep-2026 (B2): en modo 'net' las listas guardan precios SIN
      // IVA. La tienda muestra precios finales al consumidor, así que se
      // publica precio × (1 + IVA); en modo 'gross' la lista ya es final.
      const empresa = this.db.select({ priceMode: companies.priceMode }).from(companies).limit(1).get();
      const modoNeto = empresa?.priceMode === 'net';
      // Un código en blanco no sirve de clave hacia el catálogo — colisionaría
      // con cualquier otro artículo también en blanco. `barcode` es NOT NULL
      // en el esquema, pero datos migrados por fuera del alta normal pueden
      // dejarlo en '' — eso sí hay que filtrarlo.
      const condicion = and(gt(articles.updatedAt, input.desde), sql`trim(${articles.barcode}) != ''`);

      const rows = this.db.select(seleccion).from(articles).where(condicion).orderBy(articles.updatedAt).limit(input.limite).all();

      if (rows.length === input.limite) {
        const ultimo = rows[rows.length - 1]!.updatedAt;
        const empatados = this.db
          .select(seleccion)
          .from(articles)
          .where(and(condicion, eq(articles.updatedAt, ultimo)))
          .all();
        const yaTraidos = new Set(rows.map((r) => r.codigo));
        for (const e of empatados) if (!yaTraidos.has(e.codigo)) rows.push(e);
      }

      // Lo que se publica es lo que se puede vender por web AHORA: el stock
      // físico menos lo que ya compraron pedidos web que todavía no se
      // convirtieron en venta. La tienda descontó esas unidades en su checkout;
      // si acá se mandara el físico, la publicación siguiente se las devolvería
      // y el mismo rollo se vendería dos veces. Convertido el pedido, la venta
      // baja el físico y el pedido deja de restar: no se cuenta dos veces.
      const reservado = this.reservadoPorPedidosPendientes();
      const articulos = rows.map((r) => {
        const fisico = Number(r.stock ?? 0);
        const res = reservado.get(r.codigo) ?? 0;
        return {
          codigo: r.codigo,
          nombre: r.nombre,
          precio: modoNeto
            ? redondearExacto(String(Number(r.precio ?? '0') * (1 + Number(r.vatRate ?? '21') / 100)), 2)
            : redondearExacto(r.precio ?? '0', 2),
          stock: redondearExacto(String(Math.max(0, fisico - res)), 3),
          activo: Boolean(r.activo),
          unidad: r.unidad ?? 'UN',
        };
      });

      // El cursor avanza hasta el último publicado, no hasta "ahora": si algo
      // cambió mientras se armaba la tanda, entra en la vuelta siguiente.
      const cursorFinal = rows.length > 0 ? Math.max(...rows.map((r) => r.updatedAt ?? input.desde)) : input.desde;
      return { articulos, cursorFinal };
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Unidades por código reservadas por pedidos web PENDIENTES (bajados y
   * todavía no convertidos ni rechazados). Las líneas viven en el JSON del
   * pedido; `json_each` las abre sin traer todo a memoria.
   */
  reservadoPorPedidosPendientes(): Map<string, number> {
    try {
      const rows = this.db.all(sql`
        SELECT json_extract(i.value, '$.codigo_sistema') AS codigo,
               SUM(CAST(json_extract(i.value, '$.cant') AS REAL)) AS cant
        FROM ${catalogoPedidos} p, json_each(p.items) i
        WHERE p.estado = 'pendiente'
          AND json_type(i.value) = 'object'
          AND json_extract(i.value, '$.codigo_sistema') IS NOT NULL
          AND json_extract(i.value, '$.codigo_sistema') != ''
        GROUP BY 1
      `) as { codigo: string; cant: number }[];
      return new Map(rows.map((r) => [String(r.codigo), Number(r.cant) || 0]));
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Cuántos artículos quedan pendientes de publicar. Para mostrar avance. */
  pendientes(desde: number): number {
    try {
      const row = this.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(articles)
        .where(and(gt(articles.updatedAt, desde), sql`trim(${articles.barcode}) != ''`))
        .get();
      return Number(row?.n ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Pedidos del catálogo                                                */
/* ------------------------------------------------------------------ */

/** Una línea del pedido, tal como llega del catálogo. */
export interface LineaPedidoWeb {
  sku: string;
  codigo_sistema: string;
  nombre: string;
  cant: number;
  precio: number;
  subtotal: number;
  servicio: boolean;
}

export interface PedidoWebEntrante {
  pedidoId: string;
  numero: number;
  fecha: number;
  clienteNombre: string;
  clienteTelefono?: string | null;
  clienteEmail?: string | null;
  entrega: 'retiro' | 'envio';
  direccion?: string | null;
  notas?: string | null;
  total: string;
  /** Ya cobrado en el catálogo (Mercado Pago). Ver columna `pagado`. */
  pagado: boolean;
  items: LineaPedidoWeb[];
}

export class CatalogoPedidoRepository {
  constructor(private readonly db: LocalDatabase) {}

  /**
   * Guarda un pedido bajado del catálogo. Si ya estaba, NO hace nada y
   * devuelve false.
   *
   * Antes hacía un SELECT y solo insertaba si no encontraba nada — dos viajes
   * a la base, y si el pedido aparecía justo entre el SELECT y el INSERT (dos
   * bajadas casi simultáneas), el índice único frenaba el segundo INSERT con
   * una excepción en vez del `false` prolijo que el resto del código espera.
   * `onConflictDoNothing` hace las dos cosas en una sola vuelta: si la fila ya
   * existe, no inserta nada y no revienta.
   */
  guardar(p: PedidoWebEntrante): boolean {
    try {
      const now = Date.now();
      const resultado = this.db
        .insert(catalogoPedidos)
        .values({
          id: uuidv7(),
          pedidoId: p.pedidoId,
          numero: p.numero,
          fecha: p.fecha,
          clienteNombre: p.clienteNombre,
          clienteTelefono: p.clienteTelefono ?? null,
          clienteEmail: p.clienteEmail ?? null,
          entrega: p.entrega,
          direccion: p.direccion ?? null,
          notas: p.notas ?? null,
          total: p.total,
          pagado: p.pagado,
          items: JSON.stringify(p.items),
          estado: 'pendiente',
          saleId: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: catalogoPedidos.pedidoId })
        .run();
      return resultado.changes > 0;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  listar(estado?: 'pendiente' | 'convertido' | 'rechazado'): CatalogoPedido[] {
    try {
      const q = this.db.select().from(catalogoPedidos).$dynamic();
      const filtrado = estado ? q.where(eq(catalogoPedidos.estado, estado)) : q;
      return filtrado.orderBy(desc(catalogoPedidos.fecha)).all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  contarPendientes(): number {
    try {
      const r = this.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(catalogoPedidos)
        .where(eq(catalogoPedidos.estado, 'pendiente'))
        .get();
      return Number(r?.n ?? 0);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Resuelve un pedido PENDIENTE. Compare-and-set: sólo cambia de estado si
   * todavía está pendiente y devuelve si lo logró. Dos terminales que
   * convierten el mismo pedido a la vez ya no lo pisan: la segunda recibe
   * `false` y no genera otra venta ni otro aviso (auditoría sep-2026, B1).
   */
  marcar(
    id: string,
    estado: 'convertido' | 'rechazado',
    saleId?: string | null,
    desde: 'pendiente' | 'convertido' = 'pendiente',
  ): boolean {
    try {
      const r = this.db
        .update(catalogoPedidos)
        .set({
          estado,
          saleId: saleId ?? null,
          // El catálogo tiene que enterarse; hasta que acuse, queda debiendo.
          avisoPendiente: estado === 'convertido' ? 'confirmado' : 'cancelado',
          updatedAt: Date.now(),
        })
        .where(and(eq(catalogoPedidos.id, id), eq(catalogoPedidos.estado, desde)))
        .run();
      return r.changes > 0;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** El catálogo acusó el aviso: ya no se debe nada. */
  avisoHecho(id: string): void {
    try {
      this.db.update(catalogoPedidos).set({ avisoPendiente: null }).where(eq(catalogoPedidos.id, id)).run();
    } catch (err) {
      rethrowDbError(err);
    }
  }

  /** Pedidos resueltos cuyo aviso al catálogo todavía no fue acusado. */
  conAvisoPendiente(): CatalogoPedido[] {
    try {
      return this.db
        .select()
        .from(catalogoPedidos)
        .where(sql`${catalogoPedidos.avisoPendiente} IS NOT NULL`)
        .orderBy(catalogoPedidos.updatedAt)
        .limit(50)
        .all();
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  buscar(id: string): CatalogoPedido | null {
    try {
      return this.db.select().from(catalogoPedidos).where(eq(catalogoPedidos.id, id)).get() ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Pedidos que se convirtieron en venta y cuya venta después se ANULÓ, y
   * que todavía figuran como convertidos. Son los que hay que cancelar en el
   * catálogo: la anulación repone el stock acá, pero del otro lado el pedido
   * seguiría "confirmado" y su stock descontado.
   */
  convertidosConVentaAnulada(): CatalogoPedido[] {
    try {
      return this.db
        .select({ pedido: catalogoPedidos })
        .from(catalogoPedidos)
        .innerJoin(sales, eq(sales.id, catalogoPedidos.saleId))
        .where(and(eq(catalogoPedidos.estado, 'convertido'), eq(sales.status, 'voided')))
        .all()
        .map((r) => r.pedido);
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Estados de las ventas de un lote de pedidos, para que la pantalla pueda
   *  decir "venta anulada" sin una consulta por fila. */
  estadoDeVentas(saleIds: string[]): Map<string, string> {
    if (saleIds.length === 0) return new Map();
    try {
      const rows = this.db
        .select({ id: sales.id, status: sales.status })
        .from(sales)
        .where(sql`${sales.id} in (${sql.join(saleIds.map((id) => sql`${id}`), sql`, `)})`)
        .all();
      return new Map(rows.map((r) => [r.id, r.status]));
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
