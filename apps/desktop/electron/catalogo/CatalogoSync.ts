/**
 * ESPEJO DEL CATÁLOGO WEB — el que empuja.
 *
 * StockFlow publica en el catálogo online el código, el nombre, el precio y el
 * stock de los artículos. Toda la comunicación la inicia ESTE lado: la PC del
 * comercio no tiene IP fija, vive detrás del router de un local y se apaga a la
 * noche, así que nadie puede llamarla. El catálogo solo responde.
 *
 * Tres reglas que sostienen el diseño:
 *
 *  1. Se publica ESTADO, no eventos: "este artículo tiene 7", nunca "salieron 3".
 *     Por eso mandar de más es inofensivo, y una PC apagada una semana se pone
 *     al día con una sola corrida en vez de reproducir un historial.
 *  2. Corre en UN SOLO lugar: la máquina que tiene la base. En una terminal LAN
 *     los datos son remotos y dos empujadores se pisarían.
 *  3. Nunca frena la venta: si el catálogo no responde, se anota el error y se
 *     reintenta en el tick siguiente. El cursor no avanza.
 *
 * Contrato del otro lado: ~/CATALOGOCITZIA/docs/INTEGRACION-STOCKFLOW.md
 */
import type { PedidoWebEntrante, Repositories } from '@stockflow/db';

const TIMEOUT_MS = 15_000;
const TANDA = 500;

export interface CatalogoSyncOptions {
  repos: Repositories;
  /** Qué lista de precios se publica. Por defecto la 1. */
  precioLista?: 1 | 2 | 3;
  /**
   * Si el catálogo debe CREAR los artículos que no tiene (inactivos, sin
   * clasificar) o ignorarlos. Prendido, el comerciante carga el artículo una
   * sola vez —en el sistema— y después lo termina de vestir en el panel.
   * Apagado, el catálogo solo se actualiza con lo que ya curó.
   */
  crearFaltantes?: boolean;
  /** Para poder probarlo sin red. */
  fetchImpl?: typeof fetch;
}

export interface ResultadoSync {
  ok: boolean;
  publicados: number;
  pendientes: number;
  motivo?: string;
}

export class CatalogoSync {
  private corriendo = false;

  constructor(private readonly opts: CatalogoSyncOptions) {}

  private get fetch(): typeof fetch {
    return this.opts.fetchImpl ?? fetch;
  }

  /**
   * Empuja una tanda. Devuelve cuántos publicó y cuántos quedan, para que la
   * pantalla pueda mostrar avance sin adivinar.
   *
   * Es reentrante-seguro: si ya hay una corrida en curso, esta se saltea. Sin
   * esto, el disparo por `data:changed` y el del reloj se solaparían y podrían
   * publicar la misma tanda dos veces con el cursor a medio avanzar.
   */
  async correr(forzarDesdeCero = false): Promise<ResultadoSync> {
    if (this.corriendo) return { ok: true, publicados: 0, pendientes: 0, motivo: 'ya estaba corriendo' };
    this.corriendo = true;
    const { repos } = this.opts;
    try {
      const estado = repos.catalogo.getState();
      if (!estado.enabled) return { ok: true, publicados: 0, pendientes: 0, motivo: 'desactivado' };

      const empresa = await repos.company.getOrCreate();
      const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
      const token = (empresa.catalogoToken ?? '').trim();
      if (!url || !token) {
        return { ok: false, publicados: 0, pendientes: 0, motivo: 'falta la dirección o la clave del catálogo' };
      }

      const desde = forzarDesdeCero ? 0 : estado.cursor;
      const { articulos, cursorFinal } = repos.catalogo.listarParaPublicar({
        desde,
        limite: TANDA,
        precioLista: this.opts.precioLista ?? 1,
      });

      repos.catalogo.saveState({ lastRunAt: Date.now() });
      if (articulos.length === 0) {
        repos.catalogo.saveState({ lastOkAt: Date.now(), lastError: null });
        return { ok: true, publicados: 0, pendientes: 0 };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await this.fetch(`${url}/api/stockflow/articulos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ articulos, crear_faltantes: this.opts.crearFaltantes ?? true }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const motivo = `el catálogo respondió ${res.status}`;
          repos.catalogo.saveState({ lastError: motivo });
          return { ok: false, publicados: 0, pendientes: repos.catalogo.pendientes(desde), motivo };
        }
        // El cursor avanza SOLO con respuesta buena. Si esto falla a mitad de
        // camino, la tanda entera se vuelve a mandar: como se publica estado y
        // no eventos, repetirla no tiene consecuencias.
        repos.catalogo.saveState({
          cursor: cursorFinal,
          lastOkAt: Date.now(),
          lastError: null,
          pushedTotal: estado.pushedTotal + articulos.length,
        });
        // Si la tanda vino más corta que el límite, la consulta ya recorrió
        // todo lo que había — no queda nada pendiente y no hace falta un
        // segundo escaneo idéntico solo para confirmarlo.
        const pendientes = articulos.length < TANDA ? 0 : repos.catalogo.pendientes(cursorFinal);
        return { ok: true, publicados: articulos.length, pendientes };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      try {
        this.opts.repos.catalogo.saveState({ lastError: motivo });
      } catch {
        /* si ni el estado se puede guardar, no hay nada que hacer acá */
      }
      return { ok: false, publicados: 0, pendientes: 0, motivo };
    } finally {
      this.corriendo = false;
    }
  }

  /**
   * Baja los pedidos nuevos del catálogo y avisa que se tomaron.
   *
   * Va SIEMPRE ANTES del empujón. Al revés, el empujón le devolvería al catálogo
   * las unidades que el checkout acababa de descontar, y el artículo volvería a
   * aparecer disponible hasta la vuelta siguiente.
   *
   * El acuse ("tomado") se manda DESPUÉS de guardar. Si se corta justo en el
   * medio, el pedido se vuelve a bajar y el índice único sobre `pedido_id` lo
   * descarta: se prefiere bajarlo dos veces y descartarlo, a perderlo.
   */
  async traerPedidos(): Promise<{ ok: boolean; nuevos: number; motivo?: string }> {
    const { repos } = this.opts;
    const estado = repos.catalogo.getState();
    if (!estado.enabled) return { ok: true, nuevos: 0, motivo: 'desactivado' };

    const empresa = await repos.company.getOrCreate();
    const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
    const token = (empresa.catalogoToken ?? '').trim();
    if (!url || !token) return { ok: false, nuevos: 0, motivo: 'falta la dirección o la clave' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetch(`${url}/api/stockflow/pedidos`, {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, nuevos: 0, motivo: `el catálogo respondió ${res.status}` };
      const data = (await res.json()) as { pedidos?: unknown[] };
      const lista = Array.isArray(data.pedidos) ? data.pedidos : [];

      let nuevos = 0;
      for (const crudo of lista) {
        const p = crudo as Record<string, unknown>;
        const pedidoId = String(p.id ?? '');
        if (!pedidoId) continue;
        const entrante: PedidoWebEntrante = {
          pedidoId,
          numero: Number(p.numero ?? 0),
          fecha: p.created ? new Date(String(p.created)).getTime() : Date.now(),
          clienteNombre: String(p.cliente_nombre ?? 'Sin nombre'),
          clienteTelefono: p.cliente_telefono ? String(p.cliente_telefono) : null,
          clienteEmail: p.cliente_email ? String(p.cliente_email) : null,
          entrega: p.entrega === 'envio' ? 'envio' : 'retiro',
          direccion: p.direccion ? String(p.direccion) : null,
          notas: p.notas ? String(p.notas) : null,
          total: Number(p.total ?? 0).toFixed(4),
          // Ausente o cualquier valor que no sea `true`: se trata como no
          // pagado. Sin esa cautela, un catálogo viejo (sin este campo) haría
          // que TODO se registre solo, sin que nadie confirme el cobro.
          pagado: p.pagado === true,
          items: Array.isArray(p.items) ? (p.items as PedidoWebEntrante['items']) : [],
        };
        if (repos.catalogoPedidos.guardar(entrante)) nuevos += 1;

        // Acuse: que no vuelva a venir. Un fallo acá no pierde el pedido —ya
        // está guardado— y el reintento lo descarta por duplicado.
        try {
          await this.fetch(`${url}/api/stockflow/pedidos/${pedidoId}/estado`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ estado: 'tomado' }),
          });
        } catch {
          /* se reintenta solo en la vuelta siguiente */
        }
      }
      return { ok: true, nuevos };
    } catch (err) {
      return { ok: false, nuevos: 0, motivo: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Le dice al catálogo en qué quedó un pedido (3.5 del contrato). No depende
   * de que el espejo esté activo: el estado de un pedido se informa siempre.
   * Best-effort: si falla, el pedido ya está resuelto de este lado y del otro
   * se corrige desde el panel.
   */
  async avisarEstado(
    pedidoId: string,
    estado: 'confirmado' | 'cancelado',
    ventaSistema?: string,
  ): Promise<boolean> {
    try {
      const empresa = await this.opts.repos.company.getOrCreate();
      const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
      const token = (empresa.catalogoToken ?? '').trim();
      if (!url || !token) return false;
      const res = await this.fetch(`${url}/api/stockflow/pedidos/${pedidoId}/estado`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ estado, venta_sistema: ventaSistema }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Anular la venta cancela el pedido. StockFlow repone su stock al anular y
   * el espejo lo publica después; pero el catálogo tiene su propio stock
   * descontado en el checkout y el pedido "confirmado" — sin este aviso, el
   * artículo seguiría agotado allá y el pedido figuraría entregado. Acá se
   * marca el pedido como rechazado (conserva la venta para el historial) y se
   * manda "cancelado", que del otro lado repone lo descontado. Es un barrido,
   * no un gancho por venta: cubre cualquier camino de anulación (una, "las
   * de hoy", una terminal LAN) y reintenta lo que haya quedado sin avisar.
   */
  async cancelarPedidosDeVentasAnuladas(): Promise<{ cancelados: number; sinAviso: number }> {
    const { repos } = this.opts;
    let cancelados = 0;
    let sinAviso = 0;
    for (const p of repos.catalogoPedidos.convertidosConVentaAnulada()) {
      repos.catalogoPedidos.marcar(p.id, 'rechazado', p.saleId);
      cancelados += 1;
      if (!(await this.avisarEstado(p.pedidoId, 'cancelado'))) sinAviso += 1;
    }
    return { cancelados, sinAviso };
  }

  /** Vacía el espejo y vuelve a publicar todo desde cero. */
  async republicarTodo(): Promise<ResultadoSync> {
    this.opts.repos.catalogo.saveState({ cursor: 0 });
    return this.correr(true);
  }

  /**
   * Trae TODOS los productos del catálogo (paginado, endpoint 3.1 del
   * contrato). Es la única llamada "de lectura completa": se usa solo para
   * armar la pantalla de vinculación, no en el ciclo automático.
   */
  private async listarProductosDelCatalogo(): Promise<ProductoCatalogo[]> {
    const { repos } = this.opts;
    const empresa = await repos.company.getOrCreate();
    const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
    const token = (empresa.catalogoToken ?? '').trim();
    if (!url || !token) throw new Error('falta la dirección o la clave del catálogo');

    const out: ProductoCatalogo[] = [];
    let pagina = 1;
    // Tope de seguridad: 50 páginas de 500 = 25.000 productos. Un catálogo
    // real no llega ahí; esto es para no colgar la pantalla ante una
    // respuesta que nunca reporte 'total' correctamente.
    for (let i = 0; i < 50; i++) {
      const res = await this.fetch(`${url}/api/stockflow/productos?pagina=${pagina}&por_pagina=500`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error(`el catálogo respondió ${res.status}`);
      const data = (await res.json()) as { productos?: ProductoCatalogo[]; total?: number };
      const lote = Array.isArray(data.productos) ? data.productos : [];
      out.push(...lote);
      if (lote.length === 0 || out.length >= (data.total ?? out.length)) break;
      pagina += 1;
    }
    return out;
  }

  /**
   * Propuesta de vinculación: los productos del catálogo que TODAVÍA no
   * tienen `codigo_sistema`, cruzados por NOMBRE contra los artículos activos
   * del sistema. Solo se sugiere cuando el nombre coincide con UN ÚNICO
   * artículo — si coincide con más de uno, es ambiguo y se deja para elegir
   * a mano.
   */
  async sugerirVinculacion(): Promise<SugerenciaVinculacion> {
    const productos = await this.listarProductosDelCatalogo();
    const sinVincular = productos.filter((p) => !p.codigo_sistema);
    const articulos = await this.opts.repos.articles.findAll({ active: true });

    const normalizar = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const porNombre = new Map<string, typeof articulos>();
    for (const a of articulos) {
      const k = normalizar(a.description);
      const arr = porNombre.get(k) ?? [];
      arr.push(a);
      porNombre.set(k, arr);
    }

    const sugeridos: SugerenciaItem[] = [];
    const sinCandidato: { sku: string; nombre: string }[] = [];
    for (const p of sinVincular) {
      const candidatos = porNombre.get(normalizar(p.nombre)) ?? [];
      if (candidatos.length === 1) {
        const a = candidatos[0]!;
        sugeridos.push({
          sku: p.sku,
          nombreCatalogo: p.nombre,
          codigo: a.barcode,
          nombreSistema: a.description,
        });
      } else {
        sinCandidato.push({ sku: p.sku, nombre: p.nombre });
      }
    }
    return {
      totalCatalogo: productos.length,
      totalSinVincular: sinVincular.length,
      sugeridos,
      sinCandidato,
    };
  }

  /** Confirma una tanda de vinculaciones (endpoint 3.2 del contrato). */
  async vincularLote(
    vinculos: { sku: string; codigoSistema: string }[],
  ): Promise<{ ok: boolean; vinculados: number; errores: { sku: string; motivo: string }[]; motivo?: string }> {
    const { repos } = this.opts;
    const empresa = await repos.company.getOrCreate();
    const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
    const token = (empresa.catalogoToken ?? '').trim();
    if (!url || !token) return { ok: false, vinculados: 0, errores: [], motivo: 'falta la dirección o la clave del catálogo' };

    try {
      const res = await this.fetch(`${url}/api/stockflow/vincular`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          vinculos: vinculos.map((v) => ({ sku: v.sku, codigo_sistema: v.codigoSistema })),
        }),
      });
      // Un 409 en este endpoint es un CONFLICTO documentado (el código ya está
      // en otro producto), no un error de transporte: el catálogo devuelve un
      // cuerpo con detalle (`error`, `sku` del dueño actual). Se intenta leer
      // igual, y solo se cae al mensaje genérico si el cuerpo no es JSON.
      const data = (await res.json().catch(() => null)) as
        | { vinculados?: number; errores?: { sku: string; motivo: string }[]; error?: string; sku?: string }
        | null;
      if (!res.ok) {
        if (data?.error) {
          const motivo = data.sku ? `${data.error} (lo tiene "${data.sku}")` : data.error;
          return { ok: false, vinculados: 0, errores: [], motivo };
        }
        return { ok: false, vinculados: 0, errores: [], motivo: `el catálogo respondió ${res.status}` };
      }
      return { ok: true, vinculados: data?.vinculados ?? 0, errores: data?.errores ?? [] };
    } catch (err) {
      return { ok: false, vinculados: 0, errores: [], motivo: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Un producto del catálogo, tal como lo devuelve GET /api/stockflow/productos. */
export interface ProductoCatalogo {
  id: string;
  sku: string;
  nombre: string;
  codigo_sistema: string;
  precio: number;
  activo: boolean;
  categoria?: string;
}

export interface SugerenciaItem {
  sku: string;
  nombreCatalogo: string;
  /** Código de barras del artículo del sistema propuesto. */
  codigo: string;
  nombreSistema: string;
}

export interface SugerenciaVinculacion {
  totalCatalogo: number;
  totalSinVincular: number;
  sugeridos: SugerenciaItem[];
  sinCandidato: { sku: string; nombre: string }[];
}

let instancia: { repos: Repositories; sync: CatalogoSync } | null = null;

/**
 * Devuelve SIEMPRE la misma instancia mientras `repos` no cambie.
 *
 * `corriendo` (el candado contra corridas superpuestas) es un campo de
 * instancia: si cada llamador hace `new CatalogoSync(...)` por su cuenta —
 * el reloj de 60s por un lado, cada botón de la pantalla por otro—, cada uno
 * arranca con `corriendo = false` y el candado no protege nada. Con esto, el
 * reloj y los tres canales IPC comparten el mismo objeto y el mismo candado.
 */
export function obtenerCatalogoSync(repos: Repositories): CatalogoSync {
  if (!instancia || instancia.repos !== repos) {
    instancia = { repos, sync: new CatalogoSync({ repos }) };
  }
  return instancia.sync;
}
