import { z } from 'zod';

/**
 * Tipos/contratos Zod compartidos entre desktop y cloud.
 * Placeholder — los schemas reales (licencias, productos, ventas, sync, pagos)
 * se definen en prompts posteriores.
 */
export const LicenseSchema = z.object({});
export type License = z.infer<typeof LicenseSchema>;
