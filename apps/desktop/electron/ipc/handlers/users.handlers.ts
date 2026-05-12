import { requirePermission } from '@stockflow/core';
import type { User } from '@stockflow/db';

import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { UserDTO } from '../types';

/** Proyecta un usuario de la base a su DTO público (sin passwordHash). */
function toPublicUser(u: User): UserDTO {
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export function buildUsersHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'users:list': withSession(deps, async (_payload, ctx): Promise<UserDTO[]> => {
      requirePermission(ctx.currentUser, 'manage_users');
      return (await ctx.repos.users.findAll()).map(toPublicUser);
    }),
    'users:get': withSession(deps, async (payload: { id: string }, ctx): Promise<UserDTO | null> => {
      requirePermission(ctx.currentUser, 'manage_users');
      const u = await ctx.repos.users.findById(payload.id);
      return u ? toPublicUser(u) : null;
    }),
    'users:create': withSession(
      deps,
      async (payload: Record<string, unknown>, ctx): Promise<UserDTO> => {
        requirePermission(ctx.currentUser, 'manage_users');
        return toPublicUser(await ctx.repos.users.create(payload));
      },
    ),
    'users:update': withSession(
      deps,
      async (payload: { id: string; data: Record<string, unknown> }, ctx): Promise<UserDTO> => {
        requirePermission(ctx.currentUser, 'manage_users');
        return toPublicUser(await ctx.repos.users.update(payload.id, payload.data));
      },
    ),
    'users:delete': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ deleted: true }> => {
        requirePermission(ctx.currentUser, 'manage_users');
        await ctx.repos.users.delete(payload.id);
        return { deleted: true };
      },
    ),
  };
}
