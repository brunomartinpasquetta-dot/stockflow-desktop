# @stockflow/core

Capa de **servicios de dominio**: orquesta los repositorios de `@stockflow/db` y
aplica las reglas de negocio cross-entity (permisos por rol, resolución de precios,
apertura automática de cuenta corriente, arqueo de caja, reportes consolidados).

## Arquitectura en capas

```
@stockflow/db          @stockflow/core          (P05) Electron main        UI (React)
┌───────────────┐      ┌─────────────────┐      ┌───────────────────┐      ┌──────────┐
│  Repositories │ ───▶ │    Services     │ ───▶ │   IPC handlers    │ ───▶ │  views   │
│  (CRUD + tx)  │      │ (reglas, perms) │      │ (validación borde)│      │          │
└───────────────┘      └─────────────────┘      └───────────────────┘      └──────────┘
        ▲                       ▲
   schema Drizzle          ServiceContext (DI: db + repos + currentUser + currentCashRegister)
   schemas Zod (@stockflow/shared)
```

Reglas de la capa:

- Los servicios **no** tocan Drizzle directamente: sólo a través de `ctx.repos`.
- **Dependency Injection** explícita: cada servicio recibe un `ServiceContext`
  (no hay singletons ni estado mutable global).
- Funciones **puras** para cálculos (`pricing`: precios, IVA, totales).
- **Permisos chequeados en cada método que muta datos** (`requirePermission`).
- Errores **tipados** (`PermissionDeniedError`, `BusinessRuleError`, + los de la capa
  de datos: `NotFoundError`, `ConstraintError`, `ValidationError`, `DatabaseError`).

## Uso

```ts
import { initLocalDb } from '@stockflow/db';
import { AuthService, createServiceContext, createServices } from '@stockflow/core';
import { createRepositories } from '@stockflow/db';

const { db } = initLocalDb('/ruta/stockflow.db');

// login
const auth = new AuthService(createRepositories(db));
const { user, sessionToken } = await auth.login('admin', 'admin');

// contexto + servicios para ese usuario
const ctx = createServiceContext(db, user /*, currentCashRegister */);
const svc = createServices(ctx);

await svc.cash.openCashRegister('1000.0000');
const { sale } = await svc.sales.createSale({
  type: 'B',
  customerId: someCustomerId,
  paymentType: 'cash',
  lines: [{ articleId, quantity: '2.000' }], // unitPrice se resuelve por lista/mayorista
});
```

## Servicios

| Servicio | Métodos principales |
| --- | --- |
| `AuthService` | `login`, `verifySession`, `checkPermission`, `requirePermission` |
| `SalesService` | `createSale`, `voidSale`, `getSale`, `SalesService.calculateTotals` (estático, puro) |
| `PurchasesService` | `createPurchase`, `getPurchase` |
| `CashService` | `openCashRegister`, `closeCashRegister`, `getCashReport`, `addMovement` |
| `InventoryService` | `checkStock`, `adjustStock`, `getLowStockReport` |
| `AccountsReceivableService` | `receivePayment`, `getCustomerStatement`, `getTotalReceivables` |
| `ReportsService` | `salesByDateRange`, `purchasesByDateRange`, `salesBySeller`, `inventoryByFamily`, `topArticles`, `cashRegisterReport` |

`pricing` (puro): `resolvePrice`, `applyDiscount`, `calculateVAT` (IVA contenido), `calculateSaleTotals`.

## Matriz de permisos

| acción \ rol | admin | manager | seller |
| --- | :-: | :-: | :-: |
| `manage_users` | ✓ | ✗ | ✗ |
| `manage_company` | ✓ | ✗ | ✗ |
| `manage_articles` | ✓ | ✓ | ✗ |
| `manage_suppliers` | ✓ | ✓ | ✗ |
| `manage_families` | ✓ | ✓ | ✗ |
| `manage_cards` | ✓ | ✓ | ✗ |
| `manage_purchases` | ✓ | ✓ | ✗ |
| `void_sale` | ✓ | ✓ | ✗ |
| `close_cash` | ✓ | ✓ | ✗ * |
| `add_cash_movement` | ✓ | ✓ | ✗ |
| `adjust_stock` | ✓ | ✗ | ✗ |
| `view_reports` | ✓ | ✓ | ✗ |
| `create_sale` | ✓ | ✓ | ✓ |
| `view_articles` | ✓ | ✓ | ✓ |
| `open_cash` | ✓ | ✓ | ✓ |
| `receive_payment` | ✓ | ✓ | ✓ |

\* Un `seller` puede cerrar **su propia** caja aunque no tenga el permiso `close_cash`
(`CashService.closeCashRegister` lo contempla por dueño de caja).

La matriz vive en [`src/auth/permissions.ts`](src/auth/permissions.ts).

## Cómo agregar un nuevo servicio

1. Crear `src/services/${dominio}.service.ts` con la clase `${Dominio}Service`:
   ```ts
   import type { ServiceContext } from '../context';
   import { requirePermission } from '../auth/permissions';
   import { BusinessRuleError, NotFoundError } from '../errors';

   export class FooService {
     constructor(private readonly ctx: ServiceContext) {}

     async hacerAlgo(input: FooInput): Promise<FooResult> {
       requirePermission(this.ctx.currentUser, 'alguna_accion'); // si muta datos
       // ... usar this.ctx.repos.*, validar reglas, lanzar errores tipados ...
     }
   }
   ```
2. Si necesita una acción nueva, agregarla a `PERMISSION_ACTIONS` y a la matriz en
   `src/auth/permissions.ts`.
3. Exportarlo en `src/services/index.ts` y agregarlo a `createServices` y a la
   interfaz `Services`.
4. Cubrirlo en `src/tests/services.smoke.ts`.

## Scripts

| Script | Qué hace |
| --- | --- |
| `pnpm --filter @stockflow/core type-check` | `tsc --noEmit` |
| `pnpm --filter @stockflow/core test:smoke` | Smoke test de servicios (DB temporal) |
| `pnpm --filter @stockflow/core test:smoke:pricing` | Smoke test de la lógica de precios/IVA |
