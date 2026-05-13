# StockFlow — Backlog de mejoras y pendientes

Documento vivo de mejoras propuestas, pendientes técnicos y decisiones diferidas.
Se evalúan en el orden de prioridad listado, pero no son bloqueantes del roadmap principal (P01–P12).

---

## PENDIENTES PROPUESTOS POR ANÁLISIS TÉCNICO

### 🔴 Críticos para venta al mercado

#### 1. Auditoría de acciones (audit_log)
**Problema:** Si un vendedor anula una venta, borra un artículo o modifica un precio, no queda rastro de quién lo hizo.
**Solución:** Tabla `audit_log` registrando usuario + acción + entidad + fecha + valor antes/después en cada operación destructiva.
**Impacto:** Crítico para sistemas con varios empleados. Detecta fraudes, errores y permite responder "¿quién hizo qué?".
**Estimación:** 1 prompt mediano (~1h).

#### 2. Devoluciones parciales (Nota de Crédito parcial)
**Problema:** Hoy `voidSale` anula la venta completa. Si el cliente devuelve 2 de 5 ítems, no se puede.
**Solución:** Generar Nota de Crédito que referencia la venta original con sus propias líneas (subset). Reversa stock + caja solo de los ítems devueltos.
**Impacto:** Falla operativa real. Cualquier comercio lo necesita.
**Estimación:** 1 prompt grande (~2h).

### 🟡 Importantes para usabilidad

#### 3. Multiplicador de cantidad inline en PDV
**Problema:** Para vender 5 unidades hay que escanear 5 veces.
**Solución:** Si se escribe `5*` antes de escanear, agrega 5 unidades directo.
**Impacto:** +30% velocidad percibida en kioscos / despensas.
**Estimación:** 1 prompt corto (~30 min).

#### 4. Búsqueda global Cmd+K (command palette)
**Problema:** Con 5000+ artículos, navegar entre pantallas es lento.
**Solución:** Atajo global `Cmd+K` / `Ctrl+K` abre un buscador unificado que encuentra artículos, clientes, ventas, configuración.
**Impacto:** Mejora drástica con catálogos grandes. cmdk ya está instalado, solo falta usarlo.
**Estimación:** 1 prompt mediano (~1h).

### 🟢 Lindo tener (después de MVP)

#### 5. Historial de precios de artículos
**Problema:** Cuando se cambia un precio, se pierde el anterior.
**Solución:** Tabla `priceHistory` poblada automáticamente al cambiar precios.
**Impacto:** Trazabilidad para auditoría e informes de inflación interna.
**Estimación:** 1 prompt corto (~1h).

#### 6. Notas / observaciones por cliente
**Problema:** Falta campo libre para notas (alergias, advertencias, preferencias).
**Solución:** Campo `notes` text en customers + textarea en el form.
**Impacto:** Bajo costo, alto valor percibido.
**Estimación:** 1 prompt corto (~30 min).

#### 7. Receipt template editable + logo
**Problema:** El ticket de venta está hardcodeado.
**Solución:** Pantalla de configuración con texto editable del encabezado/pie + opción de subir logo.
**Impacto:** Diferencial vendible (cada cliente personaliza su ticket).
**Estimación:** 1 prompt mediano (~1h).

---

## PENDIENTES DEL USUARIO

### Backup automático
**Pedido:** Que el sistema genere backups locales automáticamente.
**Decisión técnica propuesta:** Combinar 3 triggers:
1. Al cerrar caja diaria
2. Al cerrar la app
3. Botón manual "Backup ahora" en Configuración

**Retención propuesta:**
- 7 backups diarios + 4 semanales + 12 mensuales = ~23 archivos máx
- Ubicación default: `~/Documents/StockFlow Backups/`
- Formato: zip con DB SQLite + metadata.json

**Cuándo:** Evaluar antes de salir al mercado. Sin esto, el primer cliente que pierda datos arruina la reputación del producto.

### Scanner por cámara del celular
**Pedido:** Usar la cámara del celular como lector de códigos de barras alternativo (no reemplaza el lector USB).
**Arquitectura propuesta:**
1. Main process levanta servidor HTTP local en puerto secundario
2. App muestra QR con la URL local
3. Usuario escanea QR con el cel → abre página web con cámara
4. Detección de barcode con `@zxing/browser` o `quagga2`
5. Código se envía a la PC vía WebSocket
6. PC lo agrega al carrito como si fuera un scanner USB

**Cuándo:** Junto con P10 (Hardware). Es lógico temáticamente y no retrasa el MVP.

---

## DECISIONES TÉCNICAS DIFERIDAS

### Cobranza CC: por comprobante vs FIFO automático
**Actual:** Cada cobranza se aplica a UN comprobante específico (cliente elige cuál).
**Propuesta futura:** Botón "Cobrar todas las vencidas en orden FIFO" para clientes con muchas facturas pendientes.
**Prioridad:** Baja. Solo si aparece un cliente con 20+ facturas.

### Snapshot Drizzle 0001 sin generar
**Estado:** P07.2 creó la migración 0001 a mano (no via drizzle-kit generate).
**Riesgo:** Próximo `drizzle-kit generate` producirá diff espurio.
**Acción requerida:** Re-basear el snapshot con `drizzle-kit generate --custom` antes del próximo cambio de schema.

### Granularidad Visa/Master/Amex perdida
**Estado:** P07.2 absorbió las tarjetas específicas en el medio "Tarjeta de Crédito".
**Propuesta futura:** Reintroducir `cards` como sub-categoría opcional dentro de `payment_method.type='credit_card'`.
**Prioridad:** Baja. La estadística de "cuál tarjeta se usa más" rara vez se consulta.

### Cards table fantasma
**Estado:** La tabla `cards` quedó en DB pero sin uso activo después de P07.2.
**Riesgo:** Mínimo. Mantiene compatibilidad histórica.
**Acción posible:** Eliminar en una migración futura cuando todas las DBs en producción estén migradas.

### adjustStock audita en article.notes
**Estado:** Los ajustes manuales de stock se anotan en `article.notes` por falta de tabla específica.
**Propuesta futura:** Tabla `stockMovements` con historial completo de cambios de stock (manual, venta, compra, ajuste).
**Prioridad:** Media. Necesario para inventario serio.

---

## FUERA DE SCOPE — NO PROPONER

Las siguientes ideas se evaluaron y se descartaron por no aplicar al mercado objetivo (kioscos, despensas, ferreterías, polirubros argentinos):

- ❌ **Multi-moneda (USD/peso)** — el mercado no lo pide
- ❌ **Cuotas con interés en tarjeta** — MercadoPago Point lo maneja externamente
- ❌ **Programa de fidelidad / puntos** — over-engineering para el público objetivo
- ❌ **Catálogo público / e-commerce** — es otro producto, no esto
- ❌ **App móvil paralela** — confirmado fuera del modelo de licencia

---

## CONVENCIONES DE ESTE DOCUMENTO

- **Categorías:** 🔴 Crítico | 🟡 Importante | 🟢 Lindo tener
- **Cada item incluye:** problema + solución propuesta + impacto + estimación
- **No es un roadmap:** las prioridades pueden cambiar según feedback de clientes reales
- **Update:** después de cada venta a cliente piloto, agregar lo que pidió acá

---

_Última actualización: durante refactor P07.2 (medios de pago configurables)._
