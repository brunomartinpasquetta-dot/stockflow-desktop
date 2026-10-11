# Dólares en StockFlow — propuesta

**Estado: PROPUESTA, nada implementado.** Pedido de Bruno (10-oct-2026): «activar precios
costo y precios venta de artículos en dólares, caja diaria con dólares también y Caja
General; una opción que se active, que no venga por defecto; analizá con los agentes
necesarios y armá la idea, no hagas nada aún».

Cómo se armó: cuatro lecturas independientes del código (precios, cajas, fiscal e
integraciones, y cómo se hacen las opciones apagadas), más el manual oficial de ARCA
WSFEv1 v4.0 (marzo 2025) leído para lo fiscal. Todo lo que se afirma del código tiene
archivo y línea.

---

## 1. La idea en una página

**Qué se guarda en dólares:** el costo y, si se quiere, las listas de venta del artículo
que el comercio marque como «en dólares». **Qué se vende, se factura y se contabiliza:
siempre pesos.** El dólar es el *origen* del precio, no la moneda de la operación.

**La regla de oro:** el precio en pesos se calcula al cargar la cotización del día, en
bloque, como un lote de «Actualización de precios» (con vista previa, historial y vuelta
atrás, que ya existen). Al vender, el sistema no convierte nada: vende el peso que ya
está en el artículo. Así **no se toca** Ventas, el ticket, ARCA, los Libros IVA, el
resumen contable, Estadísticas, Mercado Pago ni el catálogo web.

**La caja en dólares es dinero físico aparte:** un medio de pago «Dólares». Cada cobro en
dólares guarda el *equivalente en pesos* (lo que suman todos los reportes), más los
dólares entregados y la cotización del momento. La caja diaria arquea pesos y dólares por
separado, el cambio que queda para mañana se pregunta en las dos monedas, y la Caja
General tiene un **saldo en dólares propio que nunca se suma a los pesos**.

**Todo detrás de un interruptor del comercio**, apagado por defecto: con la opción
apagada no aparece ni un campo nuevo y el sistema se comporta exactamente como hoy.

Un dato que cambia una decisión previa: `BACKLOG.md:123` dice «Multi-moneda — FUERA DE
SCOPE, el mercado no lo pide». Este pedido lo contradice; hay que sacarlo de ahí.

---

## 2. Qué hay hoy (verificado)

- **No existe ninguna noción de moneda en el sistema.** Ni en artículos, ni en ventas,
  ni en cajas, ni en Caja General (`packages/db/src/schema/local.ts`). Lo único que dice
  «moneda» es el QR fiscal, fijo en `PES`. (El «cotización» de Presupuestos significa
  presupuesto, no tipo de cambio.)
- **Los precios del artículo** son `cost_price`, `list_price1..3`, `wholesale_price` y los
  márgenes `margin1..3` (local.ts:175-189). El precio de venta lo resuelve la pantalla
  (`src/lib/pricing.ts`) y el servidor acepta el que le mandan (`sales.service.ts:171`).
- **Más de 15 consultas SQL** suman `cost_price`/`list_price` como pesos: Estadísticas,
  valorización de stock, CMV, resumen contable (`analytics.service.ts`,
  `reports.service.ts`, `accounting.service.ts`).
- **La actualización masiva de precios ya tiene lote, vista previa, historial y vuelta
  atrás** (`priceUpdate.service.ts`, tablas `price_update_batches/entries`). Es la pieza
  que hace barato el camino elegido.
- **El dinero físico se reconoce por el medio de pago** (`isPhysicalCash`), y esa regla
  está copiada en **11 lugares** (cierre, arqueo, depósito, reportes, Flowy). Hoy el
  sistema tiene UNA bolsa de efectivo.
- **ARCA va fijo en pesos**: `MonId=PES`, `MonCotiz=1` (`WsfeClient.ts:350`). El XML es
  posicional (ya nos costó una vez con la condición de IVA).
- **El catálogo web publica `list_price1/2/3` crudo** y sólo republica lo que cambió
  `updated_at` (`catalogo.repository.ts:136-163`). **Mercado Pago cobra sólo en pesos.**
- **El interruptor de comercio** ya tiene patrón: `companies.allowNegativeStock`
  (local.ts:64), checkbox en Mi Empresa, validado por zod, y llega solo a terminales y
  acceso remoto porque `company` está en `LAN_ROUTED_GROUPS`.
- **El Paranacito:** la armería tiene precios en dólares que la migración cargó como
  pesos (quedaron afuera de la carga del catálogo por eso). Antes de activar la opción
  ahí hay que revisar esos artículos uno por uno; si se los marca como USD sin revisar,
  se multiplican por la cotización dos veces o ninguna.

---

## 3. Los dos caminos para los precios, y por qué elijo uno

| | (a) Guardar en USD y convertir al vender | (b) Guardar el USD como origen y recalcular los pesos en bloque |
|---|---|---|
| Ventas, ticket, ARCA, libros, CMV, estadísticas, catálogo, MP | **Hay que tocar todo** (15+ consultas; el costo de la venta quedaría en dólares y el margen histórico se rompe para siempre) | **No se tocan.** Siguen leyendo pesos |
| Dos cajas cobran distinto el mismo artículo | Posible: cada PC convierte con su caché de cotización | No: el peso está en el artículo, igual para todas |
| Catálogo web | No se entera cuando cambia el dólar (el precio «cambia» sin tocar `updated_at`) | El lote toca `updated_at` → republica solo |
| Si se apaga la opción | Se rompen todos los precios | Los pesos quedan como estaban |
| Debilidad | — | Si nadie recarga la cotización, se sigue vendiendo con la vieja → **hace falta un aviso visible** |

**Elijo (b).** El (a) es más «elegante» y es una trampa: convierte un cambio de producto
en una reescritura de todo lo que suma dinero.

---

## 4. Diseño

### 4.1 El interruptor (del comercio, no de una PC)

- `companies.usd_enabled integer NOT NULL DEFAULT 0` (migración nueva). El `DEFAULT 0`
  es lo que deja apagados a todos los clientes que ya existen.
- Campo en `CompanySchema` y en `companyBase` de zod (si no, zod lo descarta en silencio
  — ya pasó con proveedores).
- Checkbox en **Mi Empresa**, al lado de «Permitir vender sin stock»: «Trabajar también con
  dólares». Lo cambia sólo el admin (`manage_company`).
- Cada pantalla mira `useCompany().data?.usdEnabled`, igual que Estadísticas mira
  `catalogoUrl` para mostrar la pestaña del catálogo. **Apagado, no cambia un píxel.**
- El servidor vuelve a chequear la opción y rechaza campos en USD si está apagada: no
  alcanza con que la pantalla los esconda.
- **No se ata al plan de licencia**: la app de escritorio hoy no lee `PLAN_FEATURES` (sólo
  existe en la nube, y en desarrollo/maestra/navegador el plan es «pro» fijo). Si Bruno
  quiere cobrarlo, es un control aparte encima de esta misma columna.

### 4.2 La cotización

- Tabla `cotizaciones` (fecha, valor, quién la cargó, origen: manual/ARCA, created_at).
  **Con historial**, no una columna que se pisa: cada venta y cada movimiento guardan la
  cotización que usaron; sin eso no se puede reconstruir a qué dólar se vendió ni cuadra un
  arqueo viejo.
- **Fuente:** a mano por el comercio (su dólar, el que decida), con un botón «Traer la
  oficial» que llama a `FEParamGetCotizacion` de ARCA (devuelve el BNA vendedor del día
  hábil anterior; pide `MonId` y opcionalmente `FchCotiz`). Esto no requiere facturar en
  dólares: es sólo una consulta con el certificado que ya tienen.
- **Permiso propio** `manage_exchange_rate` en el área «artículos», junto a
  `manage_prices`: lo tienen admin y encargado, el vendedor no. (Con `manage_company` sólo
  el admin podría y el encargado que abre a la mañana quedaría trabado; con `create_sale`
  cualquier vendedor cambiaría todos los precios.)
- **Aviso visible** en la barra de estado: «Dólar $1.250 · cargado hace 3 días» y, si hay
  artículos USD cuyo peso quedó atrás, «hay precios sin recotizar».

### 4.3 Precios de artículos

- Columnas nuevas en `articles`, todas nullable: `price_currency` ('ARS' por defecto),
  `cost_usd`, y opcionalmente `list_usd1..3` y `wholesale_usd`. **Las columnas de hoy
  siguen siendo pesos y lo único que se vende.**
- **Recotizar** = una regla nueva de `priceUpdate.service` («por cotización»): para cada
  artículo USD, `costo$ = costo USD × cotización`, y las listas desde su USD o, si no lo
  tienen, desde `margin1..3` (la regla «la utilidad manda» que ya usan Compras y la ficha),
  con redondeo **en pesos y siempre partiendo del USD** (nunca del peso anterior, o el
  error se acumula). Se aplica como lote: trae vista previa, historial y `rollbackBatch`
  gratis, y al tocar `updated_at` el catálogo republica solo.
- **Ficha del artículo:** selector de moneda y carga en USD con el equivalente en pesos al
  lado. **Sin redondear a peso entero** cuando es USD (hoy `Articulos.tsx:1066` y
  `Compras.tsx:302` redondean con `Math.round`: US$ 12,40 pasaría a 12).
- **Compras:** si el artículo es USD, la compra actualiza el **costo en USD** y de ahí los
  pesos. Si no se adapta, la próxima recotización deshace la compra (pisa el costo nuevo
  con el USD viejo × cotización). Vale también para las facturas por teléfono.
- **Promos:** el precio del espejo es fijo en pesos. Si los componentes son USD y suben,
  la promo vende con pérdida: **aviso** cuando queda por debajo del costo (recalcularla es
  una decisión aparte).
- **Presupuestos:** quedan congelados en pesos como hoy (ya era así).
- **Importador Excel y migrador:** columna opcional «Moneda»/«Costo USD». Segunda tanda.

### 4.4 Caja diaria y Caja General en dólares

- **Medio de pago «Dólares»**: `type='cash'`, `isPhysicalCash`, y una columna nueva
  `payment_methods.currency` ('ARS' por defecto). Al cobrar con él se carga cuántos
  dólares entrega el cliente y la cotización del momento.
- **En cada pago y movimiento** (`sale_payments`, `cash_movements`): `amount` sigue siendo
  el **equivalente en pesos** (lo que suman los más de 30 lugares que reportan dinero), y
  al lado `currency`, `amount_currency` (los USD) y `exchange_rate`. La anulación **copia**
  esos campos tal cual; nunca recotiza (si no, el reverso no cierra con el ingreso).
- **Una sola función `bolsaDe(mov, medio)`** en `packages/shared` que devuelve
  `efectivo_ars` | `efectivo_usd` | `electronico` y reemplaza los 11 chequeos de
  `isPhysicalCash` copiados. `netoElectronico` y `totalParaCajaGeneral` la usan para dejar
  afuera los dólares (si no, se depositarían como «electrónico»).
- **Caja diaria:** `opening_amount_usd`, `closing_amount_usd`, `change_left_usd`
  (nullable). Arqueo en USD = apertura + entradas − salidas en `amount_currency`. El
  cierre en dos pasos pregunta el cambio y el contado **en las dos monedas**; la apertura
  siguiente propone las dos.
- **Caja General:** `usd_balance` **fuera de `current_balance`**. El cierre deposita
  `contado USD − cambio USD` con su propio tope (`DEPOSIT_OVER_USD`). Los dólares se
  muestran como «USD 1.200»; **no se valorizan en pesos** salvo donde Bruno lo pida
  explícitamente (ver decisiones).
- **Vuelto:** el cliente paga US$ 100 una venta de $95.000 con el dólar a 1.000 y recibe
  $5.000. Si no se registra la salida en pesos, el arqueo de pesos da sobrante. Propuesta:
  el pago en USD por el total y un egreso automático «Vuelto en pesos» por la diferencia.
- **Cuidado real:** hay «buscadores del primer medio efectivo» sin orden
  (`return.repository.ts:294-298`, etc.). Con un segundo medio físico, una devolución
  podría salir en dólares. Hay que filtrar por `currency='ARS'` en los 9 lugares.
- **Flowy** («¿cuánto hay en caja?») contesta pesos y dólares.

### 4.5 Lo que queda SIEMPRE en pesos (y por qué)

| Qué | Por qué |
|---|---|
| La venta, el ticket y la factura (ARCA `PES/1`) | El precio ya está en pesos en el artículo. Facturar en DOL es otro proyecto (ver §6). |
| Libros IVA ventas y compras, posición de IVA | El IVA se liquida en pesos; un renglón en USD arruina el libro del contador. |
| Resumen contable, valorización de stock, CMV | Suman `cost_price`, que sigue en pesos. (El CMV usa el costo *actual*, no `cost_at_sale`; con el dólar moviéndose conviene corregir eso, pero es otro pendiente.) |
| Caja General `current_balance` | Si entran dólares valorizados a cotizaciones viejas, el total nunca coincide con la realidad. |
| Mercado Pago | Cobra sólo en pesos. |
| Catálogo web | Publica el peso ya recalculado; republica solo al recotizar. |

---

## 5. Etapas (lo mínimo que ya sirve primero)

**Etapa 1 — Precios en dólares** (la que resuelve a Paranacito)
1. Migración: `usd_enabled`, tabla `cotizaciones`, `price_currency` + `cost_usd` (+ listas USD).
2. Checkbox en Mi Empresa + permiso `manage_exchange_rate`.
3. Cotización: pantalla para cargarla (a mano o «Traer la oficial» de ARCA) + aviso en la barra.
4. Ficha del artículo con moneda y USD.
5. «Actualizar cotización» en Actualización de Precios (lote, vista previa, vuelta atrás).
6. Compras actualizando el costo en USD.
7. Revisión de la armería de Paranacito ya migrada.

**Etapa 2 — Caja en dólares**
8. `bolsaDe()` y reemplazo de los 11 chequeos (sin cambio funcional: se prueba que da lo mismo).
9. Medio «Dólares» + campos de moneda en pagos y movimientos + vuelto en pesos.
10. Arqueo, cambio y cierre en dos monedas; impresos del cierre.
11. `usd_balance` en Caja General + depósito automático en USD + tope.
12. Flowy, Historial de cajas, resumen contable mostrando USD aparte.

**Etapa 3 — Después, si hace falta**
- Importador Excel y migrador con moneda. Compras y pagos a proveedores en USD. Compra y
  venta de divisa dentro de Caja General. Presupuestos en USD. Facturar en DOL (§6).

**Tamaño honesto:** la etapa 1 son unos 3 días con pruebas; la etapa 2 otros 3 a 4, y es la
que más riesgo de descuadre tiene (por eso va segunda y arranca por `bolsaDe()` sin cambiar
nada). En cada etapa: baterías + ventana real + instalado en la Mac antes de publicar.

---

## 6. Facturar EN dólares (lo que dice ARCA, por si algún día se pide)

Del manual WSFEv1 v4.0 (17/03/2025), leído, no de memoria:

- `MonId=DOL` + `MonCotiz` del día. La cotización **no la decide el comercio**: ARCA la
  da con `FEParamGetCotizacion` (BNA vendedor, día hábil anterior). Si se manda otra,
  rechaza: no puede superar la oficial en más de 1 (error 10240) ni salirse de −2 % /
  +400 % (10119).
- Campo nuevo `CanMisMonExt` (S/N): si el cliente paga **en la misma moneda** (dólares),
  la cotización tiene que coincidir **exactamente** con la de ARCA; si paga en pesos, N.
  Si `MonId=PES` el campo **no** debe informarse (10241). Y `MonCotiz` es obligatorio
  salvo con `CanMisMonExt=S` (10038).
- Todos los importes del comprobante (`ImpTotal`, `ImpNeto`, `ImpIVA`, alícuotas) van en
  dólares; el QR lleva moneda `DOL` y la cotización; el Libro IVA Digital pide el importe en
  pesos más el tipo de cambio. El XML es posicional: `MonId`, `MonCotiz`, `CanMisMonExt`,
  `CondicionIVAReceptorId`, asociados…
- El «dólar del mostrador» (billete/blue) **no es** el que acepta ARCA. Facturar en DOL
  obliga a dos cotizaciones distintas conviviendo.

Conclusión: es un proyecto aparte, para un cliente que lo necesite de verdad. No entra acá.

---

## 7. Decisiones que le tocan a Bruno

1. **Qué se carga en dólares:** ¿sólo el costo (y la venta sale de la utilidad % que ya
   existe), o también las listas de venta en USD? Para Paranacito: ¿el proveedor les
   factura en USD y ellos ponen el precio en USD, o sólo el costo?
2. **Qué dólar:** ¿uno solo del comercio, cargado a mano? ¿Con el botón «Traer la oficial»
   de ARCA como ayuda? ¿Blue/MEP de alguna fuente externa?
3. **Quién lo cambia:** admin y encargado (propuesto), o sólo admin.
4. **Al cambiar la cotización:** ¿se recalcula solo al guardarla, o se muestra la vista
   previa y el comercio confirma (propuesto: vista previa, como Actualización de precios)?
5. **Si nadie cargó la cotización hoy:** ¿se usa la de ayer con aviso (propuesto), o se
   bloquea la venta de artículos en USD?
6. **Redondeo en pesos** de los artículos USD: ¿a peso entero, a $10, a $100, terminado en
   99? ¿Global o por familia?
7. **Listas sin utilidad y mayorista** en un artículo USD: ¿suben en la misma proporción
   que la cotización o quedan fijas?
8. **Promos con componentes USD:** ¿aviso cuando queda bajo el costo (propuesto) o
   recalcular el precio de la promo?
9. **Caja en dólares:** ¿el cliente paga con billetes de dólar (arqueo en dos monedas,
   vuelto en pesos) o sólo quieren ver la caja expresada también en dólares? Son dos
   funciones muy distintas; la propuesta asume la primera.
10. **Vuelto:** ¿siempre en pesos (propuesto), o puede recibir vuelto en dólares?
11. **Caja General:** ¿los dólares se muestran sólo como «USD x» (propuesto) o también
    valorizados en pesos al dólar de hoy? ¿Entran al «efectivo total» del resumen contable?
12. **Compra/venta de divisa** dentro de Caja General (cambiar pesos por dólares sin que sea
    ingreso ni egreso): ¿hace falta?
13. **Compras y pagos a proveedores en dólares:** ¿etapa 3, o antes?
14. **Apagar la opción con datos en USD cargados:** ¿se bloquea hasta dejar todo en cero, o
    se avisa y se esconde?
15. **Ticket:** ¿muestra algo en USD («US$ 120 × 1.250») o sólo pesos?
16. **Paranacito:** ¿cómo identificamos qué artículos de la armería son en dólares (una
    familia, una lista que pasen ellos)? ¿Se corrige la base ya migrada o se cargan a mano?
17. **Plan:** ¿va para todos o se vende como parte del Pro? (Si es Pro, es un control aparte.)
18. **`BACKLOG.md:123`:** sacar «Multi-moneda» de FUERA DE SCOPE.

---

## 8. Riesgos que hay que tener presentes al implementar

- **Mezclar monedas en una suma** es el riesgo número uno y es silencioso: por eso `amount`
  siempre en pesos y los dólares en columnas aparte, y por eso `bolsaDe()` antes que
  cualquier otra cosa en la etapa 2.
- **Redondear partiendo del peso anterior** acumula error en cada recotización: siempre
  desde el USD.
- **Vuelta atrás de un lote** después de una compra: `rollbackBatch` pisa el costo de la
  compra con el viejo. Ya pasa hoy con cualquier lote; con recotizaciones frecuentes va a
  pasar más. Aviso en la vuelta atrás si hubo compras posteriores.
- **Terminales con caché vieja** (30 s): la opción recién prendida o la cotización nueva
  tardan en verse. Con los pesos ya en el artículo, dos puestos nunca cobran distinto.
- **El esquema posicional de ARCA**: cualquier cosa fiscal que se toque, con la prueba
  `fiscal-xml` delante.
