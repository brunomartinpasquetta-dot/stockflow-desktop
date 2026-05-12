import { PaymentMethodService } from '@stockflow/core';
import type { NewPaymentMethod } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { PaymentMethodDTO } from '../types';

export function buildPaymentMethodsHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'paymentMethods:list': withSession(
      deps,
      (_payload, ctx): Promise<PaymentMethodDTO[]> => new PaymentMethodService(ctx).list(),
    ),
    'paymentMethods:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<PaymentMethodDTO | null> =>
        new PaymentMethodService(ctx).get(payload.id),
    ),
    'paymentMethods:create': withSession(
      deps,
      (payload: NewPaymentMethod, ctx): Promise<PaymentMethodDTO> =>
        new PaymentMethodService(ctx).create(payload),
    ),
    'paymentMethods:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewPaymentMethod> }, ctx): Promise<PaymentMethodDTO> =>
        new PaymentMethodService(ctx).update(payload.id, payload.data),
    ),
    'paymentMethods:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        await new PaymentMethodService(ctx).delete(payload.id);
        return { deleted: true };
      },
    ),
  };
}
