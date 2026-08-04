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
| **Modo de precios** (con o sin IVA incluido) | Comparar una factura impresa contra el precio del artículo. Si se elige mal, TODOS los precios quedan ~21% desviados |
| CUIT inválidos | El validador de StockFlow verifica dígito verificador; listar los que fallen y cargarlos sin documento |
| Artículos sin código de barras | Generar código interno (`INT-000001`) antes de importar |
| Stock negativo | StockFlow no lo acepta en la carga: se lleva a 0 y se informa |
| `suppliers.code` faltante | Generar `PROV-0001` con secuencia estable |
