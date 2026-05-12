# @stockflow/db

Capa de datos del PDV: schema Drizzle (SQLite local), helpers de conexión,
migraciones versionadas, seed y **capa de acceso a datos (repositorios)**.

## Flujo de datos

```
input crudo (front / IPC / API)
        │
        ▼
  schema Zod  ──────────────►  @stockflow/shared  (CreateArticleSchema, ...)
        │  .parse() — falla ⇒ ValidationError
        ▼
  Repository  ──────────────►  @stockflow/db/repositories  (ArticleRepository, ...)
        │  queries Drizzle type-safe + transacciones
        ▼
  SQLite (better-sqlite3)  ──  errores ⇒ ConstraintError / NotFoundError / DatabaseError
```

- **Validación antes de tocar la DB**: los repositorios que reciben datos crudos
  llaman al schema Zod correspondiente (`create`/`update`/`createWithLines`/...).
- **Errores tipados** (`src/errors.ts`): `NotFoundError`, `ConstraintError`,
  `ValidationError`, `DatabaseError` (todos extienden `DomainError`, discriminables
  por `instanceof` o por `.code`).
- **Decimales como string** (precisión exacta); aritmética en `@stockflow/shared`
  (`addDecimal`, `subDecimal`, `mulDecimal`, `cmpDecimal`, `sumDecimals`, ...).
- **Transacciones atómicas** (`db.transaction(...)`) para operaciones multi-tabla
  (ventas, compras, cobranzas, apertura/cierre de caja).

## Uso rápido

```ts
import { initLocalDb, createRepositories } from '@stockflow/db';

const { db } = initLocalDb('/ruta/a/stockflow.db'); // crea + migra + seedea
const repos = createRepositories(db);
```

### Artículos

```ts
const art = await repos.articles.create({
  barcode: '7790000000017',
  description: 'Gaseosa cola 2.25L',
  listPrice1: '850.0000',
  costPrice: '600.0000',
  stock: '10.000',
  minStock: '3.000',
});

await repos.articles.incrementStock(art.id, '5.000');
await repos.articles.decrementStock(art.id, '4.000'); // ConstraintError si no alcanza

const found   = await repos.articles.findByBarcode('7790000000017');
const lowList = await repos.articles.findLowStock();          // stock < minStock
const results = await repos.articles.searchByText('cola');    // LIKE en description/brand
```

### Clientes (con validación de CUIT/DNI)

```ts
const c = await repos.customers.create({
  lastName: 'PEREZ', firstName: 'Juan', category: 'RI',
  docType: 'CUIT', docNumber: '20-12345678-6',
});
// docNumber con dígito verificador inválido ⇒ ValidationError
const conSaldo = await repos.customers.findWithBalance(c.id);  // { ...customer, balance }
```

### Ventas (transacción atómica)

```ts
const reg = await repos.cashRegisters.openRegister({ openingAmount: '1000.0000', userId });

const { sale, lines } = await repos.sales.createWithLines({
  type: 'B',
  customerId, sellerId: userId, cashRegisterId: reg.id,
  paymentType: 'cash',
  lines: [{ articleId: art.id, quantity: '2.000', unitPrice: '850.0000', vatRate: '21.00' }],
});
// → inserta venta + líneas, descuenta stock y crea el cashMovement de ingreso.
//   Si algún artículo no tiene stock suficiente, revierte TODO y lanza ConstraintError.

await repos.sales.voidSale(sale.id);            // status='voided', restaura stock, cashMovement reverso
const n = await repos.sales.getNextNumber('B'); // MAX(number)+1 para el tipo
```

### Compras y cuentas corrientes

```ts
await repos.purchases.createWithLines({
  type: 'A', supplierId, paymentType: 'cash',
  updatedPricesOnSave: true, // además actualiza costo y lista 1 de cada artículo
  lines: [{ articleId, quantity: '12.000', costPrice: '500.0000', salePrice: '850.0000' }],
});

const ar = await repos.accountsReceivable.create({ customerId, saleId, total: '1800.0000' });
await repos.payments.createPayment({
  accountId: ar.id, amount: '800.0000', method: 'cash',
  cashRegisterId: reg.id, userId,
}); // inserta pago + actualiza saldo/estado de la cuenta + cashMovement de ingreso
```

### Caja

```ts
const open    = await repos.cashRegisters.getCurrentOpen();          // null si no hay caja abierta
const closed  = await repos.cashRegisters.closeRegister(open.id, { closingAmount: '1400.0000' });
// closed.notes = "Esperado: ... | Declarado: ... | Diferencia: ..."
```

## Métodos comunes (`BaseRepository`)

Todos los repositorios heredan: `findAll(filters?)`, `findById(id)`, `findOne(where)`,
`create(data)`, `update(id, data)`, `delete(id)`, `count(filters?)`.

## Cómo extender un repositorio

```ts
import { BaseRepository } from '@stockflow/db';
import { eq } from 'drizzle-orm';
import { miTabla, type MiFila, type NuevaFila } from '@stockflow/db';
import { CreateMiSchema, UpdateMiSchema } from '@stockflow/shared';

export class MiRepository extends BaseRepository<MiFila, NuevaFila> {
  // (opcional) validación automática en create/update:
  protected override readonly createSchema = CreateMiSchema;
  protected override readonly updateSchema = UpdateMiSchema;

  constructor(db: LocalDatabase) {
    super(db, miTabla, 'MiEntidad');
  }

  // métodos específicos de la entidad:
  async findByAlgo(valor: string) {
    return this.db.select().from(miTabla).where(eq(miTabla.algo, valor)).all();
  }
}
```

Pautas (SOLID):

- **Un repositorio por tabla.** La lógica cross-entity "de negocio" va en la capa de
  servicios; los repositorios sólo orquestan transacciones cuando la consistencia de
  *los datos* lo exige (venta⇄stock⇄caja).
- **No importar la conexión**: se recibe por constructor (`createRepositories(db)`).
- **No `try/catch` genéricos**: usar/propagar errores de dominio tipados
  (envolver SQLite con `rethrowDbError`).
- **Preferir queries Drizzle tipadas**; `sql\`...\`` sólo para casos puntuales
  (ej. comparación numérica sobre columnas TEXT en `findLowStock`).

## Scripts

| Script | Qué hace |
| --- | --- |
| `pnpm --filter @stockflow/db db:generate:local` | Genera migración SQL en `migrations/local/` |
| `pnpm --filter @stockflow/db db:push:local` | Aplica el schema directo (sólo dev) |
| `pnpm --filter @stockflow/db test:smoke` | Smoke test de DB (migra + seed + tablas) |
| `pnpm --filter @stockflow/db test:smoke:repos` | Smoke test de la capa de repositorios |
| `pnpm --filter @stockflow/db type-check` | `tsc --noEmit` |
