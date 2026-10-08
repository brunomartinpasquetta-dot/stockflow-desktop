/**
 * Servicio MercadoPago QR Atendido.
 *
 * Maneja:
 *  - Setup de la empresa (alta de Store + persistencia de access token cifrado).
 *  - Alta de POS por caja (createPos + getQr).
 *  - Creación / cancelación / verificación de órdenes (PUT/DELETE).
 *  - Procesamiento idempotente de webhooks.
 *  - Expiración batch de órdenes vencidas.
 *
 * Almacena el access token cifrado (safeStorage en Electron; passthrough en tests
 * mediante el helper `MpTokenStoreLike`).
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, gte, lte, lt } from 'drizzle-orm';
import {
  mpConfig,
  mpOrders,
  mpPosDevices,
  paymentMethods,
  type MpConfig,
  type MpOrder,
  type MpPosDevice,
} from '@stockflow/db';

import { requirePermission } from '../auth/permissions';
import type { ServiceContext } from '../context';
import { BusinessRuleError, NotFoundError } from '../errors';
import { MpApiClient } from '../lib/mpApi';

export interface MpTokenStoreLike {
  encrypt(plain: string): string;
  decrypt(encrypted: string): string;
}

export interface MpConfigStatus {
  configured: boolean;
  mpUserId?: string;
  storeId?: string | null;
  webhookSecret?: string;
}

export interface MpSetupInput {
  /** Ya no se pide: se saca del propio token. Se acepta por compatibilidad. */
  mpUserId?: string;
  accessToken: string;
}

export interface MpCreateOrderInput {
  cashRegisterId: string;
  amount: string;
  description: string;
  externalReference?: string;
}

export interface MpWebhookContext {
  mpPaymentId?: string;
}

const ORDER_TTL_MS = 5 * 60_000;

/**
 * ¿El punto de cobro acepta el importe que manda la caja?
 *
 * Mercado Pago llama «pdv» al modo atendido (la caja manda el importe y el
 * cliente sólo confirma) y «standalone» al QR sin integrar, donde el cliente
 * escribe cuánto paga. En ese segundo modo el QR se abre vacío y el pedido con
 * importe no existe para el punto, así que el comercio no puede cobrar
 * (Denver, 8-oct-2026). La API vieja llamaba a lo mismo `fixed_amount`.
 */
export function enModoAtendido(pos: unknown): boolean {
  const p = pos as { config?: { qr?: { operating_mode?: string } }; fixed_amount?: boolean };
  const modo = p?.config?.qr?.operating_mode;
  if (modo) return modo === 'pdv';
  // Cuentas viejas que no informan el modo: vale lo que diga `fixed_amount`.
  return p?.fixed_amount !== false;
}

export class MpQrService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly tokenStore: MpTokenStoreLike,
    /** Override del baseUrl de MP (sólo tests). */
    private readonly mpBaseUrl?: string,
  ) {}

  /* --------------------------- helpers ---------------------------- */

  private async getConfigRow(): Promise<MpConfig | null> {
    const row = this.ctx.db.select().from(mpConfig).limit(1).get();
    return row ?? null;
  }

  private async client(): Promise<MpApiClient> {
    const cfg = await this.getConfigRow();
    if (!cfg) throw new BusinessRuleError('mp_not_configured', 'MercadoPago no está configurado.');
    const token = this.tokenStore.decrypt(cfg.accessTokenEncrypted);
    return new MpApiClient(token, this.mpBaseUrl);
  }

  /* ---------------------------- API ------------------------------- */

  async getConfig(): Promise<MpConfigStatus> {
    const row = await this.getConfigRow();
    if (!row) return { configured: false };
    return {
      configured: true,
      mpUserId: row.mpUserId,
      storeId: row.storeId,
      webhookSecret: row.webhookSecret,
    };
  }

  async setupCompany(input: MpSetupInput): Promise<{ configured: true; storeId: string }> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    if (this.ctx.currentUser.role !== 'admin') {
      throw new BusinessRuleError('mp_setup_admin_only', 'Sólo un administrador puede configurar MercadoPago.');
    }
    // El usuario ya no se pide: se saca del token (ver abajo).
    if (!input.accessToken) {
      throw new BusinessRuleError('mp_invalid_input', 'Falta el access token de Mercado Pago.');
    }

    const client = new MpApiClient(input.accessToken, this.mpBaseUrl);
    /**
     * EL USUARIO SALE DEL TOKEN, NO DE LO QUE SE TIPEA.
     *
     * La pantalla pedía el «User ID» a mano y nadie lo verificaba. Lo que el
     * comercio tiene a mano es el Client ID de la aplicación —el mismo número
     * que arranca el access token—, y ese NO es el número de su cuenta de
     * cobro. Con el número equivocado la configuración pasa igual (crear la
     * sucursal y el punto de cobro usan sólo el token), pero al cobrar la
     * dirección del pedido lleva el usuario adentro y Mercado Pago contesta
     * que el recurso no existe: «No se pudo crear la orden» y el comercio no
     * puede cobrar (Denver, 8-oct-2026). El token sabe de quién es: se
     * pregunta y listo.
     */
    let usuarioReal: string;
    try {
      const me = await client.validateToken();
      usuarioReal = String(me.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BusinessRuleError('mp_invalid_token', `Access token inválido: ${msg}`);
    }
    input = { ...input, mpUserId: usuarioReal };

    /**
     * SE USA LA SUCURSAL QUE EL COMERCIO YA TIENE.
     *
     * Antes se creaba una sucursal «StockFlow» sin mirar. Dos problemas: al
     * comercio le aparecía una sucursal de más en su Mercado Pago, y muchas
     * cuentas no están autorizadas a crearlas por API — Mercado Pago contesta
     * "at least one policy returned unauthorized" y la configuración no pasaba
     * de ahí (Denver, 8-oct-2026: ya tenía su sucursal y su QR armados desde la
     * app). Sólo se crea una cuando la cuenta no tiene ninguna.
     */
    let storeId: string;
    let existentes: Awaited<ReturnType<typeof client.searchStores>> = [];
    try {
      existentes = await client.searchStores(input.mpUserId);
    } catch {
      /* si no se pueden listar, se intenta crear como antes */
    }
    if (existentes.length > 0) {
      storeId = String(existentes[0]!.id);
    } else {
      try {
        const store = await client.createStore(input.mpUserId, { name: 'StockFlow' });
        storeId = String(store.id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BusinessRuleError(
          'mp_store_create_failed',
          `No se pudo crear la sucursal en MercadoPago: ${msg}. ` +
            'Cree la sucursal desde la app de Mercado Pago y vuelva a intentar.',
        );
      }
    }

    const webhookSecret = randomBytes(32).toString('hex');
    const encrypted = this.tokenStore.encrypt(input.accessToken);
    const now = Date.now();

    const existing = await this.getConfigRow();
    if (existing) {
      this.ctx.db
        .update(mpConfig)
        .set({
          mpUserId: input.mpUserId,
          accessTokenEncrypted: encrypted,
          webhookSecret,
          storeId,
          updatedAt: now,
        })
        .where(eq(mpConfig.id, existing.id))
        .run();
    } else {
      this.ctx.db
        .insert(mpConfig)
        .values({
          id: randomUUID(),
          companyId: null,
          mpUserId: input.mpUserId,
          accessTokenEncrypted: encrypted,
          webhookSecret,
          storeId,
          webhookUrlConfigured: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    // Crear el payment method "MercadoPago QR" si no existe.
    const pmExisting = this.ctx.db
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.name, 'MercadoPago QR'))
      .get();
    if (!pmExisting) {
      try {
        this.ctx.db
          .insert(paymentMethods)
          .values({
            id: randomUUID(),
            name: 'MercadoPago QR',
            type: 'mp',
            isPhysicalCash: false,
            commissionPct: '0.00',
            active: true,
            sortOrder: 90,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      } catch (err) {
        console.warn('[mpQr] no se pudo crear el payment method MercadoPago QR:', err);
      }
    }

    return { configured: true, storeId };
  }

  async listPosDevices(): Promise<MpPosDevice[]> {
    return this.ctx.db.select().from(mpPosDevices).orderBy(asc(mpPosDevices.createdAt)).all();
  }

  async getQrForCashRegister(
    cashRegisterId: string,
  ): Promise<{ qrUrl: string; qrImageBase64: string | null } | null> {
    const dev = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.cashRegisterId, cashRegisterId))
      .get();
    if (!dev) return null;
    return { qrUrl: dev.qrUrl, qrImageBase64: dev.qrImageBase64 ?? null };
  }

  async getPosDeviceByCashRegister(cashRegisterId: string): Promise<MpPosDevice | null> {
    const dev = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.cashRegisterId, cashRegisterId))
      .get();
    return dev ?? null;
  }

  async createPosDevice(input: { cashRegisterId: string }): Promise<MpPosDevice> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const cfg = await this.getConfigRow();
    if (!cfg || !cfg.storeId) {
      throw new BusinessRuleError('mp_not_configured', 'Configure MercadoPago antes de asignar QR a cajas.');
    }
    const existing = await this.getPosDeviceByCashRegister(input.cashRegisterId);
    if (existing) return existing;

    /**
     * SÓLO LETRAS Y NÚMEROS: Mercado Pago rechaza la identificación con
     * guiones («external_id must be alphanumeric»). Se armaba como
     * `CAJA-xxxxxxxx-XXXX`, así que la creación del punto de cobro FALLABA
     * SIEMPRE y el comercio se quedaba sin QR (Denver, 8-oct-2026).
     */
    const externalPosId = `CAJA${input.cashRegisterId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}${Math.random()
      .toString(36)
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 4)
      .toUpperCase()}`;

    const client = await this.client();

    /**
     * SE ADOPTA EL QR QUE EL COMERCIO YA TIENE PEGADO EN EL MOSTRADOR.
     *
     * Antes se creaba siempre un punto de cobro nuevo, lo que obligaba al
     * comercio a imprimir otro cartel y, en cuentas que no están autorizadas a
     * crearlos por API, directamente fallaba. Si en la sucursal ya hay uno
     * libre —no usado por otra caja de StockFlow— se usa ese. Los QR hechos
     * desde la app de Mercado Pago vienen sin «identificación externa», que es
     * a donde se manda el importe de cada venta: se la completamos.
     */
    const yaUsados = new Set(
      this.ctx.db.select().from(mpPosDevices).all().map((d) => String(d.mpPosId)),
    );
    let pos: Awaited<ReturnType<typeof client.createPos>> | undefined;
    let externalUsado = externalPosId;
    try {
      // Sólo sirve un punto de cobro que (a) tenga identificación externa, que
      // es a donde se manda el importe de cada venta, y (b) esté en MODO
      // ATENDIDO. Adoptar uno en modo «el cliente escribe el importe» deja la
      // caja sin poder cobrar: el QR se abre vacío y el pedido con importe no
      // existe para ese punto (Denver, 8-oct-2026). Para los que no sirven se
      // crea uno propio en la misma sucursal y el comercio usa el cartel
      // nuevo.
      const libres = (await client.searchPos(cfg.storeId)).filter(
        (p) =>
          !yaUsados.has(String(p.id)) &&
          String(p.external_id ?? '').trim() !== '' &&
          enModoAtendido(p),
      );
      const candidato = libres[0];
      if (candidato) {
        pos = candidato;
        externalUsado = String(candidato.external_id);
      }
    } catch (err) {
      console.warn('[mpQr] no se pudo adoptar un punto de cobro existente:', err);
    }

    if (!pos) {
      try {
        // SIN rubro: con `category: 5411` algunas cuentas contestan
        // «pos_unknown_mcc» y no dejan crear el punto de cobro. Mercado Pago
        // toma el del comercio cuando no se manda.
        pos = await client.createPos({
          name: `StockFlow ${externalPosId}`,
          external_id: externalPosId,
          store_id: cfg.storeId,
        });
        externalUsado = externalPosId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BusinessRuleError(
          'mp_pos_create_failed',
          `No se pudo crear el punto de cobro en MercadoPago: ${msg}. ` +
            'Cree el QR desde la app de Mercado Pago y vuelva a intentar: el sistema usa el que ya exista.',
        );
      }
    }

    let qrUrl = '';
    // Un punto de cobro que ya existía suele traer su propio QR: se usa ese, que
    // es el cartel que el comercio ya tiene pegado en el mostrador.
    const qrDelPos = (pos as { qr?: { template_image?: string; image?: string } }).qr;
    if (qrDelPos) qrUrl = String(qrDelPos.template_image ?? qrDelPos.image ?? '');
    if (!qrUrl) {
      try {
        const qr = await client.getQr(cfg.mpUserId, externalUsado);
        qrUrl = String(qr.qr_template_url ?? qr.qr_template_image ?? '');
      } catch (err) {
        console.warn('[mpQr] getQr falló:', err);
      }
    }

    let qrImageBase64: string | null = null;
    if (qrUrl) {
      try {
        const res = await (globalThis.fetch as typeof fetch)(qrUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          qrImageBase64 = buf.toString('base64');
        }
      } catch (err) {
        console.warn('[mpQr] no se pudo descargar la imagen del QR:', err);
      }
    }

    const now = Date.now();
    const id = randomUUID();
    this.ctx.db
      .insert(mpPosDevices)
      .values({
        id,
        cashRegisterId: input.cashRegisterId,
        // La identificación REALMENTE usada: si se adoptó un punto de cobro que
        // ya tenía la suya, es esa; guardar otra dejaría los cobros sin destino.
        externalPosId: externalUsado,
        mpPosId: String(pos.id),
        qrUrl,
        qrImageBase64,
        active: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    return this.ctx.db.select().from(mpPosDevices).where(eq(mpPosDevices.id, id)).get()!;
  }

  /**
   * Rehace el QR de la caja creando un punto de cobro NUEVO en modo atendido.
   *
   * Para cuando la caja quedó enganchada a un punto que no acepta el importe
   * del sistema —por ejemplo uno hecho desde la app de Mercado Pago, o uno
   * adoptado antes de que el sistema mirara el modo (Denver, 8-oct-2026)—. El
   * cambio de modo sobre el punto viejo no siempre lo deja hacer Mercado Pago,
   * así que se hace uno nuevo. **El QR cambia: hay que imprimir el cartel otra
   * vez**, por eso no pasa solo y hay un botón.
   */
  async recrearPosDevice(input: { cashRegisterId: string }): Promise<MpPosDevice> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const existing = await this.getPosDeviceByCashRegister(input.cashRegisterId);
    if (existing) {
      this.ctx.db.delete(mpPosDevices).where(eq(mpPosDevices.id, existing.id)).run();
    }
    try {
      return await this.createPosDevice(input);
    } catch (err) {
      // Si no se pudo crear el nuevo, se deja la caja como estaba.
      if (existing) this.ctx.db.insert(mpPosDevices).values(existing).run();
      throw err;
    }
  }

  /**
   * Convierte el fallo al crear el cobro en algo que se pueda accionar.
   *
   * Mercado Pago contesta siempre lo mismo —«si quieres conocer los recursos
   * de la API visita el sitio de desarrolladores»— tanto si no existe el punto
   * de cobro como si la cuenta no tiene habilitado el QR dinámico. Con ese
   * texto nadie puede hacer nada (Denver, 8-oct-2026: el comercio quedó sin
   * poder cobrar y hubo que adivinar). Se le agrega qué se intentó y qué
   * puntos de cobro tiene la cuenta de verdad.
   */
  private async explicarFalloDeOrden(msg: string, device: MpPosDevice): Promise<string> {
    /**
     * UNA SOLA CONCLUSIÓN Y UN SOLO PASO A SEGUIR.
     *
     * La primera versión de este aviso listaba todo lo que había averiguado y
     * terminaba con dos frases que se contradecían. Bruno, 8-oct-2026: «es
     * medio confuso». En pantalla va qué hacer; el detalle técnico queda en el
     * registro.
     */
    try {
      const client = await this.client();
      const puntos = await client.searchPos();
      const elNuestro = puntos.find((p) => String(p.external_id ?? '') === device.externalPosId);
      console.warn('[mpQr] falló el cobro:', {
        error: msg,
        punto: device.externalPosId,
        puntosDeLaCuenta: puntos.map((p) => ({
          id: p.id,
          external_id: p.external_id,
          modo: (p as { config?: { qr?: { operating_mode?: string } } }).config?.qr?.operating_mode,
        })),
      });
      if (!elNuestro) {
        return 'La caja apunta a un QR que ya no está en la cuenta de Mercado Pago. Genere el QR de la caja otra vez en Configuración → Mercado Pago.';
      }
      if (!enModoAtendido(elNuestro)) {
        return 'El QR de esta caja está en el modo en que el cliente escribe cuánto paga, y por eso no acepta el importe del sistema. En Configuración → Mercado Pago use «Rehacer el QR de la caja»: se crea uno que sí acepta el importe. Atención: el código cambia, hay que imprimir el cartel de nuevo.';
      }
      return 'Mercado Pago rechazó el cobro aunque el QR de la caja está bien configurado. Suele ser que la cuenta todavía no tiene habilitado el cobro con QR desde un sistema: hay que pedirlo a Mercado Pago.';
    } catch (e) {
      console.warn('[mpQr] no se pudieron consultar los puntos de cobro:', e);
      return `No se pudo crear el cobro en Mercado Pago (${msg}). Revise la conexión a internet y la configuración de Mercado Pago.`;
    }
  }

  async createOrder(input: MpCreateOrderInput): Promise<MpOrder> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const cfg = await this.getConfigRow();
    if (!cfg) throw new BusinessRuleError('mp_not_configured', 'MercadoPago no está configurado.');

    const device = await this.getPosDeviceByCashRegister(input.cashRegisterId);
    if (!device) {
      throw new BusinessRuleError('mp_pos_missing', 'La caja no tiene un QR de MercadoPago asignado.');
    }

    const amountNum = Number(input.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new BusinessRuleError('mp_invalid_amount', 'El monto debe ser mayor a cero.');
    }
    const externalReference = input.externalReference ?? `ORD-${randomUUID()}`;

    const client = await this.client();
    const pedido = {
      external_reference: externalReference,
      title: 'Venta StockFlow',
      description: input.description,
      total_amount: Number(amountNum.toFixed(2)),
      items: [
        {
          title: input.description,
          unit_price: Number(amountNum.toFixed(2)),
          quantity: 1,
          unit_measure: 'unit',
          total_amount: Number(amountNum.toFixed(2)),
        },
      ],
      cash_out: { amount: 0 },
    };
    try {
      await client.putOrder(cfg.mpUserId, device.externalPosId, pedido);
    } catch (err) {
      /**
       * SEGUNDO INTENTO CON EL USUARIO QUE DICE EL TOKEN.
       *
       * Las instalaciones configuradas antes guardaron el número que el
       * comercio tipeó a mano, que suele ser el de la aplicación y no el de la
       * cuenta de cobro. Con ese número la dirección del pedido no existe y
       * Mercado Pago contesta su mensaje genérico de recurso inexistente, así
       * que el comercio no puede cobrar y no tiene forma de adivinar el número
       * correcto. Se pregunta al token de quién es, se corrige la
       * configuración y se reintenta UNA vez: el comercio no se entera.
       */
      let corregido = false;
      let usuario = cfg.mpUserId;
      try {
        const me = await client.validateToken();
        const real = String(me.id);
        if (real && real !== usuario) {
          this.ctx.db
            .update(mpConfig)
            .set({ mpUserId: real, updatedAt: Date.now() })
            .where(eq(mpConfig.id, cfg.id))
            .run();
          usuario = real;
          await client.putOrder(usuario, device.externalPosId, pedido);
          corregido = true;
        }
      } catch {
        /* el reintento no salió: se prueba lo de abajo */
      }
      /**
       * EL PUNTO DE COBRO TIENE QUE ESTAR EN MODO ATENDIDO.
       *
       * Si quedó en `standalone` —el QR sin integrar, donde el cliente
       * escribe cuánto paga— el QR se abre vacío y los pedidos con importe no
       * existen para ese punto. Se lo pasa a `pdv` y se reintenta UNA vez,
       * así la caja ya vinculada se arregla sola y el cartel impreso sigue
       * sirviendo (Denver, 8-oct-2026).
       */
      if (!corregido) {
        try {
          await client.updatePos(device.mpPosId, {
            fixed_amount: true,
            config: { qr: { operating_mode: 'pdv' } },
          });
          await client.putOrder(usuario, device.externalPosId, pedido);
          corregido = true;
        } catch {
          /* tampoco: vale el error original, explicado abajo */
        }
      }
      if (!corregido) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BusinessRuleError('mp_order_failed', await this.explicarFalloDeOrden(msg, device));
      }
    }

    const now = Date.now();
    const id = randomUUID();
    this.ctx.db
      .insert(mpOrders)
      .values({
        id,
        mpPosDeviceId: device.id,
        saleId: null,
        externalReference,
        amount: amountNum.toFixed(2),
        description: input.description,
        status: 'pending',
        mpPaymentId: null,
        mpMerchantOrderId: null,
        expiresAt: now + ORDER_TTL_MS,
        paidAt: null,
        createdAt: now,
        createdBy: this.ctx.currentUser.id,
      })
      .run();
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, id)).get()!;
  }

  async cancelOrder(orderId: string): Promise<MpOrder> {
    requirePermission(this.ctx.currentUser, 'manage_mp_qr');
    const order = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    if (!order) throw new NotFoundError('Orden MP', orderId);
    if (order.status !== 'pending') return order;

    const cfg = await this.getConfigRow();
    const device = this.ctx.db
      .select()
      .from(mpPosDevices)
      .where(eq(mpPosDevices.id, order.mpPosDeviceId))
      .get();
    if (cfg && device) {
      try {
        const client = await this.client();
        await client.deleteOrder(cfg.mpUserId, device.externalPosId);
      } catch (err) {
        console.warn('[mpQr] DELETE order en MP falló (igual marcamos cancelled local):', err);
      }
    }

    this.ctx.db
      .update(mpOrders)
      .set({ status: 'cancelled' })
      .where(eq(mpOrders.id, orderId))
      .run();
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get()!;
  }

  async verifyPayment(orderId: string): Promise<MpOrder> {
    const order = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    if (!order) throw new NotFoundError('Orden MP', orderId);
    if (order.status !== 'pending') return order;

    let result;
    try {
      const client = await this.client();
      result = await client.searchPayments(order.externalReference);
    } catch (err) {
      console.warn('[mpQr] verifyPayment search falló:', err);
      return order;
    }

    const payment = result.results?.[0];
    if (!payment) return order;

    const now = Date.now();
    if (payment.status === 'approved') {
      this.ctx.db
        .update(mpOrders)
        .set({
          status: 'approved',
          mpPaymentId: String(payment.id),
          paidAt: now,
        })
        .where(eq(mpOrders.id, orderId))
        .run();
    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: payment.status, mpPaymentId: String(payment.id) })
        .where(eq(mpOrders.id, orderId))
        .run();
    }
    return this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get()!;
  }

  async handleWebhook(
    payload: { type?: string; data?: { id?: string | number } } | Record<string, unknown>,
    _tenantContext: MpWebhookContext = {},
  ): Promise<{ processed: boolean; orderId?: string }> {
    const data = (payload as { data?: { id?: string | number } }).data;
    const mpPaymentId = data?.id != null ? String(data.id) : undefined;
    if (!mpPaymentId) return { processed: false };

    // Idempotencia: si ya tenemos una orden con este mpPaymentId, no repetir.
    const already = this.ctx.db
      .select()
      .from(mpOrders)
      .where(eq(mpOrders.mpPaymentId, mpPaymentId))
      .get();
    if (already) return { processed: false, orderId: already.id };

    let payment;
    try {
      const client = await this.client();
      payment = await client.getPayment(mpPaymentId);
    } catch (err) {
      console.warn('[mpQr] webhook getPayment falló:', err);
      return { processed: false };
    }

    if (!payment.external_reference) return { processed: false };
    const order = this.ctx.db
      .select()
      .from(mpOrders)
      .where(eq(mpOrders.externalReference, payment.external_reference))
      .get();
    if (!order) return { processed: false };

    const now = Date.now();
    if (payment.status === 'approved') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: 'approved', mpPaymentId, paidAt: now })
        .where(eq(mpOrders.id, order.id))
        .run();
    } else if (payment.status === 'rejected' || payment.status === 'cancelled') {
      this.ctx.db
        .update(mpOrders)
        .set({ status: payment.status, mpPaymentId })
        .where(eq(mpOrders.id, order.id))
        .run();
    }

    return { processed: true, orderId: order.id };
  }

  async expireStaleOrders(): Promise<{ expired: number }> {
    const now = Date.now();
    const stale = this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(eq(mpOrders.status, 'pending'), lt(mpOrders.expiresAt, now)))
      .all();
    if (stale.length === 0) return { expired: 0 };

    const cfg = await this.getConfigRow();
    for (const order of stale) {
      if (cfg) {
        const device = this.ctx.db
          .select()
          .from(mpPosDevices)
          .where(eq(mpPosDevices.id, order.mpPosDeviceId))
          .get();
        if (device) {
          try {
            const client = await this.client();
            await client.deleteOrder(cfg.mpUserId, device.externalPosId);
          } catch (err) {
            console.warn('[mpQr] expire deleteOrder falló para', order.id, err);
          }
        }
      }
      this.ctx.db.update(mpOrders).set({ status: 'expired' }).where(eq(mpOrders.id, order.id)).run();
    }
    return { expired: stale.length };
  }

  async linkOrderToSale(orderId: string, saleId: string): Promise<void> {
    this.ctx.db.update(mpOrders).set({ saleId }).where(eq(mpOrders.id, orderId)).run();
  }

  async getActiveOrder(cashRegisterId: string): Promise<MpOrder | null> {
    const device = await this.getPosDeviceByCashRegister(cashRegisterId);
    if (!device) return null;
    const row = this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(eq(mpOrders.mpPosDeviceId, device.id), eq(mpOrders.status, 'pending')))
      .orderBy(desc(mpOrders.createdAt))
      .limit(1)
      .get();
    return row ?? null;
  }

  async getOrder(orderId: string): Promise<MpOrder | null> {
    const row = this.ctx.db.select().from(mpOrders).where(eq(mpOrders.id, orderId)).get();
    return row ?? null;
  }

  async listOrders(input: { from: number; to: number }): Promise<MpOrder[]> {
    return this.ctx.db
      .select()
      .from(mpOrders)
      .where(and(gte(mpOrders.createdAt, input.from), lte(mpOrders.createdAt, input.to)))
      .orderBy(desc(mpOrders.createdAt))
      .all();
  }

  async testConnection(): Promise<{ ok: boolean; mpUserId?: string; error?: string }> {
    try {
      const client = await this.client();
      const me = await client.validateToken();
      return { ok: true, mpUserId: String(me.id) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }
}
