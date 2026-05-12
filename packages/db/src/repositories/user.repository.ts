import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import {
  CreateUserSchema,
  UpdateUserSchema,
  type CreateUserInput,
  type UpdateUserInput,
} from '@stockflow/shared';

import { NotFoundError, rethrowDbError } from '../errors';
import type { LocalDatabase } from '../local/client';
import { users, type NewUser, type User } from '../schema/local';
import { BaseRepository } from './base.repository';

const BCRYPT_COST = 10;

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

  /** Actualiza un usuario; si viene `password`, lo re-hashea. */
  override async update(id: string, data: unknown): Promise<User> {
    try {
      const { password, ...rest } = this.parseOrThrow<UpdateUserInput>(UpdateUserSchema, data);
      const payload: Partial<NewUser> = { ...rest };
      if (password !== undefined) {
        payload.passwordHash = bcrypt.hashSync(password, BCRYPT_COST);
      }
      const rows = this.db.update(users).set(payload).where(eq(users.id, id)).returning().all();
      const row = rows[0];
      if (!row) throw new NotFoundError(this.entityName, id);
      return row;
    } catch (err) {
      return rethrowDbError(err);
    }
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
