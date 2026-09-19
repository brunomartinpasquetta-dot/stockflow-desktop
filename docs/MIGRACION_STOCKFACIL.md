# Migración StockFácil → StockFlow

Esquema relevado de una base real (`DBPV.GDB`, Firebird ODS 11, páginas de 4 KB).
Sirve para los dos clientes que vienen de StockFácil.

## Mapeo de tablas

| StockFácil | Campos relevantes | StockFlow |
|---|---|---|
| `ARTICULO` | `IDARTICULO`, `CODIGO`, `CODIGO2`, `DETALLE`, `MARCA`, `IVA`, `PRECIO1..PRECIO4`, `PRECIOU`, `CANTIDAD1/2/U`, `CLASIFICACION`, `COLOR`, `FECHAPRECIO` | `articles` |
| `FAMILIA` | `CODIGO`, `DETALLE`, `MARCA`, `PRECIO1` | `families` |
| `PERSONA` | `IDPERSONA`, `APELLIDO`, `NOMBRE`, `DNI`, `DOMICILIO`, `CEL`, `EMAIL`, `CATEGORIA`, `LIMITE`, `IDCIUDAD`, `ESTADO`, `OBSERVA` | `customers` (y `suppliers` vía `PROVEEDOR`) |
| `CLIENTES` | `IDCLIENTES`, `IDPERSONA`, `CODIGO` | discriminador de cliente |
| `PROVEEDOR` | `IDPROVEEDOR`, `IDEMPRESA`, `CODIGO` | `suppliers` |
| `VENTA` | `IDVENTA`, `FECHA`, `HORA`, `NUMERO`, `LETRA`, `TOTAL`, `IVA`, `DESCUENTO`, `FORMAPAGO`, `DETALLEPAGO`, `ESTADO`, `IDCAJA`, `IDCUENTA`, **`CAE`, `CODIGOCAE`, `ESTADOFE`, `CODIGOQ`** | `sales` + `fiscal_vouchers` |
| `LINEAVENTA` | `IDLV`, `IDVENTA`, `IDARTICULO`, `CANTIDAD`, `PRECIO`, `PRECIOI`, `DESCUENTO`, `IVA`, `LIVA`, `COSTO`, `NUMLINEA` | `saleLines` |
| `COMPRA` | `IDCOMPRA`, `FECHA`, `NUMERO`, `LETRA`, `IDPERSONA`, `SUBTOTAL`, `IVA`, `DESCUENTO`, `PERCIIBB`, `PERCIVA`, `IMPINTERNO`, `FORMAPAGO`, `ESTADO` | `purchases` |
| `LINEACOMPRA` | `IDLC`, `IDARTICULO`, `CANTIDAD`, `PRECIO`, `DESCUENTO`, `IVA`, `TOTAL`, `NUMLINEA` | `purchaseLines` |
| `CUENTA` | `CORRIENTE`, `ABIERTA`, `PAGO`, `REMITO` | `accountsReceivable` / `supplierAccountsPayable` |
| `CAJA` | `IDCAJA`, `FECHAINICIO`, `HORAINICIO`, `FECHACIERRE`, `HORACIERRE`, `ARQUEO`, `INGRESO`, `EGRESO`, `DIFERENCIA`, `ESTADO` | `cashRegisters` |
| `LINEACAJA` | `IDLC`, `IDVENTA`, `IDMOVIMIENTOS`, `INGRESO`, `EGRESO`, `TOTAL`, `TIPO`, `MOTIVO`, `DETALLE` | `cashMovements` |
| `MOVIMIENTOS` | `IDMOVIMIENTOS`, `FECHA`, `IDCAJA`, `IDUSUARIO`, `INGRESO`, `EGRESO`, `TOTAL`, `TIPO`, `DETALLE` | `cashMovements` |
| `USUARIO` | `IDUSUARIO`, `IDPERSONA`, `PASS`, `ESTADO`, `DESCUENTO` | `users` (password se re-hashea) |
| `EMPRESA` | `IDEMPRESA`, `RAZON`, `CUIT`, `DOMICILIO`, `INGBRUTOS`, `TIPOIVA`, `TEL`, `CEL`, `CIUDAD` | `companies` + `fiscal_config` |
| `FACTURA` | `IDFACTURA`, `CUIT`, `TOKEN`, `SIGN`, `FECHAINI`, `FECHAFIN`, `ESTADO` | credenciales ARCA (referencia) |

Vistas útiles para exportar (ya vienen con los datos resueltos):
`VARTICULO`, `VCLIENTES`, `VVENTA`, `VLINEAVENTA`, `VCOMPRA`, `VCUENTAS`,
`VCUENTASP`, `VARTVENDIDOS`, `VEMPRESA`, `VPROVEEDOR`, `VCAJA`, `VUSUARIO`.

## Hallazgos que definen la estrategia

1. **Los CAE históricos se pueden migrar.** `VENTA` guarda `CAE`, `CODIGOCAE`,
   `ESTADOFE` y `CODIGOQ`. El cliente conserva su historial fiscal en lugar de
   arrancar de cero — importante para consultas de ARCA y para el contador.

2. **`PERSONA` es la tabla única de personas**; `CLIENTES` y `PROVEEDOR` son
   discriminadores que apuntan a ella. En StockFlow están separadas, así que una
   persona que sea las dos cosas se migra a ambas tablas.

3. **Precios múltiples**: `PRECIO1..PRECIO4` + `PRECIOU`. StockFlow tiene 3
   listas + mayorista. Hay que confirmar con el cliente qué representa cada uno
   (típicamente 1=contado, 2=lista, 3=mayorista, 4=especial).

4. **`FACTURA` guarda TOKEN y SIGN de ARCA**: son credenciales de sesión, no el
   certificado. El `.crt`/`.key` está en el disco del servidor.

5. **Ventas a cuenta corriente (auditoría sep-2026).** `VENTA.IDCUENTA` marca las
   ventas que fueron a la cuenta del cliente: entran como `is_account_sale = 1` y
   NO se repiten en la venta de "saldo anterior" de esa cuenta. `LINEACUENTA.IDLV`
   apunta a `LINEAVENTA`: los renglones que ya viajaron con su venta se saltean. La
   venta sintética sólo lleva lo que las ventas reales no explican (arrastre); si
   todo el total está explicado, la cuenta cuelga de la última venta real.

6. **Cada venta de contado lleva su `sale_payments`** con la forma de pago de
   `VENTA.FORMAPAGO` (`pm_para`), así "Ventas por forma de pago" tiene histórico.

7. **Todo en UNA transacción** con `PRAGMA foreign_key_check` antes del commit:
   si algo falla, la base destino queda vacía, nunca a medias. `COMPRA.NUMERO`
   es texto ("0003-00012345"): se toman los dígitos finales; una compra
   inválida se anota y no frena el resto. El "CONSUMIDOR FINAL" de StockFácil se
   unifica con el de StockFlow. Los números de venta repetidos se renumeran.

## Extracción de la base

StockFácil trae `gbak.exe` y `fbclient.dll` en su carpeta de instalación.

```bat
REM Backup consistente (no copiar el .GDB en caliente)
gbak.exe -b -user SYSDBA -password masterkey C:\ruta\DBPV.GDB C:\backup\stockfacil.fbk

REM Exportar tabla por tabla a CSV
isql.exe -user SYSDBA -password masterkey C:\ruta\DBPV.GDB
SQL> OUTPUT C:\export\articulos.csv;
SQL> SELECT * FROM VARTICULO;
SQL> OUTPUT;
```

> **Nunca copiar el `.GDB` con el sistema abierto**: la base puede quedar
> inconsistente. Siempre `gbak` o con StockFácil cerrado.

## Orden de carga (por dependencias)

```
1. companies (+ fiscal_config con CUIT/IIBB)
2. users
3. families            → self-FK: padres antes que hijos
4. suppliers           → code es NOT NULL UNIQUE: generar si falta
5. articles            → barcode NOT NULL UNIQUE: generar interno si falta
6. customers           → category (RI/MT/CF/EX) es NOT NULL
7. cashRegisters       → sintética para las ventas migradas
8. sales + saleLines + salePayments
9. fiscal_vouchers     → con el CAE histórico
10. accountsReceivable → saldos de cuenta corriente
11. purchases + supplierAccountsPayable
```

## Riesgos a verificar antes de migrar

| Riesgo | Cómo se verifica |
|---|---|
| **Cuál PRECIO es el de venta** | En Leo Citzia `PRECIO1` era el **COSTO** y `PRECIO2` el precio al público. Por eso `migrar` exige decirlo (`PRECIO2`), no asume. Confirmar con `inspeccionar` contra una factura impresa |
| **Con o sin IVA incluido** | StockFácil y StockFlow guardan el precio final (con IVA). Por defecto NO se toca. Sólo si el comercio carga precios netos: `--sin-iva` (se les agrega el IVA). Si se elige mal, TODO queda ~21% corrido |
| CUIT inválidos | Se migran con el tipo de documento de `TIPOCUIT`; el validador de StockFlow los frena recién al editar la ficha |
| Artículos sin código de barras | Se les genera un EAN-13 interno válido (se puede etiquetar y leer) |
| Stock negativo | Se migra **tal cual** (es información real del comercio); `allow_negative_stock` queda en 1 |
| Artículos dados de baja (`VISIBLE=1`, al revés del nombre) | Se migran INACTIVOS, así el listado diario muestra lo mismo que veían |
| Versión de Firebird | La imagen 2.5 abre ODS 10–11. Si no abre (ODS 12 = Firebird 3): `FIREBIRD_IMAGEN=jacobalberty/firebird:3.0` |

## Procedimiento en el local (lo que funcionó con Leo Citzia, ago-2026)

Antes de ir, preguntar: **versión de Windows** de cada PC (Electron no corre en
Windows 7 → esa PC entra por navegador), cuántas PC, si facturan por ARCA con
StockFácil (si sí, el `.crt/.key` está en el disco del servidor y se reutiliza:
copiarlo a `C:\StockFlow\arca\`, nunca a `Program Files`), y qué lista de
precios usan al vender.

1. En el servidor del cliente: **cerrar StockFácil** y copiar su `DBPV.GDB`
   (o `gbak -b`) a un pendrive. Anotar la carpeta de StockFácil (ahí están
   `gbak.exe` y, si facturan, el certificado).
2. Instalar StockFlow (último release público), abrirlo una vez y **activar la
   licencia** (Prueba gratis 30 días → después `apps/cloud/scripts/convertir-a-paga.sh`).
   No hace falta cargar nada: la base vacía que crea es la que se reemplaza.
3. En la Mac: `servidor` → `inspeccionar` → decidir la lista y el IVA con una
   factura impresa → `python3 migrar.py migrar <db-vacía> PRECIO2` (12 s para
   38.852 ventas) → `empaquetar <db>` genera `stockflow-migrado-<fecha>.zip`.
   La base vacía se crea con `tools/migracion/crear-db-vacia.ts` (instrucciones
   en el archivo) o copiando la que dejó la app del cliente al abrirse.
4. En el cliente, cargar la base. **Camino seguro con cualquier versión:** cerrar
   StockFlow, copiar `database/stockflow.db` del zip sobre la ruta que muestra
   Configuración ("Ruta de la base", en `%AppData%\Roaming\@stockflow\desktop\`),
   borrar `stockflow.db-wal`/`-shm` si existen, abrir. **Configuración → Backup →
   Restaurar** hace lo mismo desde la app, pero hasta v1.8.1 pisaba la base SIN
   cerrarla: en Windows falla ("resource busy") y en Mac seguía escribiendo en el
   archivo viejo hasta reiniciar. Desde el commit del 17-sep-2026 el restore
   cierra todo, reemplaza y relanza solo — usar la opción de la app recién cuando
   el cliente tenga esa versión. Verificar después: cantidad de artículos, un
   precio conocido, la deuda de un cliente de cuenta corriente, que cada usuario
   entre con su clave de siempre, y Estadísticas → Vendedores.
   La base migrada puede tener migraciones más nuevas que la app instalada (el
   `todo` la crea con el esquema del repo): drizzle sólo aplica las que faltan,
   así que una app más vieja la abre igual y una más nueva no repite nada.
5. Los medios de pago migrados nacen inactivos: activar los que usan. Las
   ventas viejas cuelgan de la caja "Caja histórica"; abrir la caja del día.
6. ARCA: el punto de venta tiene que ser del sistema "RECE para aplicativo y
   web services" (ver memoria `arca-punto-de-venta-webservices`).

Lo que NO se migra: contraseñas del `admin` de StockFlow (queda `admin`, es la
puerta de soporte), configuraciones propias de StockFácil, el certificado
ARCA (es un archivo, no está en la base), las **notas de crédito y presupuestos**
(StockFácil los guarda en VENTA; no son ventas — se listan en los avisos) y las
"facturas" que nunca tuvieron CAE (entran como comprobante X con la nota de qué
eran: si entraran como A/B/C sin CAE, quedarían como fiscales pendientes con
botón de reintento).

## Dónde encontrar los datos de ARCA en la base vieja

- **Punto de venta y tipo**: `VENTA.CODIGOCAE` es el código de barras del
  comprobante: CUIT (11) + tipo (2: 01=A, 06=B, 11=C, 03/08=NC A/B) + **punto de
  venta (4)** + CAE (14) + vencimiento (8) + dígito. `MIEMPRESA.PUNTO` puede
  estar desactualizado (Denver decía 3 y facturaba por el 4).
- **Número de comprobante**: `VENTA.NROCOMP` (y `ESTADO` repite ese número con
  ceros a la izquierda en las facturadas — no es un estado).
- **Razón social y CUIT**: en el CSR del certificado (`openssl req -in x.csr
  -noout -subject`). `EMPRESA` son los PROVEEDORES, no el comercio; el comercio
  está en `MIEMPRESA` (con el CUIT en la columna EMAIL).
- **Certificado**: `homo.crt` puede ser de PRODUCCIÓN aunque se llame así
  (Denver): mirar el emisor con `openssl x509 -noout -issuer` — "Computadores /
  AFIP" es producción, "Computadores Test" es homologación.
- **Condición IVA actual**: la letra de las últimas facturas con CAE (B → RI;
  C → Monotributo). Un cambio MT→RI se ve como Facturas C en un PV y luego B en
  otro, y explica un PV "viejo" que dejó de servir.

Caso Denver Drugstore (17-sep-2026): `~/Desktop/DENVER-migracion/PARA-EL-PENDRIVE/LEEME-DENVER.txt`.
