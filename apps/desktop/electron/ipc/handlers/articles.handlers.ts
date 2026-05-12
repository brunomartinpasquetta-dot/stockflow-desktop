import { requirePermission } from '@stockflow/core';
import type { NewArticle } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { ArticleDTO } from '../types';

export function buildArticlesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'articles:list': withSession(deps, (_payload, ctx): Promise<ArticleDTO[]> => {
      requirePermission(ctx.currentUser, 'view_articles');
      return ctx.repos.articles.findAll();
    }),
    'articles:get': withSession(deps, (payload: { id: string }, ctx): Promise<ArticleDTO | null> => {
      requirePermission(ctx.currentUser, 'view_articles');
      return ctx.repos.articles.findById(payload.id);
    }),
    'articles:create': withSession(deps, (payload: NewArticle, ctx): Promise<ArticleDTO> => {
      requirePermission(ctx.currentUser, 'manage_articles');
      return ctx.repos.articles.create(payload);
    }),
    'articles:update': withSession(
      deps,
      (payload: { id: string; data: Partial<NewArticle> }, ctx): Promise<ArticleDTO> => {
        requirePermission(ctx.currentUser, 'manage_articles');
        return ctx.repos.articles.update(payload.id, payload.data);
      },
    ),
    'articles:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_articles');
        await ctx.repos.articles.delete(payload.id);
        return { deleted: true };
      },
    ),
    'articles:findByBarcode': withSession(
      deps,
      (payload: { barcode: string }, ctx): Promise<ArticleDTO | null> => {
        requirePermission(ctx.currentUser, 'view_articles');
        return ctx.repos.articles.findByBarcode(payload.barcode);
      },
    ),
    'articles:searchByText': withSession(
      deps,
      (payload: { query: string }, ctx): Promise<ArticleDTO[]> => {
        requirePermission(ctx.currentUser, 'view_articles');
        return ctx.repos.articles.searchByText(payload.query);
      },
    ),
    'articles:findLowStock': withSession(deps, (_payload, ctx): Promise<ArticleDTO[]> => {
      requirePermission(ctx.currentUser, 'view_articles');
      return ctx.repos.articles.findLowStock();
    }),
  };
}
