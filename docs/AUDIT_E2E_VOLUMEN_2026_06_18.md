# Auditoría E2E funcional con seeder de volumen — 2026-06-18

> **Tipo:** auditoría de **solo lectura**. No se modificó código de lógica de la app.
> Artefactos creados: `scripts/seed-volume.ts` (seeder + auditor) y este documento.

## Metodología

`scripts/seed-volume.ts` genera ~1 mes de operación en una **DB SQLite temporal y
aislada** (`os.tmpdir()`, **nunca** la del cliente) usando los **servicios y repos
reales** (`@stockflow/core` + `@stockflow/db`) — es decir, los datos pasan por la
lógica de cálculo real. Luego audita comparando:

- **sistema vs manual:** sumas calculadas por el script contra lo que reportan los servicios.
- **sistema vs sistema:** cruces entre endpoints que deben coincidir (p.ej. `getTotalReceivables` vs suma de balances; `assets.total` vs sus componentes).
- **integridad referencial:** consultas SQL directas (`sqlite_master` / FKs).
- **performance:** medición de cada operación con el volumen cargado.

RNG con semilla fija (`20260618`) → corrida reproducible.

### Volumen generado

| Entidad | Cantidad |
|---|---|
| Artículos | 40 (códigos cortos `1..5` + EAN13; Lista 1/2/3; IVA 21/10.5/0; algunos por peso; stock alto/bajo/0) |
| Clientes | 40 (CF + RI con CUIT válido + cuentas corrientes) |
| Proveedores | 10 · Familias | 6 · Usuarios | 3 (admin + 2 cajeros) |
| **Ventas** | **335** (7 anuladas) — mix efectivo/débito/crédito/transferencia, split, a cuenta, con descuento |
| **Compras** | **53** (contado y a cuenta, algunas con `updatePrices`) |
| **Cajas** | **30** (apertura + arqueo + cierre; algunas con transferencia a Caja General; ~3 con diferencia de arqueo) |
| Cobros AR / Pagos AP / Mov. manuales | distribuidos en el mes |
| Actualizaciones masivas de precios | 3 lotes (+10% c/u) |

---

## Resumen ejecutivo

| Severidad | Cantidad |
|---|---|
| 🔴 BLOCKER | **0** |
| 🟠 HIGH | **0** |
| 🟡 MEDIUM | **2** |
| ⚪ LOW | 0 |
| ✅ Checks OK | **26** |

**Conclusión:** el motor de cálculo e integridad es **sólido al volumen probado**.
No se detectaron bugs de cálculo contable, de caja, de cuentas corrientes, de
stock ni de integridad referencial. Los 2 hallazgos MEDIUM son una **consecuencia
contable del feature "permitir stock negativo"** (default ON desde v0.1.33), no un
error de cálculo.

---

## Bugs de cálculo / contabilidad

### BUG-E2E-01 — Valor de inventario NEGATIVO con stock negativo (MEDIUM · Contabilidad/Stock)
- **Descripción:** con `allowNegativeStock` activado (default ON) y artículos
  sobre-vendidos (stock < 0), la valorización de inventario `assets.articlesValue`
  = Σ(stock × costo) **se vuelve negativa**.
- **Esperado vs obtenido:** `articlesValue >= 0` → obtenido **`-3.620.264,0000`**.
- **Reproducir:** vender artículos por encima del stock (permitido por el toggle) y
  abrir `getFinancialSummary` / valorización de inventario.
- **Archivo sospechoso (señalado, NO corregido):** `packages/core/src/services/accounting.service.ts` (`getFinancialSummary` → `assets.articlesValue`) y `reports.service.ts` (valorización). Suman `stock × costPrice` sin pisar en 0 los stocks negativos.
- **Nota:** la magnitud está **amplificada** por el sobre-vendido sintético del seeder (elige artículos al azar sin mirar stock). En uso real el efecto es menor, pero el fenómeno es real.

### BUG-E2E-02 — Activos totales NEGATIVOS (MEDIUM · Contabilidad)
- **Descripción:** consecuencia directa de BUG-E2E-01 — `assets.total` (inventario + cajas + Caja General) queda negativo cuando el inventario valorizado es muy negativo.
- **Esperado vs obtenido:** `assets.total >= 0` → obtenido **`-2.888.823,0000`**.
- **Nota:** `assets.total` **SÍ es internamente consistente** (= articlesValue + cashRegistersValue + cashGeneralValue ✓); el problema es el componente de inventario (BUG-E2E-01).

**Recomendación para ambos:** al valorizar inventario para activos, **pisar el stock
negativo en 0** (o excluirlo) y/o mostrar un aviso de "artículos con stock negativo"
en el resumen contable. Decisión de negocio: ¿el faltante (stock negativo) debe
restar valor de activo o tratarse como 0? Hoy resta, distorsionando los activos.

## Bugs de integridad
**Ninguno.** (Ver "Áreas sin problemas".)

## Bugs de performance
**Ninguno.** Todas las operaciones < 15 ms con el volumen cargado:

| Operación | Tiempo |
|---|---|
| Listar artículos (40) | 1 ms |
| Historial de ventas (335) | 1 ms |
| Dashboard analytics (top productos) | 2 ms |
| Resumen financiero (contabilidad) | 14 ms |
| Libro IVA Ventas | 9 ms |
| Búsqueda de artículos | 0 ms |

> Nota: el volumen ("1 mes" de un comercio chico = 335 ventas / 40 artículos) es
> moderado. No se observan N+1 ni cargas que no escalen a este nivel. Para escalas
> mayores (miles de artículos / decenas de miles de ventas), re-auditar.

---

## Áreas verificadas SIN problemas (confianza)

**Ventas** — Σ totales no anulados (sistema = manual, exacto); ventas anuladas NO
suman; `vatAmount ≤ total` y `total ≥ 0` en las 335; volumen ≥ 300. ✓

**Caja diaria** — en las 30 cajas, `expectedCash = apertura + neto del medio
efectivo` (los medios no-efectivo no afectan el cajón); arqueo/diferencia correctos. ✓

**Caja General** — `balance = Σ movimientos` exacto (sin dinero duplicado — el
**bug histórico S01 sigue resuelto**); cuadra con las transferencias desde cajas. ✓

**Cuentas corrientes clientes (AR)** — `getTotalReceivables = Σ` balances; saldos por
cliente = (ventas a cuenta − cobros) del tracking manual. ✓

**Cuentas corrientes proveedores (AP)** — saldos por proveedor = (compras a cuenta −
pagos) del tracking manual. ✓

**Stock** — en 15 artículos muestreados, `stock = inicial − vendido + comprado`
(exacto, incluyendo descuentos por venta y reposición por compra). ✓

**Contabilidad** — `ventas.total` del summary = ventas no anuladas del reporte;
`grossResult = ventas − CMV`; `vatPosition = IVA débito − IVA crédito`;
`assets.total = inventario + cajas + Caja General` (consistente). ✓

**Libro IVA** — Σ IVA del Libro de Ventas (no anuladas) = IVA débito del resumen. ✓

**Precios** — los 3 lotes de actualización masiva quedaron registrados (con rollback disponible). ✓

**Integridad referencial** — sin `sale_lines` con `article_id` huérfano; sin
`sale_payments` sin venta; **las ventas anuladas NO conservan `sale_payments`**; sin
movimientos de caja con caja inexistente. ✓

---

## Recomendaciones priorizadas

1. **(MEDIUM) Valorización con stock negativo** — pisar en 0 el stock negativo al
   calcular `articlesValue`/activos, o excluirlo y mostrar un aviso. Evita activos
   e inventario negativos en el resumen contable cuando se vende a descubierto.
2. **(LOW) Visibilidad de faltantes** — un reporte/listado de "artículos con stock
   negativo" ayuda al comercio a regularizar el inventario.
3. **(INFO) Re-auditar a mayor escala** — este volumen no estresa performance;
   conviene repetir con miles de artículos/ventas antes de clientes grandes.

## Limitaciones conocidas de esta auditoría

- Las ventas/compras se registran con **fecha actual** (el repo timestamp = `now`),
  no distribuidas en 30 días reales — no afecta los cálculos de totales/saldos/stock,
  pero sí los reportes por rango de fechas finos (no auditados aquí).
- El sobre-vendido es **sintético** (el seeder no mira stock al elegir líneas), lo
  que amplifica BUG-E2E-01/02 respecto del uso real.
- Ejecución local: requirió compilar `better-sqlite3` para el ABI de Node y luego
  **restaurarlo al ABI de Electron** (hecho). Para correr el seeder: compilar
  better-sqlite3 para Node, luego `apps/desktop/node_modules/.bin/tsx scripts/seed-volume.ts`,
  y restaurar con `pnpm --filter @stockflow/desktop run rebuild:native`.

## Cómo correr el seeder

```bash
# 1) (en un entorno con better-sqlite3 para Node, p.ej. CI o tras `pnpm rebuild better-sqlite3`)
apps/desktop/node_modules/.bin/tsx scripts/seed-volume.ts
# 2) imprime el reporte a stdout; corre contra una DB temporal aislada (os.tmpdir)
```

---

*Auditoría de solo lectura. NO se modificó código de la app (services/repos/componentes).
Solo se crearon `scripts/seed-volume.ts` y este documento.*
