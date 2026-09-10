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
        return { ok: true, publicados: articulos.length, pendientes: repos.catalogo.pendientes(cursorFinal) };
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

  /** Vacía el espejo y vuelve a publicar todo desde cero. */
  async republicarTodo(): Promise<ResultadoSync> {
    this.opts.repos.catalogo.saveState({ cursor: 0 });
    return this.correr(true);
  }
}
