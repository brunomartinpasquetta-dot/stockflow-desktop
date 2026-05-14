import fs from 'node:fs';
import path from 'node:path';

import { BusinessRuleError, requirePermission } from '@stockflow/core';
import type { NewArticle } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { ArticleDTO } from '../types';

const ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

function imagesDir(userDataDir: string): string {
  return path.join(userDataDir, 'article-images');
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

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
        // Best-effort: borrar imagen asociada si existe.
        try {
          const existing = await ctx.repos.articles.findById(payload.id);
          if (existing?.imagePath) {
            const abs = path.isAbsolute(existing.imagePath)
              ? existing.imagePath
              : path.join(deps.userDataDir, existing.imagePath);
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          }
        } catch {
          /* ignore */
        }
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

    // -------------------------------------------------------- imagen
    'articles:uploadImage': withSession(
      deps,
      async (
        payload: { articleId: string; sourcePath: string },
        ctx,
      ): Promise<{ imagePath: string }> => {
        requirePermission(ctx.currentUser, 'manage_articles');
        const { articleId, sourcePath } = payload;
        const article = await ctx.repos.articles.findById(articleId);
        if (!article) {
          throw new BusinessRuleError('article_not_found', 'El artículo no existe');
        }
        const ext = path.extname(sourcePath).toLowerCase();
        if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext as (typeof ALLOWED_IMAGE_EXTENSIONS)[number])) {
          throw new BusinessRuleError(
            'invalid_image_extension',
            `Formato no soportado: ${ext}. Solo JPG/PNG/WEBP.`,
          );
        }
        if (!fs.existsSync(sourcePath)) {
          throw new BusinessRuleError('image_not_found', 'El archivo de imagen no existe');
        }
        const stat = fs.statSync(sourcePath);
        if (stat.size > MAX_IMAGE_BYTES) {
          throw new BusinessRuleError(
            'image_too_large',
            `La imagen excede 2MB (${(stat.size / 1024 / 1024).toFixed(2)}MB)`,
          );
        }
        const dir = imagesDir(deps.userDataDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // Si ya había una imagen previa con otra extensión, borrarla.
        if (article.imagePath) {
          const prevAbs = path.isAbsolute(article.imagePath)
            ? article.imagePath
            : path.join(deps.userDataDir, article.imagePath);
          if (fs.existsSync(prevAbs) && prevAbs !== path.join(dir, `${articleId}${ext}`)) {
            try { fs.unlinkSync(prevAbs); } catch { /* ignore */ }
          }
        }
        const destFilename = `${articleId}${ext}`;
        const destAbs = path.join(dir, destFilename);
        fs.copyFileSync(sourcePath, destAbs);
        // Guardar ruta relativa al userDataDir (estable entre máquinas/backups).
        const relPath = path.join('article-images', destFilename);
        await ctx.repos.articles.update(articleId, { imagePath: relPath });
        return { imagePath: relPath };
      },
    ),
    'articles:removeImage': withSession(
      deps,
      async (payload: { articleId: string }, ctx): Promise<{ ok: true }> => {
        requirePermission(ctx.currentUser, 'manage_articles');
        const article = await ctx.repos.articles.findById(payload.articleId);
        if (!article) {
          throw new BusinessRuleError('article_not_found', 'El artículo no existe');
        }
        if (article.imagePath) {
          const abs = path.isAbsolute(article.imagePath)
            ? article.imagePath
            : path.join(deps.userDataDir, article.imagePath);
          try {
            if (fs.existsSync(abs)) fs.unlinkSync(abs);
          } catch {
            /* ignore */
          }
        }
        await ctx.repos.articles.update(payload.articleId, { imagePath: null });
        return { ok: true };
      },
    ),
    'articles:getImageDataUrl': withSession(
      deps,
      async (
        payload: { articleId: string },
        ctx,
      ): Promise<{ dataUrl: string | null }> => {
        requirePermission(ctx.currentUser, 'view_articles');
        const article = await ctx.repos.articles.findById(payload.articleId);
        if (!article || !article.imagePath) return { dataUrl: null };
        const abs = path.isAbsolute(article.imagePath)
          ? article.imagePath
          : path.join(deps.userDataDir, article.imagePath);
        if (!fs.existsSync(abs)) return { dataUrl: null };
        const buf = fs.readFileSync(abs);
        const ext = path.extname(abs);
        const mime = mimeFromExt(ext);
        return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
      },
    ),
  };
}
