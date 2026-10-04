/**
 * Sucursales (multisucursal, ver docs/PLAN_MULTISUCURSAL.md).
 *
 *  - `branches:listar`: toda base tiene al menos "Casa central". Lectura con
 *    sesión, sin requisito de licencia (el código de etapas siguientes la usa).
 *  - `branches:renombrar`: sólo con la edición Multisucursal y el permiso de
 *    configuración de la empresa (`manage_company`). Desde internet se
 *    rechaza (REMOTO_DENIED_CHANNELS): se hace en el local.
 */
import { BusinessRuleError, requirePermission } from '@stockflow/core';

import { tieneMultisucursal } from '../../license/funciones';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { BranchDTO } from '../types';

export function buildBranchesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'branches:listar': withSession(deps, (_payload, ctx): BranchDTO[] => ctx.repos.branches.listar()),
    'branches:renombrar': withSession(
      deps,
      (payload: { id?: unknown; name?: unknown }, ctx): BranchDTO => {
        if (!tieneMultisucursal(deps)) {
          throw new BusinessRuleError(
            'multisucursal_requerida',
            'Las sucursales requieren la licencia Multisucursal.',
          );
        }
        requirePermission(ctx.currentUser, 'manage_company');
        return ctx.repos.branches.renombrar(String(payload?.id ?? ''), String(payload?.name ?? ''));
      },
    ),
  };
}
