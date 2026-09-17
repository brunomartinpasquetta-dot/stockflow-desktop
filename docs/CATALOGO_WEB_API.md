# Catálogo web ↔ StockFlow — el estándar de integración

Contrato que tiene que cumplir **cualquier** catálogo o tienda online para conectarse con
StockFlow. No depende de la tecnología del catálogo (PocketBase, WooCommerce, algo a
medida): son seis rutas HTTP con JSON y un token. La primera implementación fue el
catálogo de Leo Citzia (sep-2026); lo que está acá es lo que StockFlow espera de todos.

Del lado StockFlow lo implementan `apps/desktop/electron/catalogo/CatalogoSync.ts` (el
que llama) y `apps/desktop/electron/ipc/handlers/catalogo.handlers.ts`; la pantalla está
en Mi Empresa → Catálogo web (dirección + clave, espejo, vinculación) y en Cobros y Pagos →
Pedidos web.

---

## 1. La idea

El stock, el código, el nombre y el precio de los artículos **son del sistema de gestión**
(StockFlow, en la PC del local). El catálogo es un **espejo**: recibe lo que necesita para
vender y devuelve los pedidos. No hay base compartida: la del local tiene que funcionar sin
internet y la del catálogo tiene que estar en línea las 24 horas.

**Toda la comunicación la inicia StockFlow**, siempre saliente. La PC del comercio no tiene
IP fija, está detrás del router de un local y se apaga a la noche: nadie puede llamarla. El
catálogo **nunca** conecta hacia el sistema; solo responde.

Consecuencia: **el catálogo tiene que seguir vendiendo con la PC apagada.** El stock que
muestra es el de la última actualización, y los pedidos esperan a que StockFlow los baje.

Se publica **estado, no eventos**: "este artículo tiene 7", nunca "salieron 3". Por eso
mandar de más es inofensivo y una PC apagada una semana se pone al día con una sola
corrida.

---

## 2. Lo que el catálogo tiene que guardar

**En cada producto:**

```
codigo_sistema   texto, opcional, único cuando no está vacío
```

Es el **código de barras del artículo en StockFlow** y es el único dato que une los dos
mundos. No se reutiliza el `sku` del catálogo: ese es suyo. Un producto sin
`codigo_sistema` no se sincroniza y queda como está.

**En cada pedido:**

```
tomado_at        fecha, opcional  — cuándo se lo llevó StockFlow
venta_sistema    texto            — el comprobante que le asignó StockFlow (ej. "B-0004-00001247", "X-37")
pagado           booleano         — si ya se cobró en el catálogo (ver 3.4)
```

---

## 3. Las rutas

Todas bajo `/api/stockflow/*`, con **`Authorization: Bearer <token>`**. El token es fijo,
lo genera el catálogo y el comerciante lo pega en StockFlow (Mi Empresa → Catálogo web).
Sin token válido: **401** siempre, sin decir en el mensaje si el token existe o no.

Respuestas en JSON. Importes: número con 2 decimales. Cantidades: hasta 3 decimales (el
sistema maneja fraccionados por peso).

### 3.1 `GET /api/stockflow/productos` — para vincular

Devuelve el catálogo completo para que el comerciante lo aparee **desde StockFlow** (el que
conoce los artículos está del lado del sistema). Se usa una vez y después casi nunca.

```json
{ "productos": [
    { "id":"4qxi…", "sku":"ABC-1", "nombre":"Apriet. Binder Nº4 41mm",
      "codigo_sistema":"", "precio":1200, "activo":true, "categoria":"Broches" }
  ],
  "total": 4525 }
```

Paginado con `?pagina=1&por_pagina=500`, ordenado por `sku` para que sea estable.

### 3.2 `POST /api/stockflow/vincular` — asignar el código

```json
{ "vinculos": [ { "sku":"ABC-1", "codigo_sistema":"2000000004617" } ] }
```

- Escribe `codigo_sistema` en el producto de ese `sku`.
- `codigo_sistema: ""` **desvincula** (hay que poder deshacer un apareo equivocado).
- Si ese código ya está en otro producto: **409** con el `sku` que lo tiene. No se pisa.
- Responde `{ "vinculados": N, "errores": [{ "sku":"…", "motivo":"…" }] }`.

StockFlow propone apareos por nombre (solo cuando el nombre coincide con **un único**
artículo) y el comerciante confirma o busca a mano; después manda este POST.

### 3.3 `POST /api/stockflow/articulos` — el espejo

El corazón. StockFlow manda tandas de hasta 500, cada 60 segundos si hubo cambios, y todo
desde cero cuando el comerciante pide "republicar".

```json
{ "articulos": [
    { "codigo":"2000000004617", "nombre":"GOMA MAPED GOLD SOFT",
      "precio":240, "stock":15, "activo":true, "unidad":"UN" }
  ],
  "crear_faltantes": true }
```

Por cada artículo, buscar el producto por `codigo_sistema == codigo`:

- **Si existe:** actualizar `nombre`, `precio`, `stock`, `activo` y dejar el control de stock
  **activado**. **No tocar** fotos, categoría, descripción, marca, destacados ni ningún
  campo de presentación: eso es del catálogo y lo curó el comerciante.
- **Si no existe y `crear_faltantes` es true:** crearlo **inactivo** (invisible en la
  tienda), en una categoría "Sin clasificar", con `codigo_sistema`, nombre, precio y stock.
  Así el comerciante carga el artículo **una sola vez**, en el sistema, y lo termina de
  vestir en el panel del catálogo.
- **Si no existe y `crear_faltantes` es false:** ignorarlo y devolverlo en `desconocidos`.

```json
{ "actualizados": 480, "creados": 3, "desconocidos": ["2000000009999"], "errores": [] }
```

**Idempotente**: mandar dos veces la misma tanda deja el mismo resultado. StockFlow
reintenta cuando se corta la conexión y no avanza su cursor hasta recibir 200.

> El `precio` es el de la lista que el comercio publica (por defecto la 1) y el `stock`
> es el físico del sistema. El catálogo descuenta su propio stock en el checkout mientras
> el pedido está pendiente; cuando StockFlow lo convierte en venta, el stock del sistema
> baja y la siguiente publicación lo deja igual en los dos lados.

### 3.4 `GET /api/stockflow/pedidos` — los pedidos nuevos

```
GET /api/stockflow/pedidos?desde=<ISO8601 opcional>
```

Devuelve los pedidos con **estado pendiente y `tomado_at` vacío**, del más viejo al más
nuevo, máximo 100 por llamada.

```json
{ "pedidos": [
  { "id":"abc123", "numero":42, "created":"2026-09-09T21:14:00Z",
    "cliente_nombre":"Juan Pérez", "cliente_telefono":"3424…", "cliente_email":"…",
    "entrega":"retiro", "direccion":"", "notas":"", "total":4800, "pagado":false,
    "items":[ { "sku":"ABC-1", "codigo_sistema":"2000000004617",
                "nombre":"Apriet. Binder Nº4", "cant":2, "precio":1200,
                "subtotal":2400, "servicio":false } ] } ] }
```

- **`codigo_sistema` en cada ítem es obligatorio**: resolverlo contra el producto al
  momento de responder, no confiar en el snapshot del pedido. Si un ítem no lo tiene,
  mandarlo igual con `""`: StockFlow lo muestra como línea suelta (se cobra, no mueve stock).
- `entrega` es `retiro` o `envio` (con `direccion`).
- **`pagado`**: `true` solo si el catálogo ya cobró el pedido (Mercado Pago u otro medio
  online). Ausente = `false`. Con `pagado:true` StockFlow registra la venta con el medio
  "Mercado Pago" sin preguntar cómo se cobró; con `false` el comerciante la carga en Ventas y
  cobra con la forma de pago que corresponda.
- Un pedido con líneas sin precio (`precio` 0) no se puede convertir: StockFlow lo avisa y
  el comerciante lo cotiza en el catálogo primero.

### 3.5 `POST /api/stockflow/pedidos/:id/estado` — acuse y estado

```json
{ "estado":"tomado", "venta_sistema":"B-0004-00001247" }
```

- `"tomado"` → sella `tomado_at`. Si ya estaba sellado, responder 200 igual
  (**idempotente**): StockFlow lo manda apenas guarda el pedido y lo repite si se cortó.
- `"confirmado"` → el pedido se convirtió en venta; viene con `venta_sistema`.
- `"cancelado"` → **reponer el stock** de los ítems que se descontaron en el checkout y
  pasar el pedido a cancelado, conservando `venta_sistema` si lo tenía. StockFlow lo manda
  cuando el comerciante **rechaza** el pedido y cuando **anula la venta** en la que ya se
  había convertido (puede llegar días después de `confirmado`).
- `"preparando"`, `"listo"`, `"entregado"` → estados del panel; StockFlow no los usa hoy.
- Un `id` que el catálogo no conoce → **404** (StockFlow lo toma como "nada que hacer" y no
  insiste). Cualquier otro error → StockFlow reintenta más tarde.

### 3.6 `GET /api/estadisticas` — para la pestaña Catálogo web de Estadísticas

```
GET /api/estadisticas?from=<epoch ms>&to=<epoch ms>
Authorization: Bearer <token>
```

```json
{ "visitas": 1200, "visitantes": 340,
  "productosMasVistos":    [ { "descripcion":"…", "vistas": 80 } ],
  "productosMasComprados": [ { "descripcion":"…", "cantidad": 12 } ],
  "terminosMasBuscados":   [ { "termino":"…", "veces": 15 } ],
  "busquedasSinResultado": [ { "termino":"…", "veces": 4 } ] }
```

`visitantes` es opcional. Si la ruta no existe, la pestaña muestra "no disponible" y nada
más se rompe.

---

## 4. Lo que el catálogo NO debe hacer

- **No conectar hacia StockFlow.** Solo responde.
- **No crear productos por su cuenta a partir de un pedido**, ni inventar códigos.
- **No tocar fotos, categorías ni descripciones** desde el espejo.
- **No sincronizar clientes.** Las cuentas web se quedan en el catálogo.
- **No descontar del stock que le llega**: es el físico del sistema; el catálogo solo
  descuenta lo que vende en su propio checkout hasta que StockFlow confirma.

---

## 5. Cómo lo verifica StockFlow (lo que tiene que dar bien)

- Sin token → 401 en todas las rutas.
- Dos veces la misma tanda de artículos → nada duplicado, mismos contadores.
- El mismo `codigo_sistema` en dos productos → 409 con el `sku` que lo tiene.
- Un pedido ya tomado no vuelve a aparecer en `/pedidos`.
- `cancelado` devuelve las unidades: stock antes = stock después de cancelar.
- Flujo completo probado el 16/17-sep-2026 contra el catálogo local de Citzia: vincular
  por el diálogo → espejo publica → compra por el checkout → pedido baja → se cobra en
  Ventas → `confirmado` con `venta_sistema` → se anula la venta → `cancelado`, stock
  repuesto en los dos lados. Smoke: `pnpm --filter @stockflow/desktop test:catalogo`.

---

## 6. Del lado StockFlow, para el que mantiene esto

- Tablas: `catalogo_sync` (estado del espejo: cursor por `updated_at`, último error) y
  `catalogo_pedidos` (los pedidos bajados: `pedido_id` único, `pagado`, `estado`
  pendiente/convertido/rechazado, `sale_id` a `sales`). Migraciones 0027–0030.
- El espejo corre en **una sola máquina**: la que tiene la base. Una terminal LAN no
  empuja (sus datos son remotos).
- `traerPedidos()` va SIEMPRE antes de `correr()` (el empujón): al revés, el empujón le
  devolvería al catálogo las unidades que el checkout acababa de descontar.
- El cursor por `updated_at` estira la página para no partir un grupo de filas con el mismo
  milisegundo (un UPDATE masivo las deja empatadas).
- `cancelarPedidosDeVentasAnuladas()` es un barrido: corre tras anular una venta, tras
  "anular las de hoy" y al abrir Pedidos web; marca el pedido recién con el acuse del
  catálogo, así lo que quedó sin avisar se reintenta.
