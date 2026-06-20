/**
 * Handlers IPC del grupo `roles`: configuración de permisos por rol/área.
 *
 *  - roles:getConfig → áreas disponibles + áreas habilitadas por rol (manager/seller).
 *  - roles:setConfig → persiste la config de un rol y refresca el motor en caliente.
 *
 * Ambos canales requieren `manage_users`. `admin` NO es configurable (siempre
 * tiene acceso total).
 */
import {
  PERMISSION_AREAS,
  ValidationError,
  applyAreaConfig,
  requirePermission,
} from '@stockflow/core';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { RolesConfigDTO, RolesSetConfigPayload } from '../types';

type ConfigurableRole = 'manager' | 'seller';

function isConfigurableRole(role: string): role is ConfigurableRole {
  return role === 'manager' || role === 'seller';
}

export function buildRolesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'roles:getConfig': withSession(deps, async (_payload, ctx): Promise<RolesConfigDTO> => {
      requirePermission(ctx.currentUser, 'manage_users');

      const rows = await ctx.repos.rolePermissions.getAll();
      const enabledByRole: Record<ConfigurableRole, string[]> = { manager: [], seller: [] };
      for (const row of rows) {
        if (!row.allowed) continue;
        if (isConfigurableRole(row.role)) enabledByRole[row.role].push(row.area);
      }

      return {
        areas: PERMISSION_AREAS.map((a) => ({ key: a.key, label: a.label })),
        roles: {
          manager: enabledByRole.manager,
          seller: enabledByRole.seller,
        },
      };
    }),

    'roles:setConfig': withSession(
      deps,
      async (payload: RolesSetConfigPayload, ctx): Promise<RolesConfigDTO> => {
        requirePermission(ctx.currentUser, 'manage_users');

        if (!payload || !isConfigurableRole(payload.role)) {
          throw new ValidationError('role', 'Sólo se pueden configurar los roles manager y seller');
        }
        const validKeys = new Set(PERMISSION_AREAS.map((a) => a.key));
        const areas = (payload.areas ?? []).filter((k) => validKeys.has(k));

        // 1) Persistir.
        await ctx.repos.rolePermissions.setForRole(payload.role, areas);

        // 2) Refrescar el motor de permisos en caliente con la config completa.
        const rows = await ctx.repos.rolePermissions.getAll();
        applyAreaConfig(rows);

        // 3) Devolver la config resultante (igual shape que getConfig).
        const enabledByRole: Record<ConfigurableRole, string[]> = { manager: [], seller: [] };
        for (const row of rows) {
          if (!row.allowed) continue;
          if (isConfigurableRole(row.role)) enabledByRole[row.role].push(row.area);
        }
        return {
          areas: PERMISSION_AREAS.map((a) => ({ key: a.key, label: a.label })),
          roles: {
            manager: enabledByRole.manager,
            seller: enabledByRole.seller,
          },
        };
      },
    ),
  };
}
