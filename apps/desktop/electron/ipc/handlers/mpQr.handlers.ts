/**
 * Handlers IPC del módulo MercadoPago QR.
 */
import { MpQrService } from '@stockflow/core';
import type { MpOrder, MpPosDevice } from '@stockflow/shared';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  MpConfigStatusDTO,
  MpCreateOrderInputDTO,
  MpOrderDTO,
  MpPosDeviceDTO,
  MpSetupInputDTO,
  MpTestConnectionDTO,
} from '../types';

function svc(deps: HandlerDeps, ctx: import('@stockflow/core').ServiceContext): MpQrService {
  // Mantenemos un tokenStore opcional para no romper si main.ts no lo inyecta todavía.
  const tokenStore = deps.mpTokenStore ?? {
    encrypt: (s: string) => `plain:${s}`,
    decrypt: (s: string) => (s.startsWith('plain:') ? s.slice('plain:'.length) : s),
  };
  return new MpQrService(ctx, tokenStore);
}

function toDevice(d: MpPosDevice): MpPosDeviceDTO {
  return {
    id: d.id,
    cashRegisterId: d.cashRegisterId,
    externalPosId: d.externalPosId,
    mpPosId: d.mpPosId,
    qrUrl: d.qrUrl,
    qrImageBase64: d.qrImageBase64 ?? null,
    active: d.active === 1,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toOrder(o: MpOrder): MpOrderDTO {
  return {
    id: o.id,
    mpPosDeviceId: o.mpPosDeviceId,
    saleId: o.saleId ?? null,
    externalReference: o.externalReference,
    amount: o.amount,
    description: o.description,
    status: o.status as MpOrderDTO['status'],
    mpPaymentId: o.mpPaymentId ?? null,
    mpMerchantOrderId: o.mpMerchantOrderId ?? null,
    expiresAt: o.expiresAt,
    paidAt: o.paidAt ?? null,
    createdAt: o.createdAt,
    createdBy: o.createdBy,
  };
}

export function buildMpQrHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'mpQr:getConfig': withSession(deps, async (_p, ctx): Promise<MpConfigStatusDTO> => {
      return svc(deps, ctx).getConfig();
    }),
    'mpQr:setupCompany': withSession(
      deps,
      async (payload: MpSetupInputDTO, ctx): Promise<{ configured: true; storeId: string }> => {
        return svc(deps, ctx).setupCompany(payload);
      },
    ),
    'mpQr:testConnection': withSession(deps, async (_p, ctx): Promise<MpTestConnectionDTO> => {
      return svc(deps, ctx).testConnection();
    }),
    'mpQr:listPosDevices': withSession(deps, async (_p, ctx): Promise<MpPosDeviceDTO[]> => {
      const list = await svc(deps, ctx).listPosDevices();
      return list.map(toDevice);
    }),
    'mpQr:createPosDevice': withSession(
      deps,
      async (payload: { cashRegisterId: string }, ctx): Promise<MpPosDeviceDTO> => {
        const d = await svc(deps, ctx).createPosDevice(payload);
        return toDevice(d);
      },
    ),
    'mpQr:getQrForCashRegister': withSession(
      deps,
      async (payload: { cashRegisterId: string }, ctx): Promise<{ qrUrl: string; qrImageBase64: string | null } | null> => {
        return svc(deps, ctx).getQrForCashRegister(payload.cashRegisterId);
      },
    ),
    'mpQr:createOrder': withSession(
      deps,
      async (payload: MpCreateOrderInputDTO, ctx): Promise<MpOrderDTO> => {
        const o = await svc(deps, ctx).createOrder(payload);
        return toOrder(o);
      },
    ),
    'mpQr:cancelOrder': withSession(
      deps,
      async (payload: { orderId: string }, ctx): Promise<MpOrderDTO> => {
        const o = await svc(deps, ctx).cancelOrder(payload.orderId);
        return toOrder(o);
      },
    ),
    'mpQr:verifyPayment': withSession(
      deps,
      async (payload: { orderId: string }, ctx): Promise<MpOrderDTO> => {
        const o = await svc(deps, ctx).verifyPayment(payload.orderId);
        return toOrder(o);
      },
    ),
    'mpQr:getActiveOrder': withSession(
      deps,
      async (payload: { cashRegisterId: string }, ctx): Promise<MpOrderDTO | null> => {
        const o = await svc(deps, ctx).getActiveOrder(payload.cashRegisterId);
        return o ? toOrder(o) : null;
      },
    ),
    'mpQr:listOrders': withSession(
      deps,
      async (payload: { from: number; to: number }, ctx): Promise<MpOrderDTO[]> => {
        const list = await svc(deps, ctx).listOrders(payload);
        return list.map(toOrder);
      },
    ),
    'mpQr:linkOrderToSale': withSession(
      deps,
      async (payload: { orderId: string; saleId: string }, ctx): Promise<{ ok: true }> => {
        await svc(deps, ctx).linkOrderToSale(payload.orderId, payload.saleId);
        return { ok: true };
      },
    ),
  };
}
