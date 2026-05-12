# @stockflow/desktop

App de escritorio (Electron + Vite + React). El proceso main hospeda la base
local y los servicios de dominio; el renderer los consume por IPC vía
`contextBridge` (sin `nodeIntegration`, sin `remote`).

## Arrancar en desarrollo

```bash
pnpm --filter @stockflow/desktop electron:dev
```

Esto: levanta Vite (`http://localhost:5173`), bundlea el proceso main/preload
(`scripts/build-electron.mjs` → `dist-electron/`) y abre Electron apuntando al
dev server. La DB se crea/migra/seedea en `app.getPath('userData')/stockflow.db`.

> **Módulos nativos (better-sqlite3) — importante.** `better-sqlite3` es un módulo
> nativo con binario ABI-específico (NAN, no N-API): un `pnpm install` lo compila
> contra el Node del sistema (ej. Node 24 → `NODE_MODULE_VERSION 137`), pero
> Electron 30 embebe Node 20 (`NODE_MODULE_VERSION 123`) y no puede cargar ese
> binario. Por eso `apps/desktop` tiene un `postinstall` que ejecuta
> `electron-rebuild -f -w better-sqlite3` (vía `@electron/rebuild`) para recompilarlo
> contra los headers de Electron. Si el `postinstall` no corrió por algún motivo,
> hacelo a mano: `pnpm --filter @stockflow/desktop rebuild:native`.
>
> Consecuencia: tras `pnpm install` el binario queda en ABI Electron → `electron:dev`
> anda, pero los smoke tests que corren con `tsx` (Node) — `test:ipc`,
> `@stockflow/db`/`@stockflow/core` — **no podrán cargar `better-sqlite3`** hasta
> recompilarlo para Node. Para volver al binario de Node:
> `cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && node-gyp rebuild --release`
> (y `pnpm --filter @stockflow/desktop rebuild:native` para volver a Electron). Esto
> se resuelve de forma definitiva al empaquetar con `electron-builder` (P11).

Otros scripts:

| Script | Qué hace |
| --- | --- |
| `pnpm --filter @stockflow/desktop dev` | Sólo el renderer (Vite), sin Electron |
| `pnpm --filter @stockflow/desktop build:electron` | Bundlea main + preload + copia migraciones |
| `pnpm --filter @stockflow/desktop build` | Build web + build electron |
| `pnpm --filter @stockflow/desktop rebuild:native` | Recompila `better-sqlite3` contra Electron (`@electron/rebuild`) |
| `pnpm --filter @stockflow/desktop type-check` | `tsc` del renderer y de `electron/` |
| `pnpm --filter @stockflow/desktop test:ipc` | Test de integración del bridge IPC (sin Electron, `tsx`) |
| `pnpm --filter @stockflow/desktop lint` | ESLint |
| `pnpm --filter @stockflow/desktop clean` | Borra `dist/`, `dist-electron/` |

## Flujo de una llamada

```
window.stockflow.<grupo>.<método>(payload)        (renderer)
        │  ipcRenderer.invoke('<grupo>:<método>', payload)
        ▼
ipcMain.handle('<grupo>:<método>')                (electron/main, registerIpcHandlers)
        │  withSession → arma ServiceContext (db + repos + currentUser + currentCashRegister)
        ▼
Service de dominio (@stockflow/core)              (reglas, permisos, validación Zod)
        ▼
Repository (@stockflow/db)                         (CRUD + transacciones)
        ▼
SQLite (better-sqlite3, en userData)
        ▲
        └─ errores → serializeError → { ok:false, code, message, ... }   (nunca `throw` al renderer)
```

## Estructura de `electron/`

```
electron/
├── main.ts                  # entry: single-instance lock, bootstrap, ventana, ciclo de vida
├── preload.ts               # contextBridge → window.stockflow (tipado por ipc/types.ts)
├── logger.ts                # electron-log + redirección de console.* del main
├── bootstrap/
│   ├── db.ts                # initLocalDb en userData, repos, shutdown
│   ├── session.ts           # secreto de sesión persistente (cifrado con safeStorage)
│   └── machine.ts           # machineId (SHA-256, cacheado en electron-store)
├── ipc/
│   ├── index.ts             # buildAllHandlers / registerIpcHandlers
│   ├── types.ts             # IpcResponse, DTOs, ApiSurface (auto-contenido; lo usa el renderer)
│   ├── errors.ts            # serializeError (dominio → respuesta IPC)
│   ├── session-store.ts     # estado in-memory: sesión actual + caja activa
│   ├── handler-context.ts   # HandlerDeps, withSession, unguarded
│   └── handlers/            # un archivo por grupo de canales
└── __tests__/ipc.smoke.ts   # test de integración (tsx)
```

## Cómo agregar un nuevo canal IPC

1. Definir request/response en `electron/ipc/types.ts` (DTOs y la entrada en `ApiSurface`).
2. Implementar el handler en `electron/ipc/handlers/<grupo>.handlers.ts`:
   ```ts
   'grupo:metodo': withSession(deps, (payload: ReqDTO, ctx): Promise<ResDTO> => {
     // requirePermission(ctx.currentUser, '...')  // si muta datos
     return new MiService(ctx).hacerAlgo(payload);
   }),
   ```
   (o `unguarded(deps, ...)` si no requiere sesión).
3. Exponerlo en `electron/preload.ts`: `metodo: (p) => call('grupo:metodo', p)`.
4. Si es un grupo nuevo, sumar su `build...Handlers` a `BUILDERS` en `electron/ipc/index.ts`.
5. Cubrirlo en `electron/__tests__/ipc.smoke.ts`.

## Bundling de Electron

`scripts/build-electron.mjs` empaqueta `electron/main.ts` como **ESM** (`dist-electron/main.mjs`)
y `electron/preload.ts` como **CJS** (`dist-electron/preload.cjs`, requerido por `sandbox: true`).
Son **external** (no se bundlean): `electron` (lo provee el runtime), `better-sqlite3` (nativo) y
todas las `dependencies` de `package.json` que no sean `@stockflow/*` (p.ej. `electron-log`) — se
generan dinámicamente leyendo `package.json`. Los `@stockflow/*` (código `.ts`) sí se bundlean.

Reglas al importar paquetes external en `electron/`:

- **No bundlear deps CJS con `require` dinámicos** (como `electron-log` o el viejo `electron-store`):
  embebidas rompen el bundle ESM (`Dynamic require of "x" is not supported`). Déjalas external.
- **Cuando un paquete external CJS se importa por subpath en un bundle ESM, usar la extensión `.js`
  explícita o, mejor, importar el entrypoint raíz.** En ESM, Node no autocompleta `.js` en subpaths
  de paquetes sin campo `exports`: `import x from 'pkg/sub'` falla con `ERR_MODULE_NOT_FOUND` (hay
  que usar `'pkg/sub.js'` o `'pkg'`). Ej.: usamos `import log from 'electron-log'` (no
  `'electron-log/main'`).

## Canales disponibles

`auth:` login, logout, getCurrentUser ·
`articles:` list, get, create, update, delete, findByBarcode, searchByText, findLowStock ·
`customers:` list, get, create, update, delete, searchByText, findByDocNumber ·
`suppliers:` list, get, create, update, delete ·
`families:` list, get, create, update, delete ·
`users:` list, get, create, update, delete ·
`company:` get, upsert ·
`sales:` create, void, get, listByDateRange, getNextNumber ·
`purchases:` create, get, listByDateRange ·
`cash:` open, close, getCurrent, getReport, addMovement ·
`inventory:` checkStock, adjustStock, getLowStockReport ·
`accounts:` receivePayment, getStatement, getTotalReceivables ·
`reports:` salesByDateRange, purchasesByDateRange, salesBySeller, inventoryByFamily, topArticles, cashRegisterReport ·
`system:` getMachineId, getVersion, getDbPath, getInfo

Todos devuelven `{ ok: true, data } | { ok: false, code, message, field?/constraint?/action?/rule? }`.
