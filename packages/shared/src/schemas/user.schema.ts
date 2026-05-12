import { z } from 'zod';

import { idSchema, timestampSchema, userRoleSchema } from './common';

/** Shape completo de `users` (matches DB, incluye passwordHash). */
export const UserSchema = z.object({
  id: idSchema,
  username: z.string().min(1),
  passwordHash: z.string().min(1),
  fullName: z.string().min(1),
  role: userRoleSchema,
  active: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/** Vista pública de un usuario (sin passwordHash). */
export const PublicUserSchema = UserSchema.omit({ passwordHash: true });

const userBase = z.object({
  username: z.string().min(1),
  fullName: z.string().min(1),
  role: userRoleSchema,
  active: z.boolean().default(true),
});

/** Input para crear un usuario: recibe `password` en texto plano (min 4). */
export const CreateUserSchema = userBase.extend({
  password: z.string().min(4, 'La contraseña debe tener al menos 4 caracteres'),
});

/** Input para actualizar un usuario: `password` opcional (si viene, se re-hashea). */
export const UpdateUserSchema = userBase.partial().extend({
  password: z
    .string()
    .min(4, 'La contraseña debe tener al menos 4 caracteres')
    .optional(),
});

export type UserOutput = z.infer<typeof UserSchema>;
export type PublicUser = z.infer<typeof PublicUserSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
