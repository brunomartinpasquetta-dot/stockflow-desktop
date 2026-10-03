# Multisucursal — plan de trabajo

Fecha: 2-oct-2026. Estado: **plan, nada implementado**. Cliente que lo dispara: **Novo-Hogar y Muebles** (la gente de Ferretería Coronda), casa central en Coronda y segunda sucursal en **San Carlos**. Fecha de apertura: **sin definir** (Bruno espera reunión con el cliente).

Base: revisión del código el 2-oct-2026 (`packages/db`, `packages/core`, `apps/desktop/electron`, `apps/desktop/src`). Lo de la conexión por internet sale de **leer el código, no se probó contra un túnel real**.

---

## 1. Qué pidió Bruno

1. Que la segunda sucursal use StockFlow.
2. El catálogo web vinculado al **servidor principal**.
3. Stock **general (total)** y **separado por sucursal**.
4. Que multisucursal se active **sólo para el cliente que lo necesita**, sin complicar a los comercios simples.

## 2. Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| ¿Un sistema o dos? | **Uno solo.** Multisucursal es una opción apagada que se prende por licencia. | Dos sistemas = mantener todo dos veces para siempre (cada arreglo, cada versión, cada cambio de ARCA). Mismo motivo por el que se descartó un build aparte para Windows 7. Además permite cobrarlo como plan superior. |
| Comercios simples | Todos pasan a tener una única sucursal **"Casa central"**, sin enterarse. Mientras haya una sola sucursal **no aparece nada nuevo** en pantalla. | Cero cambios visibles para quien no lo usa. |
| Conexión | **Servidor central en Coronda**; las PC de San Carlos trabajan como terminales **por internet**, usando el túnel que ya existe (`<comercio>.mistockflow.com`). | Una sola base de datos: no hay que sincronizar, los números no chocan, el catálogo queda naturalmente en el principal. |
| Stock | Cantidad **por artículo y sucursal** + **registro de cada movimiento**. `articles.stock` queda como el **total** (suma de sucursales). | Todo lo que hoy lee `articles.stock` (catálogo, reportes, Flowy, alertas) sigue andando sin tocarlo. El registro de movimientos le sirve a todos los clientes (historial del artículo). |
| Caja y ARCA | Una caja y un punto de venta por sucursal. | El certificado de ARCA es por CUIT y sirve para todos los PV. |
| Catálogo | Sigue corriendo sólo en el servidor (ya es así). Publica el **total de las sucursales** menos lo reservado por pedidos web. | Pedido de Bruno. Si el cliente quiere otra cosa, se agrega "esta sucursal publica en la web: sí/no". |
| Sin internet | **Fuera del alcance inicial.** Mitigación: PC servidor siempre prendida, con UPS, y router 4G de respaldo en Coronda. | Trabajar sin conexión y sincronizar después es un proyecto grande aparte. Se hace si la realidad lo pide. |

**En contra del servidor central, dicho de frente:** si se corta internet en Coronda o se apaga esa PC, **San Carlos no vende**. Es el precio de no sincronizar dos bases.

## 3. Preguntas para la reunión con el cliente

Las marcadas con ⚠ **cambian el diseño** si la respuesta es distinta a la supuesta.

1. **¿Cuándo abre San Carlos?** Define si hace falta un puente (sección 7).
2. ⚠ **¿Las dos sucursales son la misma razón social / mismo CUIT?** Se supone que sí (un certificado, dos puntos de venta). Si son CUIT distintos: dos configuraciones fiscales, dos libros de IVA → más trabajo.
3. ⚠ **¿Los precios son los mismos en los dos locales?** Se supone que sí. Precios por sucursal es un cambio grande (las listas de precios hoy están en el artículo).
4. **¿Cuántas PC en cada local? ¿Cuál queda de servidor?** (Se supone una PC de Coronda.) Esa PC no se puede apagar en horario de San Carlos.
5. **¿Qué internet tiene cada local?** ¿Pueden poner UPS y un 4G de respaldo en Coronda?
6. **Catálogo web:** ¿mostrar el stock total o sólo de un local? ¿El cliente web retira en cualquiera de los dos? ¿Quién atiende los pedidos web?
7. ⚠ **¿Hay depósito aparte?** (electrodomésticos suele tenerlo). Un depósito sería una "sucursal" más de stock, sin caja ni ventas.
8. **Caja General:** ¿una sola del dueño o una por local?
9. **Empleados:** ¿cada uno trabaja fijo en un local? ¿Un empleado de San Carlos debe ver sólo su local?
10. **Transferencias de mercadería:** ¿quién las hace? ¿Se confirma la recepción en el otro local?
11. **Compras:** ¿compra la central y reparte, o cada local compra?
12. **Clientes y cuenta corriente:** se supone **compartidos** entre los dos locales (un cliente puede comprar en uno y pagar en el otro). ¿Está bien?
13. **Mercado Pago QR:** ¿una sola cuenta? (Hoy hay un único `storeId`.)
14. **¿Qué quiere ver el dueño?** Ventas por local, comparación entre locales, stock por local, etc.

## 4. Etapas

### Etapa 1 — Conexión de la sucursal y arreglos que sirven a todos (~1 semana, riesgo bajo)

- **Terminal por dirección web:** hoy la terminal instalada sólo guarda `serverIp` + `serverPort` y arma `http://ip:puerto` fijo (`preload-bridge.ts` `parseLanArgs`/`baseDelServidor`; `api.lan.pingServer` en `src/lib/api.ts`; `pingServer` en `lan.handlers.ts`). Aceptar una URL completa (`https://…`) y corregir ping y diagnóstico. Si el ping falla, `useCanWrite` deja el sistema en sólo lectura (`LicenseContext.tsx`).
- **Emparejar PC de sucursal:** el túnel hoy aplica `remotoAccepts` (`preload-bridge.ts`), que bloquea **todo `fiscal`** (Ventas entra sin facturación → todo sale Remito X) y **todo `mpQr`**. Agregar un código de emparejamiento por PC (guardado cifrado en la terminal, enviado en un encabezado, verificado en la escucha del túnel, revocable) que habilite la lista completa de canales de LAN para esa PC. Meter el ID de dispositivo en el JWT y en la auditoría.
- **Identidad de la terminal → una caja por PC:** hoy `cash:open` y `cash:getCurrent` usan `deps.machineId`, que en pedidos por red es el **ID del servidor** (`cash.handlers.ts`), y `sales:create` cae en la última caja abierta (`cashRegister.repository.ts` `getCurrentOpen`, `sales.service.ts`). La terminal tiene que mandar su ID y el servidor usarlo.
- **Venta duplicada:** `sales:create` no tiene clave de idempotencia. Si vence el tiempo después de grabar y se reintenta, queda dos veces. Agregar clave por venta.
- **Tiempos y peso:** la terminal da 10 s por pedido (`preload-bridge.ts`); ARCA puede tardar 20–30 s del lado del servidor. Después de cada venta se vuelve a bajar `articles:list` completo sin comprimir (~3 MB con 5.000 artículos). Subir el tiempo para fiscal, comprimir (gzip) y evitar bajar el catálogo entero en cada venta.
- **Punto de venta por PC:** `sale_points.terminal_id` ya existe pero no se usa (Ventas toma el primer PV activo, `Ventas.tsx`). Usarlo o recordarlo por PC.
- **Bloqueo por intentos fallidos:** se cuenta por red /24 tomada de `X-Forwarded-For`; todas las PC de una sucursal comparten contador. Con el emparejamiento, contar por dispositivo.

### Etapa 2 — Stock por sucursal (~2 semanas, **riesgo alto**)

Situación hoy: un único `articles.stock` (TEXT, `packages/db/src/schema/local.ts`), **sin tabla de movimientos**.

- Tablas nuevas: `branches` (sucursales), `article_stock` (artículo × sucursal × cantidad), `stock_movements` (artículo, sucursal, cantidad ±, motivo, referencia a venta/compra/etc., usuario, fecha).
- **Un único punto del código que mueve stock** (`moverStock(articleId, branchId, delta, motivo, ref)`), dentro de la misma transacción: actualiza `article_stock`, recalcula `articles.stock` (total) y graba el movimiento. Ojo: tocar `articles.updated_at` igual que hoy, porque el catálogo detecta cambios por esa columna (`catalogo.repository.ts`); si no, el stock deja de llegar a la web **sin dar error**.
- Lugares que hoy escriben stock y pasan a `moverStock` (6 archivos, ~10 puntos):
  - `sale.repository.ts`: `createWithLines` (incluye componentes de promos) y `voidSale`.
  - `purchase.repository.ts`: `createWithLines` y `voidPurchase`.
  - `return.repository.ts`: `createSaleReturn` y `createPurchaseReturn`.
  - `inventory.service.ts`: `adjustStock`; alta/edición en `Articulos.tsx`.
  - `ExcelImportService.ts`: stock inicial de artículos nuevos.
  - `maintenance.repository.ts`: reseteo a 0.
  - Indirectos (pasan por `SalesService.createSale`): presupuestos (`quotes.service.ts`) y pedidos web (`catalogo.handlers.ts`).
  - Herramientas fuera de la app que insertan directo: `tools/migracion/migrar.py`, `tools/migracion/crear-db-vacia.ts`, `scripts/seed-volume.ts`, `electron/demo/seedDemoData.ts`.
- Migración: crear "Casa central", copiar `articles.stock` a `article_stock` para esa sucursal. Columnas nuevas con valor por defecto, **sin reconstruir tablas** (reconstruir es riesgo medio; la 0036 ya tiene triggers de `jornada` sobre `cash_registers`).
- **Transferencias** entre sucursales con remito interno (sale de A, entra en B; con confirmación de recepción si el cliente la quiere).
- Pantallas: stock por sucursal en Artículos (sólo si hay más de una), filtro "stock de esta sucursal / total".

### Etapa 3 — Caja, ARCA, numeración y reportes por sucursal + licencia (~1 semana, riesgo bajo)

- `branch_id` en `cash_registers`, `sales`, `purchases`, `returns`, `quotes`, `sale_points`, usuarios (sucursal asignada).
- **Numeración:** con servidor central no hay choque (una sola base). Los números internos (`sales(type, number)`, `returns.number`, etc., MAX+1 globales) pueden seguir globales. ARCA ya numera por punto de venta.
- **ARCA:** `sale_points` ya soporta varios PV; asociar cada PV a una sucursal. Revisar `fiscal:archivarPendientes`, que asume `puntos[0]`. El PV de San Carlos lo da de alta el contador en ARCA como **"RECE para aplicativo y web services"** (si no, error 10005).
- **Caja General:** hoy es una fila única (`cashGeneral.repository.ts`, `'singleton'`). Según la respuesta 8 de la reunión: una global o una por sucursal.
- **Reportes:** ~45–55 consultas (`analytics.service.ts` 21 métodos, `reports.service.ts` 9, `cashGeneral.service.ts` 8, `cash.service.ts`, `accounting.service.ts` 3, repositorios de ventas/pagos, `consultas.ts` de Flowy ~8). Casi todas filtran por `jornada` o fecha → un filtro de sucursal común cubre la mayoría. Agregar "todas / esta sucursal" y comparación entre sucursales.
- **Activación por licencia:** marca `multisucursal` en la licencia (cloud: `licenses`), que habilita Configuración → Sucursales.

## 5. Riesgo para los clientes actuales y cómo se controla

- **El único riesgo alto es la etapa 2** (el stock es el corazón: un error deja el stock de un comercio descuadrado).
  - Un solo lugar del código que mueve stock.
  - La migración asigna todo a "Casa central" y no cambia ningún número.
  - **Prueba obligatoria antes de publicar:** correr la migración sobre **copias de bases reales** y verificar que `articles.stock` queda idéntico artículo por artículo; repetir ventas, compras, devoluciones, anulaciones y ajustes y comparar contra la versión anterior.
  - Las 26 baterías + baterías nuevas de stock por sucursal y transferencias.
- Etapas 1 y 3 son de riesgo bajo; las columnas nuevas llevan valor por defecto.
- Se publica por etapas, cada una con su versión, nunca todo junto.

## 6. Problemas que ya existen hoy en producción (encontrados en la revisión)

1. **Caja compartida en red** (confirmado leyendo `cash.handlers.ts`): en comercios con varias PC (ej. Leo Citzia, 3 PC) todas las terminales abren la caja con el ID del servidor → en la práctica comparten una caja. No rompe nada hoy; se arregla en la etapa 1.
2. **Venta duplicada si se corta la conexión** justo después de grabar y se reintenta. En red local es raro; por internet sería más frecuente. Etapa 1.

## 7. Si San Carlos abre antes de terminar la etapa 2

Se decide cuando haya fecha. Opciones:

- **A. San Carlos conectada desde el día 1 (sólo etapa 1 lista):** vende y factura, pero **stock y caja compartidos** con Coronda. Para electrodomésticos ("¿tenés la heladera en este local?") es mala.
- **B. San Carlos como StockFlow independiente** (su propia base y licencia) hasta que esté la etapa 2: se arranca con una copia de los artículos de Coronda; stock, caja y PV propios; el catálogo sigue sólo en Coronda. Al unir: se carga el stock de San Carlos en su sucursal por código de barras; su historial de ventas queda en su base para consulta. Contra: los cambios de precio hay que hacerlos en las dos mientras dure.
- **C. Tailscale** (las dos PC como si fuera red local, sin tocar código; el servidor ya trata 100.64/10 como LAN): mismo problema que A, y el plan gratis de Tailscale es de uso personal.

**Recomendación: B** si la apertura es antes de ~4 semanas desde que se arranque; si no, esperar la etapa 2.

## 8. Antes de arrancar

- Tener las respuestas de la reunión (sección 3), sobre todo las ⚠.
- Conseguir copias de bases reales para la prueba de la etapa 2 (al menos una con varias PC, ej. Leo, y una de una sola PC).
- Igual que siempre: se desarrolla y prueba en la Mac de Bruno; **nada se taggea hasta que Bruno lo diga**.
