#!/usr/bin/env python3
"""
Migración StockFácil (Firebird) → StockFlow (SQLite).

Lee la base del cliente y la vuelca a una base de StockFlow, preservando el
historial completo: artículos, clientes, proveedores, ventas con sus líneas,
compras, cuentas corrientes, cajas y movimientos. Los CAE de las facturas
viejas también se migran, así el comercio conserva su historial ante ARCA.

USO
    # 1) levantar el motor Firebird con la base del cliente (una sola vez)
    python3 migrar.py servidor /ruta/DBPV.GDB

    # 2) mirar qué hay adentro antes de tocar nada
    python3 migrar.py inspeccionar

    # 3) migrar a una base de StockFlow nueva
    python3 migrar.py migrar /ruta/stockflow.db

    # 4) bajar el motor
    python3 migrar.py bajar

La base .GDB NO se modifica: se trabaja siempre sobre una copia.
"""
from __future__ import annotations

import os
import re
import subprocess
import sqlite3
import sys
import time
import uuid
from datetime import datetime, date
from decimal import Decimal

try:
    import firebirdsql
except ImportError:
    sys.exit("Falta el driver: pip3 install firebirdsql passlib")

IMAGEN = "jacobalberty/firebird:2.5-ss"
CONTENEDOR = "stockfacil-migracion"
WORK = "/tmp/stockfacil-migracion"


# ---------------------------------------------------------------- utilidades

def uuid7() -> str:
    """UUID v7 (mismo formato que usa StockFlow: ordenable por tiempo)."""
    ms = int(time.time() * 1000)
    rnd = uuid.uuid4().bytes
    b = ms.to_bytes(6, "big") + bytes([(0x70 | (rnd[6] & 0x0F))]) + rnd[7:16]
    return str(uuid.UUID(bytes=b[:16]))


def dec(v, nd: int = 4) -> str:
    """Decimal como texto, que es como StockFlow guarda la plata."""
    if v is None:
        return "0." + "0" * nd
    if isinstance(v, str):
        v = v.strip().replace(",", ".") or "0"
    try:
        return f"{Decimal(str(v)):.{nd}f}"
    except Exception:
        return "0." + "0" * nd


def ms(fecha, hora=None) -> int:
    """Fecha (+hora opcional) de Firebird a timestamp en milisegundos."""
    if fecha is None:
        return int(time.time() * 1000)
    if isinstance(fecha, datetime):
        d = fecha
    elif isinstance(fecha, date):
        d = datetime(fecha.year, fecha.month, fecha.day)
    else:
        return int(time.time() * 1000)
    if hora is not None:
        try:
            h = str(hora).strip()
            partes = [int(x) for x in re.split(r"[:.]", h)[:3]]
            while len(partes) < 3:
                partes.append(0)
            d = d.replace(hour=partes[0] % 24, minute=partes[1] % 60, second=partes[2] % 60)
        except Exception:
            pass
    return int(d.timestamp() * 1000)


def txt(v, default: str = "") -> str:
    if v is None:
        return default
    return str(v).strip() or default


def letra(v, default: str = "X") -> str:
    """LETRA de StockFácil -> tipo de comprobante de StockFlow (A/B/C/X).

    No viene como una sola letra: son textos tipo "REMITO X", "FACTURA A"."""
    s = txt(v).upper()
    for L in ("A", "B", "C"):
        if s.endswith(" " + L) or s == L or f"FACTURA {L}" in s:
            return L
    return default


def ean13_interno(n: int) -> str:
    """Código de barras EAN-13 válido para un artículo sin código de fábrica.

    Usa el prefijo 2, que el estándar reserva justamente para uso interno del
    comercio. Lleva dígito verificador real, así que cualquier lector lo lee y
    se puede imprimir la etiqueta."""
    base = f"2{n:011d}"[:12]
    suma = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(base))
    return base + str((10 - suma % 10) % 10)


def categoria_iva(v) -> str:
    """CATEGORIA de StockFácil → categoría fiscal de StockFlow."""
    s = txt(v).upper()
    if "RESPONSABLE INSCRIPTO" in s or s in ("RI", "INSCRIPTO"):
        return "RI"
    if "MONOTRIBUT" in s or s == "MT":
        return "MT"
    if "EXENTO" in s or s == "EX":
        return "EX"
    return "CF"


# ------------------------------------------------------------------ contenedor

def servidor(gdb: str) -> None:
    if not os.path.isfile(gdb):
        sys.exit(f"No existe: {gdb}")
    subprocess.run(["docker", "rm", "-f", CONTENEDOR], capture_output=True)
    os.makedirs(f"{WORK}/db", exist_ok=True)
    subprocess.run(["cp", gdb, f"{WORK}/db/base.gdb"], check=True)
    os.chmod(f"{WORK}/db/base.gdb", 0o666)
    print("Copia de trabajo lista (la base original no se toca).")
    subprocess.run([
        "docker", "run", "-d", "--name", CONTENEDOR, "--platform", "linux/amd64",
        "-p", "3050:3050", "-e", "ISC_PASSWORD=masterkey",
        "-v", f"{WORK}/db:/firebird/data", IMAGEN,
    ], check=True, capture_output=True)
    print("Levantando el motor Firebird…")
    for _ in range(40):
        time.sleep(1)
        try:
            conectar().close()
            print("Listo. Ahora: python3 migrar.py inspeccionar")
            return
        except Exception:
            continue
    sys.exit("El motor no respondió. Revisá 'docker logs %s'." % CONTENEDOR)


def bajar() -> None:
    subprocess.run(["docker", "rm", "-f", CONTENEDOR], capture_output=True)
    subprocess.run(["rm", "-rf", WORK], capture_output=True)
    print("Motor bajado y copia temporal borrada.")


def conectar():
    return firebirdsql.connect(
        host="127.0.0.1", port=3050, database="/firebird/data/base.gdb",
        user="SYSDBA", password="masterkey", charset="ISO8859_1",
    )


def q(con, sql: str) -> list:
    cur = con.cursor()
    cur.execute(sql)
    return cur.fetchall()


def tablas(con) -> set[str]:
    """Tablas que existen en ESTA base. El esquema de StockFácil varía entre
    versiones: hay instalaciones sin FAMILIA, sin PROVEEDOR, etc."""
    filas = q(con, "SELECT TRIM(RDB$RELATION_NAME) FROM RDB$RELATIONS "
                   "WHERE RDB$SYSTEM_FLAG=0 AND RDB$VIEW_BLR IS NULL")
    return {str(r[0]).strip().upper() for r in filas}


def columnas(con, tabla: str) -> list[str]:
    filas = q(con, "SELECT TRIM(r.RDB$FIELD_NAME) FROM RDB$RELATION_FIELDS r "
                   f"WHERE r.RDB$RELATION_NAME='{tabla}' ORDER BY r.RDB$FIELD_POSITION")
    return [str(f[0]).strip().upper() for f in filas]


def leer(con, tabla: str, campos: list[str], extra: str = "") -> list[dict]:
    """SELECT tolerante: pide sólo las columnas que existen en ESTA base y
    devuelve dicts (los campos ausentes vienen en None).

    El esquema de StockFácil cambia entre versiones —hay bases sin FAMILIA,
    otras donde PROVEEDOR no tiene IDPERSONA—, así que pedir una columna que
    no está haría fallar toda la migración."""
    hay = set(columnas(con, tabla))
    presentes = [c for c in campos if c in hay]
    if not presentes:
        return []
    orden = extra
    if orden.upper().startswith("ORDER BY"):
        col = orden.split()[2].upper()
        if col not in hay:
            orden = ""          # esa columna no existe acá: se lee sin ordenar
    filas = q(con, f"SELECT {', '.join(presentes)} FROM {tabla} {orden}")
    out = []
    for f in filas:
        d = {c: None for c in campos}
        for i, c in enumerate(presentes):
            d[c] = f[i]
        out.append(d)
    return out


def qn(con, sql: str) -> int:
    try:
        return q(con, sql)[0][0] or 0
    except Exception:
        return 0


# ---------------------------------------------------------------- inspección

def inspeccionar() -> None:
    con = conectar()
    print("=" * 62)
    print("QUÉ HAY EN LA BASE DEL CLIENTE")
    print("=" * 62)
    filas = [
        ("Artículos", "ARTICULO"), ("Familias", "FAMILIA"), ("Personas", "PERSONA"),
        ("Clientes", "CLIENTES"), ("Proveedores", "PROVEEDOR"),
        ("Ventas", "VENTA"), ("Líneas de venta", "LINEAVENTA"),
        ("Compras", "COMPRA"), ("Líneas de compra", "LINEACOMPRA"),
        ("Cuentas corrientes", "CUENTAS"), ("Movs. de cuenta", "LINEACUENTA"),
        ("Pagos de cuenta", "PAGOS"), ("Cajas", "CAJA"),
        ("Movs. de caja", "MOVIMIENTOS"), ("Usuarios", "USUARIO"),
    ]
    hay = tablas(con)
    for etiqueta, tabla in filas:
        if tabla not in hay:
            print(f"  {etiqueta:<22} {'no existe':>8}   (esta versión de StockFácil no la tiene)")
            continue
        print(f"  {etiqueta:<22} {qn(con, f'SELECT COUNT(*) FROM {tabla}'):>8}")

    cae = qn(con, "SELECT COUNT(*) FROM VENTA WHERE CAE IS NOT NULL AND CAE <> ''") if "VENTA" in hay else 0
    print(f"\n  Facturas con CAE de ARCA: {cae}   (se migran, no pierde el historial fiscal)")

    print("\n" + "=" * 62)
    print("REVISAR ANTES DE MIGRAR")
    print("=" * 62)
    sin_cb = qn(con, "SELECT COUNT(*) FROM ARTICULO WHERE CODIGO2 IS NULL OR CODIGO2 = ''")
    print(f"  Artículos sin código de barras: {sin_cb}  -> se les genera uno interno")
    neg = qn(con, "SELECT COUNT(*) FROM ARTICULO WHERE CANTIDAD1 < 0")
    print(f"  Artículos con stock negativo:   {neg}  -> se cargan en 0 y se informan")

    print("\n  PRECIOS — hay que confirmar con el cliente cuál es cuál:")
    for r in q(con, "SELECT FIRST 3 CODIGO, DETALLE, PRECIO1, PRECIO2, PRECIO3, PRECIO4, PRECIOU, IVA FROM ARTICULO"):
        print(f"    {txt(r[0]):<10} {txt(r[1])[:26]:<26} "
              f"P1={r[2]} P2={r[3]} P3={r[4]} P4={r[5]} PU={r[6]} IVA={r[7]}")
    print("\n  >>> Comparar estos precios contra una factura impresa del cliente.")
    print("      Si se elige mal cuál lleva IVA, TODOS quedan ~21% corridos.")
    con.close()


# ----------------------------------------------------------------- migración

class Reporte:
    def __init__(self) -> None:
        self.ok: dict[str, int] = {}
        self.avisos: list[str] = []

    def suma(self, k: str, n: int = 1) -> None:
        self.ok[k] = self.ok.get(k, 0) + n

    def aviso(self, m: str) -> None:
        self.avisos.append(m)

    def imprimir(self) -> None:
        print("\n" + "=" * 62)
        print("RESULTADO")
        print("=" * 62)
        for k, v in self.ok.items():
            print(f"  {k:<26} {v:>8}")
        if self.avisos:
            print("\n  AVISOS:")
            for a in self.avisos[:25]:
                print(f"    - {a}")
            if len(self.avisos) > 25:
                print(f"    … y {len(self.avisos) - 25} más")


def migrar(destino: str, precio_venta: str = "PRECIO1", iva_incluido: bool = True) -> None:
    if not os.path.isfile(destino):
        sys.exit(f"No existe la base destino: {destino}\n"
                 "Instalá StockFlow, abrilo una vez para que cree la base, y pasá esa ruta.")

    con = conectar()
    hay = tablas(con)
    sq = sqlite3.connect(destino)
    sq.execute("PRAGMA foreign_keys=OFF")
    rep = Reporte()
    ahora = int(time.time() * 1000)

    usuario = sq.execute("SELECT id FROM users LIMIT 1").fetchone()
    if not usuario:
        sq.close(); con.close()
        sys.exit("La base destino no tiene usuarios. Abrí StockFlow una vez antes de migrar.")
    uid = usuario[0]

    # ---- FAMILIAS ----
    fam_id: dict[str, str] = {}
    if "FAMILIA" in hay:
        for r in leer(con, "FAMILIA", ["CODIGO", "DETALLE"]):
            nombre = txt(r["DETALLE"]) or txt(r["CODIGO"])
            if not nombre:
                continue
            fid = uuid7()
            sq.execute("INSERT INTO families (id,name,created_at) VALUES (?,?,?)",
                       (fid, nombre[:60], ahora))
            fam_id[txt(r["CODIGO"])] = fid
            rep.suma("Familias", 1)

    # ---- PERSONAS (base de clientes y proveedores) ----
    personas: dict[int, dict] = {}
    if "PERSONA" in hay:
        for r in leer(con, "PERSONA", ["IDPERSONA", "APELLIDO", "NOMBRE", "DNI", "CUIT",
                                       "DOMICILIO", "CEL", "TEL", "EMAIL", "CATEGORIA", "LIMITE"]):
            if r["IDPERSONA"] is not None:
                personas[r["IDPERSONA"]] = r

    def nombre_de(p: dict, alt: str) -> str:
        n = (txt(p.get("APELLIDO")) + " " + txt(p.get("NOMBRE"))).strip()
        return n or alt

    # ---- PROVEEDORES ----
    prov_id: dict[int, str] = {}
    prov_por_persona: dict[int, str] = {}
    if "PROVEEDOR" in hay:
        for i, r in enumerate(leer(con, "PROVEEDOR",
                                   ["IDPROVEEDOR", "IDPERSONA", "IDEMPRESA", "CODIGO",
                                    "NOMBRE", "RAZON", "DETALLE"]), start=1):
            p = personas.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None
            nombre = (txt(r["NOMBRE"]) or txt(r["RAZON"]) or txt(r["DETALLE"])
                      or (nombre_de(p, "") if p else "") or f"Proveedor {i}")
            code = txt(r["CODIGO"]) or f"PROV-{i:04d}"
            pid = uuid7()
            sq.execute(
                "INSERT INTO suppliers (id,code,name,cuit,address,phone,mobile,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (pid, code[:20], nombre[:80],
                 txt(p.get("CUIT") if p else None) or None,
                 txt(p.get("DOMICILIO") if p else None) or None,
                 txt(p.get("TEL") if p else None) or None,
                 txt(p.get("CEL") if p else None) or None, ahora, ahora))
            prov_id[r["IDPROVEEDOR"]] = pid
            if r["IDPERSONA"] is not None:
                prov_por_persona[r["IDPERSONA"]] = pid
            rep.suma("Proveedores", 1)

    # ---- ARTÍCULOS ----
    art_id: dict[int, str] = {}
    barcodes_usados: set[str] = set()
    campos_art = ["IDARTICULO", "CODIGO", "CODIGO2", "INTCOD", "DETALLE", "MARCA", "IVA",
                  "PRECIO1", "PRECIO2", "PRECIO3", "PRECIO4", "PRECIOU",
                  "STOCK", "STOCKMIN", "FAMILIA", "CLASIFICACION", "OBSERVA"]
    for r in leer(con, "ARTICULO", campos_art) if "ARTICULO" in hay else []:
        desc = txt(r["DETALLE"]) or f"Artículo sin descripción #{r['IDARTICULO']}"
        # El código tiene que ser único. En bases reales hay miles de artículos
        # con el mismo CODIGO ('0000', vacío) porque el comercio nunca los
        # numeró: a esos se les da un código interno derivado de su id, así no
        # se pierde ni un artículo.
        # Código de barras: se respeta el del fabricante si lo tiene; si no
        # (acá NINGUNO lo tenía) se genera un EAN-13 interno válido, para que
        # el comercio pueda imprimir etiquetas y usar el lector.
        cand = txt(r["CODIGO2"])
        if not cand or cand in barcodes_usados or set(cand) <= {"0"}:
            cand = ean13_interno(r["IDARTICULO"] or 0)
        barcode = cand
        barcodes_usados.add(barcode)
        stock = r["STOCK"] or 0
        if stock and Decimal(str(stock)) < 0:
            rep.aviso(f"stock negativo en '{desc[:30]}' ({stock}) -> se carga 0")
            stock = 0
        precio = r.get(precio_venta) or r.get("PRECIO1") or 0
        iva = dec(r["IVA"], 2) if r["IVA"] is not None else "21.00"
        neto = precio
        if iva_incluido and precio and Decimal(str(iva)) > 0:
            neto = Decimal(str(precio)) / (1 + Decimal(str(iva)) / 100)
        aid = uuid7()
        try:
            # StockFácil trae hasta 5 precios; StockFlow tiene 3 listas + mayorista
            def sin_iva(v):
                if not v:
                    return dec(0)
                return dec(Decimal(str(v)) / (1 + Decimal(str(iva)) / 100)
                           if iva_incluido and Decimal(str(iva)) > 0 else v)
            sq.execute(
                "INSERT INTO articles (id,barcode,description,brand,family_id,vat_rate,"
                "cost_price,list_price1,list_price2,list_price3,wholesale_price,stock,"
                "active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
                (aid, barcode[:40], desc[:120], txt(r["MARCA"])[:40] or None,
                 fam_id.get(txt(r["FAMILIA"]) or txt(r["CLASIFICACION"])), iva, dec(0),
                 dec(neto), sin_iva(r["PRECIO2"]), sin_iva(r["PRECIO3"]),
                 sin_iva(r["PRECIOU"]), dec(stock, 3), ahora, ahora))
            art_id[r["IDARTICULO"]] = aid
            rep.suma("Artículos", 1)
        except sqlite3.IntegrityError:
            # No debería pasar con el código interno; si pasa, se reintenta.
            try:
                alt = f"INT-{(r['IDARTICULO'] or 0):06d}-{len(art_id)}"
                sq.execute(
                    "INSERT INTO articles (id,barcode,description,brand,family_id,vat_rate,"
                    "cost_price,list_price1,list_price2,list_price3,wholesale_price,stock,"
                    "active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)",
                    (aid, alt, desc[:120], txt(r["MARCA"])[:40] or None,
                     fam_id.get(txt(r["FAMILIA"]) or txt(r["CLASIFICACION"])), iva, dec(0),
                     dec(neto), sin_iva(r["PRECIO2"]), sin_iva(r["PRECIO3"]),
                     sin_iva(r["PRECIOU"]), dec(stock, 3), ahora, ahora))
                art_id[r["IDARTICULO"]] = aid
                rep.suma("Artículos", 1)
            except sqlite3.Error as e:
                rep.aviso(f"no se pudo migrar '{desc[:30]}': {e}")

    # ---- CLIENTES ----
    cli_id: dict[int, str] = {}
    cli_por_persona: dict[int, str] = {}
    if "CLIENTES" in hay:
        for r in leer(con, "CLIENTES", ["IDCLIENTES", "IDPERSONA", "CODIGO"]):
            p = personas.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None
            apellido = nombre_de(p, "") if p else ""
            if not apellido:
                apellido = f"Cliente {r['IDCLIENTES']}"
            lim = p.get("LIMITE") if p else None
            limite = dec(lim if lim and Decimal(str(lim)) > 0 else 0)
            cid = uuid7()
            doc = txt(p.get("CUIT") if p else None) or txt(p.get("DNI") if p else None)
            sq.execute(
                "INSERT INTO customers (id,last_name,first_name,doc_type,doc_number,address,"
                "phone,mobile,email,category,credit_limit,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, apellido[:60], txt(p.get("NOMBRE") if p else None)[:60] or None,
                 ("CUIT" if len(doc.replace("-", "")) == 11 else "DNI") if doc else None,
                 doc or None, txt(p.get("DOMICILIO") if p else None) or None,
                 txt(p.get("TEL") if p else None) or None,
                 txt(p.get("CEL") if p else None) or None,
                 txt(p.get("EMAIL") if p else None) or None,
                 categoria_iva(p.get("CATEGORIA") if p else None), limite, ahora, ahora))
            cli_id[r["IDCLIENTES"]] = cid
            if r["IDPERSONA"] is not None:
                cli_por_persona[r["IDPERSONA"]] = cid
            rep.suma("Clientes", 1)
    sq.commit()

    # ---- CAJA sintética para colgar el historial ----
    caja_id = uuid7()
    nro = (sq.execute("SELECT COALESCE(MAX(number),0) FROM cash_registers").fetchone()[0] or 0) + 1
    sq.execute(
        "INSERT INTO cash_registers (id,number,open_date,close_date,opening_amount,closing_amount,"
        "status,user_id,notes,created_at) VALUES (?,?,?,?,?,?,'closed',?,?,?)",
        (caja_id, nro, ahora, ahora, dec(0), dec(0), uid,
         "Caja histórica (migración desde StockFácil)", ahora))

    cf = sq.execute("SELECT id FROM customers WHERE last_name LIKE '%CONSUMIDOR%' LIMIT 1").fetchone()
    cf_id = cf[0] if cf else (next(iter(cli_id.values()), None))

    # ---- VENTAS ----
    venta_map: dict[int, str] = {}
    campos_v = ["IDVENTA", "FECHA", "HORA", "NUMERO", "LETRA", "TOTAL", "IVA", "DESCUENTO",
                "IDPERSONA", "IDCLIENTE", "ESTADO", "CAE", "CODIGOCAE", "ESTADOFE"]
    for r in leer(con, "VENTA", campos_v, "ORDER BY IDVENTA") if "VENTA" in hay else []:
        total = r["TOTAL"]
        if total is None:
            continue
        cliente = (cli_id.get(r["IDCLIENTE"]) if r["IDCLIENTE"] is not None else None) \
            or (cli_por_persona.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None) \
            or cf_id
        if not cliente:
            rep.aviso("venta sin cliente identificable: se omite")
            continue
        anulada = txt(r["ESTADO"]).upper().startswith("ANUL")
        vid = uuid7()
        fecha = ms(r["FECHA"], r["HORA"])
        iva = r["IVA"] or 0
        neto = Decimal(str(total)) - Decimal(str(iva))
        sq.execute(
            "INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,"
            "is_account_sale,subtotal,discount,vat_amount,total,status,afip_cae,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)",
            (vid, r["NUMERO"] or 0, letra(r["LETRA"]), fecha, cliente, uid, caja_id,
             dec(neto), dec(r["DESCUENTO"]), dec(iva), dec(total),
             "voided" if anulada else "completed", txt(r["CAE"]) or None, fecha, fecha))
        venta_map[r["IDVENTA"]] = vid
        rep.suma("Ventas", 1)

        if txt(r["CAE"]):
            rep.suma("Facturas con CAE", 1)

    art_borrado: str | None = None
    # OJO: en LINEAVENTA la referencia a la venta se llama VENTA, no IDVENTA.
    for r in leer(con, "LINEAVENTA",
                  ["VENTA", "IDVENTA", "IDARTICULO", "CANTIDAD", "PRECIO", "DESCUENTO",
                   "IVA", "NUMLINEA"]) if "LINEAVENTA" in hay else []:
        sid = venta_map.get(r["VENTA"] if r["VENTA"] is not None else r["IDVENTA"])
        if not sid:
            continue
        aid = art_id.get(r["IDARTICULO"])
        if not aid:
            # El artículo se borró del catálogo pero la venta lo incluyó. Se
            # conserva la línea contra un artículo de respaldo, así el detalle
            # de la venta histórica sigue completo.
            if art_borrado is None:
                art_borrado = uuid7()
                sq.execute(
                    "INSERT INTO articles (id,barcode,description,vat_rate,cost_price,"
                    "list_price1,stock,active,created_at,updated_at) "
                    "VALUES (?,?,?,?,?,?,?,0,?,?)",
                    (art_borrado, ean13_interno(999999), "Artículo eliminado en StockFácil",
                     "21.00", dec(0), dec(0), dec(0, 3), ahora, ahora))
                rep.aviso("hay ventas de artículos ya borrados: se conservan con un artículo de respaldo")
            aid = art_borrado
        cant = r["CANTIDAD"] or 0
        precio = r["PRECIO"] or 0
        sq.execute(
            "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,unit_price,"
            "discount,vat_rate,line_total,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (uuid7(), sid, aid, r["NUMLINEA"] or 1, dec(cant, 3), dec(precio), dec(r["DESCUENTO"]),
             dec(r["IVA"], 2) if r["IVA"] is not None else "21.00",
             dec(Decimal(str(cant)) * Decimal(str(precio))), ahora))
        rep.suma("Líneas de venta", 1)

    # ---- COMPRAS ----
    compra_map: dict[int, str] = {}
    algun_prov = next(iter(prov_id.values()), None)
    for r in leer(con, "COMPRA", ["IDCOMPRA", "FECHA", "NUMERO", "LETRA", "PROVEEDOR",
                                  "SUBTOTAL", "IVA", "DESCUENTO", "ESTADO"],
                  "ORDER BY IDCOMPRA") if "COMPRA" in hay else []:
        prov = prov_id.get(r["PROVEEDOR"]) or prov_por_persona.get(r["PROVEEDOR"]) or algun_prov
        if not prov:
            # El comercio puede no haber cargado nunca proveedores (le pasa a
            # quien sólo usa el módulo de ventas). Se crea uno genérico para no
            # perder las compras: después las reasigna si quiere.
            prov = uuid7()
            sq.execute(
                "INSERT INTO suppliers (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)",
                (prov, "PROV-0001", "Proveedor sin identificar (de StockFácil)", ahora, ahora))
            prov_id[-1] = prov
            algun_prov = prov
            rep.aviso("las compras no tenían proveedor: se les asignó uno genérico")
        sub = r["SUBTOTAL"] or 0
        iva = r["IVA"] or 0
        cid = uuid7()
        fecha = ms(r["FECHA"])
        sq.execute(
            "INSERT INTO purchases (id,number,type,date,supplier_id,payment_type,subtotal,"
            "discount,vat_amount,total,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (cid, r["NUMERO"] or 0, letra(r["LETRA"]), fecha, prov, "cash",
             dec(sub), dec(r["DESCUENTO"]), dec(iva),
             dec(Decimal(str(sub)) + Decimal(str(iva))),
             "voided" if txt(r["ESTADO"]).upper().startswith("ANUL") else "completed", fecha, fecha))
        compra_map[r["IDCOMPRA"]] = cid
        rep.suma("Compras", 1)

    for r in leer(con, "LINEACOMPRA",
                  ["COMPRA", "IDCOMPRA", "IDARTICULO", "CANTIDAD", "PRECIO", "DESCUENTO",
                   "IVA", "NUMLINEA"]) if "LINEACOMPRA" in hay else []:
        pid = compra_map.get(r["COMPRA"] if r["COMPRA"] is not None else r["IDCOMPRA"])
        aid = art_id.get(r["IDARTICULO"])
        if not pid or not aid:
            continue
        cant = r["CANTIDAD"] or 0
        precio = r["PRECIO"] or 0
        try:
            sq.execute(
                "INSERT INTO purchase_lines (id,purchase_id,article_id,line_number,quantity,"
                "cost_price,sale_price,vat_rate,line_total,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (uuid7(), pid, aid, r["NUMLINEA"] or 1, dec(cant, 3), dec(precio), dec(precio),
                 dec(r["IVA"], 2) if r["IVA"] is not None else "21.00",
                 dec(Decimal(str(cant)) * Decimal(str(precio))), ahora))
            rep.suma("Líneas de compra", 1)
        except sqlite3.Error:
            pass

    # ---- CUENTAS CORRIENTES (lo que le deben al comercio) ----
    # StockFlow cuelga cada saldo de una venta, pero en StockFácil la cuenta es
    # del cliente y no de un comprobante puntual. Se crea una venta de "saldo
    # anterior" por cada deudor: el saldo queda trazable y el cliente ve de
    # dónde viene en su cuenta.
    nro_saldo = (sq.execute("SELECT COALESCE(MAX(number),0) FROM sales").fetchone()[0] or 0)
    for r in leer(con, "CUENTAS", ["IDCUENTA", "IDCLIENTE", "TOTAL", "SALDO", "FECHAINI"]
                  ) if "CUENTAS" in hay else []:
        saldo = r["SALDO"] or 0
        if Decimal(str(saldo)) <= 0:
            continue
        cliente = cli_id.get(r["IDCLIENTE"]) or cli_por_persona.get(r["IDCLIENTE"])
        if not cliente:
            # El comercio borró la ficha del cliente pero la deuda sigue viva.
            # Se recupera desde PERSONA para no perder plata a cobrar.
            p = personas.get(r["IDCLIENTE"])
            nombre = nombre_de(p, "") if p else ""
            if not nombre:
                nombre = f"Cliente {r['IDCLIENTE']} (dado de baja en StockFácil)"
            cliente = uuid7()
            doc = txt(p.get("CUIT") if p else None) or txt(p.get("DNI") if p else None)
            sq.execute(
                "INSERT INTO customers (id,last_name,first_name,doc_type,doc_number,address,"
                "phone,mobile,email,category,credit_limit,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cliente, nombre[:60], txt(p.get("NOMBRE") if p else None)[:60] or None,
                 ("CUIT" if len(doc.replace("-", "")) == 11 else "DNI") if doc else None,
                 doc or None, txt(p.get("DOMICILIO") if p else None) or None,
                 txt(p.get("TEL") if p else None) or None,
                 txt(p.get("CEL") if p else None) or None,
                 txt(p.get("EMAIL") if p else None) or None,
                 categoria_iva(p.get("CATEGORIA") if p else None), dec(0), ahora, ahora))
            cli_id[r["IDCLIENTE"]] = cliente
            rep.suma("Clientes", 1)
            rep.aviso(f"'{nombre[:34]}' estaba dado de baja pero debe {saldo}: se recuperó")
        try:
            nro_saldo += 1
            vid = uuid7()
            fecha = ms(r["FECHAINI"])
            sq.execute(
                "INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,"
                "is_account_sale,subtotal,discount,vat_amount,total,status,notes,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,'completed',?,?,?)",
                (vid, nro_saldo, "X", fecha, cliente, uid, caja_id,
                 dec(saldo), dec(0), dec(0), dec(saldo),
                 "Saldo de cuenta corriente traído de StockFácil", fecha, fecha))
            sq.execute(
                "INSERT INTO accounts_receivable (id,customer_id,sale_id,total,balance,"
                "status,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?)",
                (uuid7(), cliente, vid, dec(saldo), dec(saldo), fecha, ahora))
            rep.suma("Cuentas corrientes", 1)
        except sqlite3.Error as e:
            rep.aviso(f"cuenta corriente no migrada: {e}")

    sq.commit()
    sq.close()
    con.close()
    rep.imprimir()
    print("\n  La base .GDB del cliente no fue modificada.")


# ---------------------------------------------------------------------- main

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]
    if cmd == "servidor":
        servidor(sys.argv[2] if len(sys.argv) > 2 else sys.exit("Falta la ruta al .GDB"))
    elif cmd == "inspeccionar":
        inspeccionar()
    elif cmd == "migrar":
        if len(sys.argv) < 3:
            sys.exit("Falta la ruta a la base de StockFlow (stockflow.db)")
        precio = sys.argv[3] if len(sys.argv) > 3 else "PRECIO1"
        sin_iva = "--sin-iva" in sys.argv
        migrar(sys.argv[2], precio, iva_incluido=not sin_iva)
    elif cmd == "bajar":
        bajar()
    else:
        sys.exit(__doc__)
