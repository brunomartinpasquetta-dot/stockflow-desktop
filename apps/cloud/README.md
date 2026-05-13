# @stockflow/cloud — API de licencias en la nube

API HTTP (Fastify) que gestiona suscripciones (MercadoPago), licencias del
desktop y un panel de administración mínimo. Multi-tenant sobre Postgres.

## Endpoints principales

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/api/billing/subscribe` | Alta de cliente + creación de preapproval en MP. |
| `POST` | `/api/billing/webhook/mp` | Webhook de MercadoPago (firma validada). |
| `GET`  | `/api/billing/status/:tenantId` | Estado de la suscripción. |
| `POST` | `/api/licenses/activate` | Activa una licencia y devuelve un JWT (7 días). |
| `POST` | `/api/licenses/heartbeat` | Ping del desktop; renueva el JWT si está por vencer. |
| `GET`  | `/api/me` | Datos del tenant + features del plan (requiere JWT). |
| `POST` | `/api/admin/login` | Login del admin → token (`admin: true`, 12h). |
| `GET`  | `/api/admin/tenants` | Lista de tenants + sus licencias. |
| `POST` | `/api/admin/tenants/:id/suspend` · `/reactivate` · `/license/release` · `/regenerate-license` | Acciones admin. |
| `GET`  | `/health` | Healthcheck. |
| `GET`  | `/landing.html` | Landing pública de alta. |

## Correr localmente

1. Levantar un Postgres (local o Docker):
   ```bash
   docker run -d --name stockflow-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
   createdb -h localhost -U postgres stockflow_cloud   # o psql -c 'CREATE DATABASE stockflow_cloud;'
   ```
2. Configurar variables:
   ```bash
   cp .env.example .env
   # editar DATABASE_URL, y opcionalmente MP_ACCESS_TOKEN / SMTP_* / ADMIN_*
   ```
3. Aplicar el schema. Con drizzle-kit:
   ```bash
   pnpm --filter @stockflow/db exec drizzle-kit migrate --config drizzle.config.ts
   ```
   o directamente con el SQL de la migración:
   ```bash
   psql "$DATABASE_URL" -f ../../packages/db/migrations/cloud/0000_cloud_init.sql
   ```
4. Arrancar en modo dev:
   ```bash
   pnpm --filter @stockflow/cloud dev
   ```
   La API queda en `http://localhost:3009`. Las claves RSA del JWT se generan
   automáticamente en `apps/cloud/.keys/` la primera vez (ignoradas por git).

### Tests

```bash
pnpm --filter @stockflow/cloud run type-check
pnpm --filter @stockflow/cloud run test:smoke   # usa pglite en memoria, no requiere Postgres
```

## Deploy (Railway / Render / Fly.io)

- Setear todas las variables de entorno del `.env.example` (Postgres administrado
  → `DATABASE_URL`).
- **Claves JWT**: o bien montar un volumen persistente en `apps/cloud/.keys/`, o
  —recomendado— setear `JWT_PRIVATE_KEY` y `JWT_PUBLIC_KEY` (PEM con `\n`
  escapados) para que los tokens emitidos sigan siendo válidos entre redeploys.
- Build/start: `pnpm --filter @stockflow/cloud build` y luego
  `pnpm --filter @stockflow/cloud start` (o `node dist/server.js`).
- Exponer el puerto de `PORT` (3009 por defecto). Configurar el healthcheck en
  `/health`.

## Configurar el webhook de MercadoPago

1. Panel de developers de MercadoPago → tu aplicación → **Webhooks / Notificaciones**.
2. URL: `https://TU-DOMINIO/api/billing/webhook/mp`.
3. Eventos: pagos (`payment`) y suscripciones (`preapproval`).
4. Copiar la **clave secreta** que da MP y setearla en `MP_WEBHOOK_SECRET`. Sin
   ese secreto el webhook se acepta sin validar firma (sólo apto para dev).

> Nota: el handler del webhook opera sobre el body recibido (y, para pruebas,
> acepta `?event=` y `?tenantId=`). En producción conviene consultar el recurso
> en la API de MP con el `data.id` para confirmar el estado real (TODO marcado en
> `src/routes/billing.routes.ts`).

## Regenerar la licencia de un cliente (soporte)

Opción API:
```bash
TOKEN=$(curl -s -XPOST https://TU-DOMINIO/api/admin/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@tu-dominio","password":"..."}' | jq -r .token)

curl -s -XPOST https://TU-DOMINIO/api/admin/tenants/<TENANT_ID>/regenerate-license \
  -H "authorization: Bearer $TOKEN"
# → { "ok": true, "licenseKey": "SF-XXXX-XXXX-XXXX-XXXX" }
```
También se puede liberar la máquina vinculada (para reactivar en otra PC):
`POST /api/admin/tenants/:id/license/release`.

Opción SQL directa:
```sql
UPDATE licenses SET status = 'revoked' WHERE tenant_id = '<TENANT_ID>';
INSERT INTO licenses (tenant_id, license_key, status) VALUES ('<TENANT_ID>', 'SF-XXXX-XXXX-XXXX-XXXX', 'pending');
```
