import { QuotesService } from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  ConvertQuoteToSaleInputDTO,
  CreateQuoteInputDTO,
  QuoteConvertPreviewDTO,
  QuoteDTO,
  QuoteWithLinesDTO,
  SaleDTO,
} from '../types';

export function buildQuotesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'quotes:create': withSession(
      deps,
      (payload: CreateQuoteInputDTO, ctx): Promise<QuoteWithLinesDTO> =>
        new QuotesService(ctx).createQuote(payload),
    ),
    'quotes:get': withSession(
      deps,
      (payload: { id: string }, ctx): Promise<QuoteWithLinesDTO> =>
        new QuotesService(ctx).getQuote(payload.id),
    ),
    'quotes:listByDateRange': withSession(
      deps,
      (payload: { from: number; to: number }, ctx): Promise<QuoteDTO[]> =>
        new QuotesService(ctx).listQuotes(payload.from, payload.to),
    ),
    'quotes:delete': withSession(deps, async (payload: { id: string }, ctx): Promise<{ ok: true }> => {
      await new QuotesService(ctx).deleteQuote(payload.id);
      return { ok: true };
    }),
    'quotes:previewConvert': withSession(
      deps,
      (payload: { quoteId: string; refreshPrices: boolean }, ctx): Promise<QuoteConvertPreviewDTO> =>
        new QuotesService(ctx).previewConvert(payload.quoteId, payload.refreshPrices),
    ),
    'quotes:convertToSale': withSession(
      deps,
      (payload: ConvertQuoteToSaleInputDTO, ctx): Promise<{ sale: SaleDTO; quoteId: string }> =>
        new QuotesService(ctx).convertToSale(payload),
    ),
  };
}
