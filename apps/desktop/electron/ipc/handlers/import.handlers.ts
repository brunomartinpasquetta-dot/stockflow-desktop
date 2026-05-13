/**
 * Handlers IPC para importación masiva de stock (Excel).
 */
import { requirePermission } from '@stockflow/core';

import type {
  ImportExecuteResult,
  ImportMapping,
  ImportOptions,
  ImportValidationResult,
} from '../../import/ExcelImportService';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';

export function buildImportHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'import:parse-file': withSession(
      deps,
      async (payload: { filePath: string }, ctx): Promise<{
        sheets: string[];
        preview: Array<Record<string, unknown>>;
        headers: string[];
        totalRows: number;
      }> => {
        requirePermission(ctx.currentUser, 'import_data');
        return deps.importService.parseFile(payload.filePath);
      },
    ),
    'import:validate': withSession(
      deps,
      async (
        payload: { filePath: string; mapping: ImportMapping },
        ctx,
      ): Promise<ImportValidationResult> => {
        requirePermission(ctx.currentUser, 'import_data');
        return deps.importService.validate(payload.filePath, payload.mapping, ctx.repos);
      },
    ),
    'import:execute': withSession(
      deps,
      async (
        payload: { filePath: string; mapping: ImportMapping; options: ImportOptions },
        ctx,
      ): Promise<ImportExecuteResult> => {
        requirePermission(ctx.currentUser, 'import_data');
        return deps.importService.execute(
          payload.filePath,
          payload.mapping,
          payload.options,
          ctx.repos,
          (done, total) => deps.emit('import:progress', { done, total }),
        );
      },
    ),
  };
}
