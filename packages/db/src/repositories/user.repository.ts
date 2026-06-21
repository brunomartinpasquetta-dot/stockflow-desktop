import { and, eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import {
  CreateUserSchema,
  UpdateUserSchema,
  type CreateUserInput,
  type UpdateUserInput,
} from '@stockflow/shared';

import { NotFoundError, ValidationError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { users, type NewUser, type User } from '../schema/local';
import { BaseRepository } from './base.repository';

const BCRYPT_COST = 10;

/** Mensaje único para el bloqueo de último administrador. */
const LAST_ADMIN_MSG = 'No se puede dejar el sistema sin un administrador activo';

/** Usuario sin el hash de contraseña (para devolver hacia afuera). */
export type SafeUser = Omit<User, 'passwordHash'>;

function stripPassword(user: User): SafeUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

export class UserRepository extends BaseRepository<User, NewUser> {
  constructor(db: LocalDatabase) {
    super(db, users, 'Usuario');
  }

  /** Crea un usuario validando con Zod y hasheando la contraseña en texto plano. */
  override async create(data: unknown): Promise<User> {
    try {
      const { password, ...rest } = this.parseOrThrow<CreateUserInput>(CreateUserSchema, data);
      return this.insertRow({
        ...rest,
        passwordHash: bcrypt.hashSync(password, BCRYPT_COST),
      });
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Cuenta los administradores ACTIVOS (`role='admin' AND active=1`). */
  async countActiveAdmins(): Promise<number> {
    try {
      const row = this.db
        .select({ value: sql<number>`count(*)` })
        .from(users)
        .where(and(eq(users.role, 'admin'), eq(users.active, true)))
        .get();
      return row?.value ?? 0;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Bloquea operaciones que dejarían el sistema sin un admin activo.
   * Sólo importa cuando el usuario afectado es HOY un admin activo y es el último.
   */
  private async assertNotLastActiveAdmin(id: string): Promise<void> {
    const current = await this.findById(id);
    if (!current || current.role !== 'admin' || !current.active) return;
    if ((await this.countActiveAdmins()) <= 1) {
      throw new ValidationError('role', LAST_ADMIN_MSG);
    }
  }

  /** Actualiza un usuario; si viene `password`, lo re-hashea. */
  override async update(id: string, data: unknown): Promise<User> {
    try {
      const { password, ...rest } = this.parseOrThrow<UpdateUserInput>(UpdateUserSchema, data);
      const payload: Partial<NewUser> = { ...rest };
      if (password !== undefined) {
        payload.passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
      }
      // Si la operación desactiva al admin o le saca el rol admin, no debe quedar
      // el sistema sin un administrador activo.
      const losesAdmin = payload.active === false || (payload.role !== undefined && payload.role !== 'admin');
      if (losesAdmin) {
        await this.assertNotLastActiveAdmin(id);
      }
      const rows = this.db.update(users).set(payload).where(eq(users.id, id)).returning().all();
      const row = rows[0];
      if (!row) throw new NotFoundError(this.entityName, id);
      return row;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /** Elimina un usuario; impide borrar al último administrador activo. */
  override async delete(id: string): Promise<void> {
    try {
      await this.assertNotLastActiveAdmin(id);
    } catch (err) {
      return rethrowDbError(err);
    }
    return super.delete(id);
  }

  async findByUsername(username: string): Promise<User | null> {
    try {
      const row = this.db.select().from(users).where(eq(users.username, username)).get();
      return row ?? null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }

  /**
   * Verifica usuario + contraseña. Devuelve el usuario (sin hash) si las credenciales
   * son válidas y la cuenta está activa; `null` en cualquier otro caso.
   */
  async verifyPassword(username: string, password: string): Promise<SafeUser | null> {
    try {
      const user = await this.findByUsername(username);
      if (!user || !user.active) return null;
      return bcrypt.compareSync(password, user.passwordHash) ? stripPassword(user) : null;
    } catch (err) {
      return rethrowDbError(err);
    }
  }
}
