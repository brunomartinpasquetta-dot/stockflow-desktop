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
 * Contrato que debe cumplir cualquier catálogo: docs/CATALOGO_WEB_API.md
 */
import type { PedidoWebEntrante, Repositories } from '@stockflow/db';

const TIMEOUT_MS = 15_000;
const TANDA = 500;
/** Lo máximo que el catálogo atiende en un solo pedido (contrato §3.3). */
const MAX_POR_PEDIDO = 500;
/** Tamaño de cada envío de la carga total: chico, para no rozar el timeout. */
const LOTE_CARGA = 200;

/**
 * Nombre comparable: sin acentos, Ñ como N, sin espacios ni signos, en
 * mayúsculas. "Piña 1 kg" y "PINA 1KG" dan lo mismo. (El normalizador viejo
 * tiraba las letras acentuadas enteras: "PIÑA" quedaba "PIA".)
 *
 * `=`, `#` y `+` NO se tiran: en librería son la diferencia entre dos
 * productos ("CUAD. 16X21 X46H. = AVON" es rayado y "# AVON" cuadriculado).
 * Tirarlos vinculaba el rayado con el producto cuadriculado del catálogo.
 */
export function nombreComparable(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9=#+]/g, '');
}

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
        // AUDITORÍA sep-2026 (B5): `crear_faltantes` es configurable y sólo
        // vale para los ACTIVOS. Un artículo dado de baja que el catálogo no
        // conoce no tiene por qué nacer allá (oculto o no): se publica aparte
        // con crear_faltantes=false, así el catálogo sólo lo toca si ya lo
        // tenía (y lo desactiva).
        const crearFaltantes = this.opts.crearFaltantes ?? estado.crearFaltantes ?? true;
        const activos = articulos.filter((a) => a.activo);
        const inactivos = articulos.filter((a) => !a.activo);
        // Los activos que el catálogo no tiene nacen VISIBLES y en la categoría
        // de su familia ("Varios" si no tiene), igual que en la carga total:
        // el catálogo tiene que ser el reflejo de lo que el comercio tiene en
        // el sistema, sin que nadie los vaya a mostrar a mano. Un catálogo que
        // no conozca `visible`/`categoria` los ignora y los crea ocultos.
        const activosACrear = activos.map((a) => ({ ...a, visible: true, categoria: a.familia ?? 'Varios' }));
        const tandas: { articulos: typeof articulos; crear: boolean }[] = [];
        if (crearFaltantes) {
          if (activos.length > 0) tandas.push({ articulos: activosACrear, crear: true });
          if (inactivos.length > 0) tandas.push({ articulos: inactivos, crear: false });
        } else {
          tandas.push({ articulos, crear: false });
        }
        for (const t of tandas) {
          // La tanda puede pasar de TANDA: `listarParaPublicar` la estira para
          // no partir un grupo de artículos con el mismo `updatedAt` (una base
          // migrada los tiene TODOS iguales). El catálogo atiende hasta 500 por
          // pedido y lo que sobraba lo descartaba en silencio, con el cursor ya
          // avanzado: esos artículos no se publicaban nunca. Se parte acá.
          for (let i = 0; i < t.articulos.length; i += MAX_POR_PEDIDO) {
            const res = await this.fetch(`${url}/api/stockflow/articulos`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
              body: JSON.stringify({ articulos: t.articulos.slice(i, i + MAX_POR_PEDIDO), crear_faltantes: t.crear }),
              signal: controller.signal,
            });
            if (!res.ok) {
              const motivo = `el catálogo respondió ${res.status}`;
              repos.catalogo.saveState({ lastError: motivo });
              return { ok: false, publicados: 0, pendientes: repos.catalogo.pendientes(desde), motivo };
            }
          }
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
      let invalidos = 0;
      for (const crudo of lista) {
        // AUDITORÍA sep-2026 (B3): un pedido malformado (fecha inválida, total
        // no numérico, items que no son objetos) reventaba el bucle entero y
        // los pedidos sanos que venían detrás no se bajaban nunca. Cada pedido
        // se valida y se guarda por separado; el que no sirve se anota y se
        // sigue con el siguiente.
        let pedidoId = '';
        try {
          const p = (crudo && typeof crudo === 'object' ? crudo : {}) as Record<string, unknown>;
          pedidoId = String(p.id ?? '');
          if (!pedidoId) continue;
          const fecha = p.created ? new Date(String(p.created)).getTime() : Date.now();
          const total = Number(p.total ?? 0);
          const numero = Number(p.numero ?? 0);
          const items = (Array.isArray(p.items) ? p.items : []).filter(
            (i): i is PedidoWebEntrante['items'][number] => i != null && typeof i === 'object',
          );
          if (!Number.isFinite(total) || !Number.isFinite(numero)) {
            throw new Error(`total o número no numérico (${String(p.total)} / ${String(p.numero)})`);
          }
          const entrante: PedidoWebEntrante = {
            pedidoId,
            numero,
            fecha: Number.isFinite(fecha) ? fecha : Date.now(),
            clienteNombre: String(p.cliente_nombre ?? 'Sin nombre'),
            clienteTelefono: p.cliente_telefono ? String(p.cliente_telefono) : null,
            clienteEmail: p.cliente_email ? String(p.cliente_email) : null,
            entrega: p.entrega === 'envio' ? 'envio' : 'retiro',
            direccion: p.direccion ? String(p.direccion) : null,
            notas: p.notas ? String(p.notas) : null,
            total: total.toFixed(4),
            // Ausente o cualquier valor que no sea `true`: se trata como no
            // pagado. Sin esa cautela, un catálogo viejo (sin este campo) haría
            // que TODO se registre solo, sin que nadie confirme el cobro.
            pagado: p.pagado === true,
            items,
          };
          if (repos.catalogoPedidos.guardar(entrante)) {
            nuevos += 1;
            // El stock publicable de esos artículos acaba de bajar (reserva):
            // se marcan para que la próxima publicación los mande, si no la
            // tienda seguía ofreciendo unidades ya vendidas hasta que algo
            // más los tocara.
            repos.catalogo.tocarArticulos(items.map((i) => String(i.codigo_sistema ?? '')).filter(Boolean));
          }
        } catch (e) {
          invalidos += 1;
          console.warn(`[catalogo] pedido ${pedidoId || '(sin id)'} descartado: ${e instanceof Error ? e.message : String(e)}`);
          // Sin acuse: el catálogo lo vuelve a mandar y, si lo corrigen allá,
          // entra en la vuelta siguiente.
          continue;
        }

        // Acuse: que no vuelva a venir. Un fallo acá no pierde el pedido —ya
        // está guardado— y el reintento lo descarta por duplicado.
        try {
          await this.fetch(`${url}/api/stockflow/pedidos/${pedidoId}/estado`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ estado: 'tomado' }),
            signal: AbortSignal.timeout(8_000),
          });
        } catch {
          /* se reintenta solo en la vuelta siguiente */
        }
      }
      return { ok: true, nuevos, ...(invalidos > 0 ? { motivo: `${invalidos} pedido(s) inválido(s) descartado(s)` } : {}) };
    } catch (err) {
      return { ok: false, nuevos: 0, motivo: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Avisa al catálogo en qué quedó un pedido recién resuelto y, si acusa,
   * deja de deberse. Si no acusa, el pedido queda con `avisoPendiente` y el
   * barrido `reintentarAvisosPendientes()` insiste en la vuelta siguiente.
   */
  async avisarResolucion(pedido: { id: string; pedidoId: string; saleId: string | null }, estado: 'confirmado' | 'cancelado'): Promise<boolean> {
    const ventaSistema = await this.ventaSistemaDe(pedido.saleId);
    const ok = await this.avisarEstado(pedido.pedidoId, estado, ventaSistema);
    if (ok) this.opts.repos.catalogoPedidos.avisoHecho(pedido.id);
    return ok;
  }

  /** Rótulo "X-123" de la venta enlazada, para que el catálogo lo muestre. */
  private async ventaSistemaDe(saleId: string | null): Promise<string | undefined> {
    if (!saleId) return undefined;
    const venta = await this.opts.repos.sales.findById(saleId);
    return venta ? `${venta.type}-${venta.number}` : undefined;
  }

  /**
   * Reintenta los avisos que el catálogo no acusó (estaba caído, se cortó la
   * red, expiró el tiempo). Corre en cada vuelta del temporizador y al abrir
   * la pantalla de pedidos (auditoría sep-2026, B4).
   */
  async reintentarAvisosPendientes(): Promise<{ entregados: number; pendientes: number }> {
    if (this.reintentando) return this.reintentando;
    this.reintentando = this.reintentarAvisosPendientesSinCandado().finally(() => {
      this.reintentando = null;
    });
    return this.reintentando;
  }

  private reintentando: Promise<{ entregados: number; pendientes: number }> | null = null;

  private async reintentarAvisosPendientesSinCandado(): Promise<{ entregados: number; pendientes: number }> {
    const { repos } = this.opts;
    let entregados = 0;
    let pendientes = 0;
    for (const p of repos.catalogoPedidos.conAvisoPendiente()) {
      if (!p.avisoPendiente) continue;
      if (await this.avisarResolucion(p, p.avisoPendiente)) entregados += 1;
      else pendientes += 1;
    }
    return { entregados, pendientes };
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const empresa = await this.opts.repos.company.getOrCreate();
      const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
      const token = (empresa.catalogoToken ?? '').trim();
      // Sin catálogo configurado no hay a quién avisar: se da por hecho.
      if (!url || !token) return true;
      const res = await this.fetch(`${url}/api/stockflow/pedidos/${pedidoId}/estado`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ estado, venta_sistema: ventaSistema }),
        signal: controller.signal,
      });
      // 404: el catálogo no conoce ese pedido (se borró allá, o era de prueba).
      // No hay nada que cancelar y no tiene sentido insistir.
      return res.ok || res.status === 404;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
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
   *
   * El pedido se marca recién cuando el catálogo ACUSÓ el aviso: si se marcara
   * antes y el catálogo estaba caído, el barrido siguiente ya no lo vería y
   * el pedido quedaría "confirmado" allá para siempre. Mientras tanto la
   * pantalla igual dice "venta anulada", porque eso lo lee de la venta.
   */
  async cancelarPedidosDeVentasAnuladas(): Promise<{ cancelados: number; sinAviso: number }> {
    // Un barrido a la vez: el temporizador, cada terminal con Pedidos web
    // abierta y cada anulación lo disparan, y dos a la vez mandaban el mismo
    // 'cancelado' dos veces (doble reposición en la tienda).
    if (this.barriendo) return this.barriendo;
    this.barriendo = this.cancelarPedidosDeVentasAnuladasSinCandado().finally(() => {
      this.barriendo = null;
    });
    return this.barriendo;
  }

  private barriendo: Promise<{ cancelados: number; sinAviso: number }> | null = null;

  private async cancelarPedidosDeVentasAnuladasSinCandado(): Promise<{ cancelados: number; sinAviso: number }> {
    const { repos } = this.opts;
    let cancelados = 0;
    let sinAviso = 0;
    for (const p of repos.catalogoPedidos.convertidosConVentaAnulada()) {
      if (await this.avisarEstado(p.pedidoId, 'cancelado')) {
        if (repos.catalogoPedidos.marcar(p.id, 'rechazado', p.saleId, 'convertido')) {
          repos.catalogoPedidos.avisoHecho(p.id);
        }
        cancelados += 1;
      } else {
        sinAviso += 1;
      }
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

    const normalizar = nombreComparable;
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

  /** Todos los productos del catálogo (para armar la carga total). */
  productosDelCatalogo(): Promise<ProductoCatalogo[]> {
    return this.listarProductosDelCatalogo();
  }

  /**
   * Publica una lista puntual de artículos (endpoint 3.3), de a LOTE_CARGA.
   * `crear` = que el catálogo cree los que no tiene; en ese caso cada artículo
   * lleva la categoría (su familia) y `visible: true`, para que nazca a la
   * vista y ordenado en vez de oculto en "Sin clasificar". Un catálogo que no
   * conozca esos dos campos los ignora y los crea como siempre.
   */
  async publicarCodigos(
    articulos: { codigo: string; nombre: string; precio: number; stock: number; activo: boolean; unidad: string }[],
    crear: boolean,
    familiaPorCodigo: Map<string, string | null>,
  ): Promise<{ actualizados: number; creados: number; errores: { codigo: string; motivo: string }[] }> {
    const out = { actualizados: 0, creados: 0, errores: [] as { codigo: string; motivo: string }[] };
    if (articulos.length === 0) return out;
    const empresa = await this.opts.repos.company.getOrCreate();
    const url = (empresa.catalogoUrl ?? '').trim().replace(/\/$/, '');
    const token = (empresa.catalogoToken ?? '').trim();
    if (!url || !token) {
      out.errores.push({ codigo: '-', motivo: 'falta la dirección o la clave del catálogo' });
      return out;
    }
    for (let i = 0; i < articulos.length; i += LOTE_CARGA) {
      const lote = articulos.slice(i, i + LOTE_CARGA).map((a) =>
        crear ? { ...a, categoria: familiaPorCodigo.get(a.codigo) ?? null, visible: true } : a,
      );
      try {
        const res = await this.fetch(`${url}/api/stockflow/articulos`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ articulos: lote, crear_faltantes: crear }),
          signal: AbortSignal.timeout(TIMEOUT_MS * 2),
        });
        const data = (await res.json().catch(() => null)) as
          | { actualizados?: number; creados?: number; errores?: { codigo: string; motivo: string }[] }
          | null;
        if (!res.ok) {
          for (const a of lote) out.errores.push({ codigo: a.codigo, motivo: `el catálogo respondió ${res.status}` });
          continue;
        }
        out.actualizados += data?.actualizados ?? 0;
        out.creados += data?.creados ?? 0;
        out.errores.push(...(data?.errores ?? []));
      } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err);
        for (const a of lote) out.errores.push({ codigo: a.codigo, motivo });
      }
    }
    return out;
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
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

/**
 * CARGA TOTAL: que TODO lo que el comercio tiene en el local esté en su
 * catálogo, vinculado y sin duplicados.
 *
 * El enemigo es el duplicado. Si un artículo ya existe en el catálogo sin
 * vincular (con su foto y su nombre cuidado) y se lo crea de nuevo, el cliente
 * ve dos veces lo mismo. Por eso, antes de crear nada, cada artículo se busca
 * en el catálogo en este orden, y el primero que encuentra gana:
 *
 *   1. Ya vinculado: algún producto tiene su código en `codigo_sistema`.
 *   2. Por código: un producto SIN vincular cuyo SKU es el código de barras.
 *   3. Por nombre: un producto SIN vincular con el mismo nombre, ignorando
 *      mayúsculas, acentos, espacios y signos — y solo si hay UNO de cada lado.
 *
 * Lo que no aparece de ninguna manera se crea. Lo dudoso (dos candidatos, dos
 * artículos con el mismo nombre) no se vincula ni se crea: queda en
 * `conflictos` para resolverlo a mano, porque adivinar ahí es exactamente como
 * nace un duplicado o un producto con el precio de otro.
 *
 * `plan` es solo lectura. `aplicar` escribe.
 */
export interface PlanCargaTotal {
  totalArticulos: number;
  totalCatalogo: number;
  yaVinculados: number;
  vincular: { sku: string; codigo: string; nombreCatalogo: string; nombreSistema: string; criterio: 'codigo' | 'nombre' }[];
  crear: { codigo: string; nombre: string; familia: string | null }[];
  conflictos: { codigo: string; nombre: string; motivo: string }[];
}

export interface ResultadoCargaTotal {
  ok: boolean;
  vinculados: number;
  creados: number;
  publicados: number;
  errores: { codigo: string; motivo: string }[];
  motivo?: string;
}

export async function planCargaTotal(sync: CatalogoSync, repos: Repositories): Promise<PlanCargaTotal> {
  const productos = await sync.productosDelCatalogo();
  const articulos = (await repos.articles.findAll({ active: true })).filter((a) => a.barcode.trim() !== '');
  const familias = new Map((await repos.families.findAll()).map((f) => [f.id, f.name] as const));

  const porCodigo = new Map<string, ProductoCatalogo>();
  const libresPorSku = new Map<string, ProductoCatalogo>();
  const libresPorNombre = new Map<string, ProductoCatalogo[]>();
  for (const p of productos) {
    const cod = (p.codigo_sistema ?? '').trim();
    if (cod) {
      porCodigo.set(cod, p);
      continue;
    }
    if (p.sku) libresPorSku.set(p.sku.trim(), p);
    const k = nombreComparable(p.nombre ?? '');
    if (k) libresPorNombre.set(k, [...(libresPorNombre.get(k) ?? []), p]);
  }
  // Nombres repetidos DENTRO del sistema: si dos artículos se llaman igual, un
  // producto del catálogo con ese nombre no se le puede asignar a ninguno.
  const nombresSistema = new Map<string, number>();
  for (const a of articulos) {
    const k = nombreComparable(a.description);
    nombresSistema.set(k, (nombresSistema.get(k) ?? 0) + 1);
  }

  const plan: PlanCargaTotal = {
    totalArticulos: articulos.length,
    totalCatalogo: productos.length,
    yaVinculados: 0,
    vincular: [],
    crear: [],
    conflictos: [],
  };
  const tomados = new Set<string>();
  const pendientes: typeof articulos = [];

  // Primera pasada: lo seguro (ya vinculado, o SKU = código de barras).
  for (const a of articulos) {
    const cod = a.barcode.trim();
    if (porCodigo.has(cod)) {
      plan.yaVinculados += 1;
      continue;
    }
    const p = libresPorSku.get(cod);
    if (p && !tomados.has(p.id)) {
      tomados.add(p.id);
      plan.vincular.push({ sku: p.sku, codigo: cod, nombreCatalogo: p.nombre, nombreSistema: a.description, criterio: 'codigo' });
      continue;
    }
    pendientes.push(a);
  }

  // Segunda pasada: por nombre, sólo lo inequívoco.
  for (const a of pendientes) {
    const cod = a.barcode.trim();
    const k = nombreComparable(a.description);
    const candidatos = (libresPorNombre.get(k) ?? []).filter((p) => !tomados.has(p.id));
    if (k && candidatos.length > 1) {
      plan.conflictos.push({ codigo: cod, nombre: a.description, motivo: `hay ${candidatos.length} productos con ese nombre en el catálogo` });
      continue;
    }
    if (k && candidatos.length === 1) {
      if ((nombresSistema.get(k) ?? 0) > 1) {
        plan.conflictos.push({ codigo: cod, nombre: a.description, motivo: 'hay otro artículo con el mismo nombre en el sistema' });
        continue;
      }
      const p = candidatos[0]!;
      tomados.add(p.id);
      plan.vincular.push({ sku: p.sku, codigo: cod, nombreCatalogo: p.nombre, nombreSistema: a.description, criterio: 'nombre' });
      continue;
    }
    // Sin familia en el sistema → "Varios", una categoría VISIBLE. Mandarlo sin
    // categoría lo hacía caer en "Sin clasificar", que está oculta: el
    // artículo quedaba creado pero nadie lo veía en la tienda.
    plan.crear.push({ codigo: cod, nombre: a.description, familia: (a.familyId ? familias.get(a.familyId) : null) ?? 'Varios' });
  }
  return plan;
}

/**
 * Aplica un plan (ya revisado por el usuario): vincula, crea lo que falta
 * VISIBLE y en la categoría de su familia, y publica en el momento precio y
 * stock de todo lo tocado. De a LOTE_CARGA por pedido. Un lote que falla no
 * frena los demás: el resultado dice cuáles no entraron.
 */
export async function aplicarCargaTotal(
  sync: CatalogoSync,
  repos: Repositories,
  input: { vincular: { sku: string; codigo: string }[]; crear: { codigo: string; familia: string | null }[] },
  precioLista: 1 | 2 | 3 = 1,
): Promise<ResultadoCargaTotal> {
  const r: ResultadoCargaTotal = { ok: true, vinculados: 0, creados: 0, publicados: 0, errores: [] };

  // 1) Vincular lo que ya existía.
  for (let i = 0; i < input.vincular.length; i += LOTE_CARGA) {
    const lote = input.vincular.slice(i, i + LOTE_CARGA);
    const v = await sync.vincularLote(lote.map((x) => ({ sku: x.sku, codigoSistema: x.codigo })));
    r.vinculados += v.vinculados;
    const codPorSku = new Map(lote.map((x) => [x.sku, x.codigo] as const));
    for (const e of v.errores) r.errores.push({ codigo: codPorSku.get(e.sku) ?? e.sku, motivo: e.motivo });
    if (!v.ok) r.errores.push({ codigo: `lote ${i / LOTE_CARGA + 1}`, motivo: v.motivo ?? 'no se pudo vincular' });
  }

  // 2) Publicar precio y stock de lo recién vinculado (sin crear nada).
  const vinculadosCod = input.vincular.map((x) => x.codigo);
  const pubVinc = await sync.publicarCodigos(repos.catalogo.paraPublicarPorCodigo(vinculadosCod, precioLista), false, new Map());
  r.publicados += pubVinc.actualizados;
  r.errores.push(...pubVinc.errores);

  // 3) Crear lo que falta, visible y en la categoría de su familia.
  const familiaPorCod = new Map(input.crear.map((x) => [x.codigo, x.familia] as const));
  const pubCrear = await sync.publicarCodigos(
    repos.catalogo.paraPublicarPorCodigo(input.crear.map((x) => x.codigo), precioLista),
    true,
    familiaPorCod,
  );
  r.creados += pubCrear.creados;
  r.publicados += pubCrear.actualizados;
  r.errores.push(...pubCrear.errores);

  r.ok = r.errores.length === 0;
  if (!r.ok) r.motivo = `${r.errores.length} artículo(s) no se pudieron cargar`;
  return r;
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
