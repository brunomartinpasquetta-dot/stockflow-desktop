# Pedido al proyecto del catálogo: carga total desde StockFlow

StockFlow ya tiene el botón **Mi Empresa → Catálogo web → "Cargar todos los
artículos"** (commit `6656dcd`). Vincula lo que ya existe en el catálogo y crea
lo que falta. Para que lo creado nazca **visible y ordenado**, y para que no se
pierdan artículos, el catálogo necesita estos cuatro cambios en
`pb/pb_hooks/stockflow.pb.js`. Los tres primeros son arreglos que hacen falta
aunque no se use el botón.

Hay un parche de referencia, ya probado contra el catálogo local con la base de
Leo (2.109 artículos → 1.055 vinculados, 1.037 creados, 0 errores, 0 códigos
repetidos). El proyecto del catálogo decide si lo usa o lo hace a su manera:
`docs/para-catalogo/0001-feat-stockflow-carga-total-crear-visible-con-categor.patch`.

## 1. `POST /api/stockflow/articulos`: no recortar en silencio a 500

Hoy hace `body.articulos.slice(0, 500)`. StockFlow da por publicado todo lo que
mandó y avanza su cursor, así que lo que pasa de 500 **no se publica nunca**.

**Pedido:** si llegan más de 500, responder `413 {error, recibidos}` sin
procesar nada. StockFlow ya parte los envíos en tandas de 500.

## 2. `POST /api/stockflow/vincular`: un choque no corta el lote

Hoy, si un código ya está en otro producto, devuelve `409` y **corta**: lo
anterior quedó guardado y lo siguiente no se procesó, sin decir cuál fue cuál.

**Pedido:** que ese choque sea un error **de ese ítem**, en `errores`
(`{sku, motivo: "el código X ya está en el producto Y"}`), y que el lote siga.
Rodear el `$app.save` con try/catch por la misma razón.

## 3. `POST /api/stockflow/articulos`: no pisar el nombre de lo que ya existía

Hoy el espejo sobrescribe `nombre` en cualquier producto vinculado. Al vincular
un producto que Leo ya tenía cargado, su nombre cuidado se reemplaza por el de
StockFlow (normalmente en mayúsculas).

**Pedido:** pisar `nombre` sólo en lo que creó el propio espejo (sku `SF-…`).
Precio, stock, unidad y `activo` se siguen actualizando como hoy.

## 4. `POST /api/stockflow/articulos`: crear visible y en su categoría

StockFlow ahora manda, **sólo al crear** (`crear_faltantes: true`), dos campos
opcionales por artículo:

| Campo | Tipo | Qué es |
|---|---|---|
| `visible` | `true` | el producto nace activo (a la vista) |
| `categoria` | string | el nombre de la familia del artículo en StockFlow ("Varios" si no tiene) |

**Pedido:** con `visible: true`, buscar la categoría por nombre (sin distinguir
mayúsculas); si no existe, crearla **activa**; y crear el producto `activo`
(según el `activo` del artículo) en esa categoría. **Sin** esos campos, el
comportamiento de siempre: oculto en "Sin clasificar".

Mientras esto no esté en producción, el botón funciona igual (vincula y crea),
pero lo nuevo queda **oculto** en "Sin clasificar".
