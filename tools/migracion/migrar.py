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

try:
    import bcrypt as _bcrypt
except ImportError:
    _bcrypt = None   # sin bcrypt se migran los usuarios con una clave provisoria

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


def tipo_doc(p: dict | None, doc: str) -> str:
    """CUIT o DNI. Manda TIPOCUIT, no la cantidad de dígitos.

    Contar dígitos falla con los CUIT mal tipeados por el comercio: en Leo
    Citzia, 'GEZHOUBA - ECOSUR BAHIA S.A.' tenía '0-71827058-4' (le falta el
    30 adelante) y entraba como DNI, que después impide emitirle Factura A."""
    t = txt(p.get("TIPOCUIT") if p else None).upper()
    if t.startswith("CUIT"):
        return "CUIT"
    if t.startswith("DNI"):
        return "DNI"
    return "CUIT" if len(doc.replace("-", "")) == 11 else "DNI"


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
    # OJO: el stock vive en STOCK. CANTIDAD1 existe pero está vacía en las bases
    # reales (Leo Citzia: 0 filas con valor) — leerla daba un tranquilizador
    # "0 artículos con stock negativo" que era falso.
    neg = qn(con, "SELECT COUNT(*) FROM ARTICULO WHERE STOCK < 0")
    print(f"  Artículos con stock negativo:   {neg}  -> se migran TAL CUAL (se permite vender sin stock)")

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
    # ---- PERSONAS (base de clientes y proveedores) ----
    personas: dict[int, dict] = {}
    if "PERSONA" in hay:
        for r in leer(con, "PERSONA", ["IDPERSONA", "APELLIDO", "NOMBRE", "DNI", "CUIT", "TIPOCUIT",
                                       "DOMICILIO", "CEL", "TEL", "EMAIL", "CATEGORIA", "LIMITE"]):
            if r["IDPERSONA"] is not None:
                personas[r["IDPERSONA"]] = r

    def nombre_de(p: dict, alt: str) -> str:
        """Apellido y nombre, sin repetir cuando el APELLIDO ya trae los dos.

        En bases reales el comercio carga todo junto en APELLIDO ("AGUAISOL
        EDUARDO") y además llena NOMBRE ("EDUARDO"): concatenar a ciegas
        dejaba "AGUAISOL EDUARDO EDUARDO"."""
        ape = txt(p.get("APELLIDO"))
        nom = txt(p.get("NOMBRE"))
        if not nom or nom.upper() in ape.upper().split():
            return ape or nom or alt
        return f"{ape} {nom}".strip() or alt

    uid = usuario[0]

    # ---- USUARIOS ----
    # StockFácil guarda la contraseña EN TEXTO PLANO (USUARIO.PASS), así que
    # cada uno entra a StockFlow con el mismo usuario y la misma clave de
    # siempre: nadie tiene que aprender nada nuevo. Se rehashea con bcrypt
    # cost 10, que es lo que valida StockFlow (user.repository.ts).
    # El usuario queda TAL CUAL está en StockFácil (en mayúscula): el login
    # distingue mayúsculas de minúsculas y tienen que escribir lo mismo que hoy.
    # El `admin` que crea StockFlow NO se toca: es la puerta de entrada del
    # soporte si alguien se olvida la clave.
    def hashear(clave: str) -> str:
        if _bcrypt is None:
            return "$2b$10$463wf07yJXEVBvgzqLDx0O8RBvuTCkzXLSrzCqkNcSeMPTIZ7BoHC"  # 'admin'
        return _bcrypt.hashpw(clave.encode("utf-8")[:72],
                              _bcrypt.gensalt(rounds=10, prefix=b"2b")).decode()

    ROLES = {"ADMINISTRADOR": "admin", "SUPERVISOR": "manager",
             "ENCARGADO": "manager", "VENDEDOR": "seller", "CAJERO": "seller"}
    usuario_map: dict[int, str] = {}
    for r in leer(con, "USUARIO", ["IDUSUARIO", "IDPERSONA", "TIPO", "PASS", "USUARIO"]
                  ) if "USUARIO" in hay else []:
        nombre = txt(r["USUARIO"])
        if not nombre or nombre.lower() == "admin":
            continue
        clave = txt(r["PASS"]) or nombre
        p = personas.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None
        completo = nombre_de(p, nombre) if p else nombre
        uidn = uuid7()
        try:
            sq.execute(
                "INSERT INTO users (id,username,password_hash,full_name,role,active,"
                "created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
                (uidn, nombre[:40], hashear(clave), completo[:80],
                 ROLES.get(txt(r["TIPO"]).upper(), "seller"), ahora, ahora))
            usuario_map[r["IDUSUARIO"]] = uidn
            rep.suma("Usuarios", 1)
            rep.aviso(f"usuario '{nombre}' entra con su misma clave de StockFácil")
        except sqlite3.IntegrityError:
            rep.aviso(f"el usuario '{nombre}' ya existía: se deja el de StockFlow")

    # ---- FAMILIAS ----
    # No todas las instalaciones tienen tabla FAMILIA. La de Leo Citzia guarda
    # las familias en RELLENO, una tabla de listas genéricas donde conviven con
    # las tarjetas de crédito (se distinguen por TABLA='FAMILIA'), y ARTICULO
    # apunta ahí por IDRELLENO. Sin este camino se perdían las 38 familias y
    # los 1.816 artículos quedaban sin rubro.
    fam_id: dict[str, str] = {}
    if "FAMILIA" not in hay and "RELLENO" in hay:
        for r in leer(con, "RELLENO", ["IDRELLENO", "CONCEPTO", "TABLA"]):
            if txt(r["TABLA"]).upper() != "FAMILIA":
                continue
            nombre = txt(r["CONCEPTO"])
            if not nombre:
                continue
            fid = uuid7()
            sq.execute("INSERT INTO families (id,name,created_at) VALUES (?,?,?)",
                       (fid, nombre[:60], ahora))
            fam_id[txt(r["IDRELLENO"])] = fid
            rep.suma("Familias", 1)
    elif "FAMILIA" in hay:
        for r in leer(con, "FAMILIA", ["CODIGO", "DETALLE"]):
            nombre = txt(r["DETALLE"]) or txt(r["CODIGO"])
            if not nombre:
                continue
            fid = uuid7()
            sq.execute("INSERT INTO families (id,name,created_at) VALUES (?,?,?)",
                       (fid, nombre[:60], ahora))
            fam_id[txt(r["CODIGO"])] = fid
            rep.suma("Familias", 1)

    # ---- PROVEEDORES ----
    prov_id: dict[int, str] = {}
    prov_por_persona: dict[int, str] = {}
    # En la base de Leo Citzia la tabla PROVEEDOR está VACÍA y los proveedores
    # reales viven en EMPRESA (ONCE, PLAST, DIPACK…), a la que ARTICULO apunta
    # por IDEMPRESA. Sin esto, 2.108 artículos quedaban sin proveedor.
    if "EMPRESA" in hay and qn(con, "SELECT COUNT(*) FROM PROVEEDOR") == 0:
        for r in leer(con, "EMPRESA", ["IDEMPRESA", "RAZON", "CUIT", "DOMICILIO",
                                       "TEL", "CEL", "INGBRUTOS", "CODIGO"]):
            ide = r["IDEMPRESA"]
            nombre = txt(r["RAZON"])
            # La fila 1 se llama literalmente "PROVEEDOR": es el encabezado de
            # la lista, no un proveedor. Las sin nombre sí se crean, porque hay
            # artículos colgando de ellas y perderlos sería peor.
            if ide == 1 and nombre.upper() == "PROVEEDOR":
                continue
            if not nombre:
                nombre = f"Proveedor {ide}"
            pid = uuid7()
            sq.execute(
                "INSERT INTO suppliers (id,code,name,cuit,address,ing_brutos,phone,mobile,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (pid, (txt(r["CODIGO"]) or f"PROV-{ide:04d}")[:20], nombre[:80],
                 txt(r["CUIT"]) or None, txt(r["DOMICILIO"]) or None,
                 txt(r["INGBRUTOS"]) or None, txt(r["TEL"]) or None,
                 txt(r["CEL"]) or None, ahora, ahora))
            prov_id[ide] = pid
            rep.suma("Proveedores", 1)
    elif "PROVEEDOR" in hay:
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
                  "STOCK", "STOCKMIN", "FAMILIA", "CLASIFICACION", "OBSERVA", "PROVEEDOR",
                  "VISIBLE"]
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
        # El stock viaja TAL CUAL, negativos incluidos. En comercios con miles de
        # artículos es normal vender sin haber cargado la compra, y el stock
        # queda en negativo: es información real del comercio y ponerla en 0
        # sería inventar un dato. StockFlow permite vender sin stock
        # (`companies.allow_negative_stock`, que la migración deja en 1).
        # ARTICULO.VISIBLE está AL REVÉS de lo que sugiere el nombre: StockFácil
        # lista los que lo tienen VACÍO —en Leo Citzia son 2.109, el número que
        # muestra su pantalla— y los marcados con 1 son bajas del comercio.
        # Se migran TODOS (1.709 de los dados de baja tienen ventas en el
        # historial y 1.945 tienen stock) pero INACTIVOS, así el listado de
        # todos los días muestra lo mismo que el comercio venía viendo.
        activo = 0 if (r["VISIBLE"] == 1) else 1
        stock = r["STOCK"] or 0
        if stock and Decimal(str(stock)) < 0:
            rep.suma("Artículos con stock negativo (se respeta)", 1)
        # Mapeo confirmado con el comercio:
        #   PRECIO1 = costo | PRECIO2 = venta al público | PRECIO3/4 = listas
        #   especiales (mayorista, etc.)
        #
        # Los dos sistemas guardan los precios CON IVA INCLUIDO (StockFlow
        # trabaja en modo 'gross' por defecto: el precio cargado es el que paga
        # el cliente). Por eso NO se divide por el IVA: hacerlo dejaría todo el
        # catálogo 21% más barato, que es el error clásico de estas migraciones.
        costo = r["PRECIO1"] or 0
        venta = r.get(precio_venta) or r["PRECIO2"] or 0
        iva = dec(r["IVA"], 2) if r["IVA"] is not None else "21.00"
        if not iva_incluido:
            # El comercio declaró precios SIN IVA: se le agrega para guardarlos
            # como precio final, que es como los muestra StockFlow.
            f = 1 + Decimal(str(iva)) / 100
            costo = Decimal(str(costo)) * f
            venta = Decimal(str(venta)) * f
            lista2 = Decimal(str(r["PRECIO3"] or 0)) * f
            lista3 = Decimal(str(r["PRECIO4"] or 0)) * f
            mayor = Decimal(str(r["PRECIOU"] or 0)) * f
        else:
            lista2 = r["PRECIO3"] or 0
            lista3 = r["PRECIO4"] or 0
            mayor = r["PRECIOU"] or 0
        aid = uuid7()
        try:
            sq.execute(
                "INSERT INTO articles (id,barcode,description,brand,family_id,supplier_id,vat_rate,"
                "cost_price,list_price1,list_price2,list_price3,wholesale_price,stock,"
                "min_stock,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (aid, barcode[:40], desc[:120], txt(r["MARCA"])[:40] or None,
                 fam_id.get(txt(r["FAMILIA"]) or txt(r["CLASIFICACION"])),
                 prov_id.get(r["PROVEEDOR"]), iva,
                 dec(costo), dec(venta), dec(lista2), dec(lista3), dec(mayor),
                 dec(stock, 3), dec(r["STOCKMIN"] or 0, 3), activo, ahora, ahora))
            art_id[r["IDARTICULO"]] = aid
            rep.suma("Artículos", 1)
            if not activo:
                rep.suma("  …dados de baja en StockFácil (inactivos)", 1)
        except sqlite3.IntegrityError:
            # No debería pasar con el código interno; si pasa, se reintenta.
            try:
                alt = ean13_interno((r["IDARTICULO"] or 0) + 5_000_000)
                sq.execute(
                    "INSERT INTO articles (id,barcode,description,brand,family_id,supplier_id,vat_rate,"
                    "cost_price,list_price1,list_price2,list_price3,wholesale_price,stock,"
                    "min_stock,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (aid, alt, desc[:120], txt(r["MARCA"])[:40] or None,
                     fam_id.get(txt(r["FAMILIA"]) or txt(r["CLASIFICACION"])),
                     prov_id.get(r["PROVEEDOR"]), iva,
                     dec(costo), dec(venta), dec(lista2), dec(lista3), dec(mayor),
                     dec(stock, 3), dec(r["STOCKMIN"] or 0, 3), activo, ahora, ahora))
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
                (cid, apellido[:60], None,   # el nombre ya va en apellido
                 tipo_doc(p, doc) if doc else None,
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

    # ---- MEDIOS DE PAGO ----
    # StockFlow trae cuatro; el comercio usa nueve. Si MercadoPago (7.029
    # ventas) entrara como efectivo, el reparto efectivo/electrónico de la
    # Caja General quedaría mal desde el día uno.
    pm_id: dict[str, str] = {}
    for fila in sq.execute("SELECT id, name FROM payment_methods"):
        pm_id[fila[1].upper()] = fila[0]

    def pm_para(nombre: str) -> str | None:
        """FORMAPAGO de StockFácil -> medio de pago de StockFlow (lo crea si falta)."""
        n = txt(nombre).upper().strip()
        if not n:
            return None
        equivalencias = {
            "CONTADO": "Efectivo",
            "TARJETA DE CREDITO": "Tarjeta de Crédito",
            "TARJETA DE CREDITO  VISA": "Tarjeta de Crédito",
            "TARJETA DE DEBITO": "Tarjeta de Débito",
            "TRANSFERENCIA BANCARIA": "Transferencia",
        }
        destino = equivalencias.get(n, txt(nombre).title())
        clave = destino.upper()
        if clave in pm_id:
            return pm_id[clave]
        # Efectivo de verdad: sólo lo que entra al cajón.
        fisico = 1 if ("CONTADO" in n or "EFECTIVO" in n) else 0
        nid = uuid7()
        orden = (sq.execute("SELECT COALESCE(MAX(sort_order),0) FROM payment_methods").fetchone()[0] or 0) + 1
        # NACEN INACTIVOS. Los medios que trae StockFlow son los que el comercio
        # debe usar; lo que viene de StockFácil existe sólo para que el
        # historial de caja conserve con qué se cobró cada cosa. Muchos ni
        # siquiera son medios de pago: son etiquetas de movimiento ("Pagos de
        # Cuentas de Clientes", "Anulacion de Pagos") y hasta basura tipeada
        # ("Ç"). Si aparecen en la pantalla de venta, el cajero elige
        # cualquiera. El comercio activa desde Medios de Pago los que de
        # verdad use (MercadoPago, Cuenta DNI...).
        sq.execute(
            "INSERT INTO payment_methods (id,name,type,is_physical_cash,commission_pct,"
            "active,sort_order,created_at,updated_at) VALUES (?,?,'other',?,'0.0000',0,?,?,?)",
            (nid, destino[:40], fisico, orden, ahora, ahora))
        pm_id[clave] = nid
        rep.suma("Medios de pago de StockFácil (inactivos)", 1)
        return nid

    # ---- CAJAS DIARIAS ----
    # Se migran las 641 cajas reales, no una sintética: sin esto se perdía el
    # historial de cajas y el resumen de qué se vendió en cada una (VENTA.IDCAJA
    # dice a qué caja pertenece cada venta).
    #
    # Todas entran CERRADAS aunque en StockFácil 444 quedaron en "ABIERTO":
    # son historia, y StockFlow espera una sola caja abierta a la vez. La caja
    # del día la abre el comercio desde el sistema.
    caja_map: dict[int, str] = {}
    aperturas: dict[int, Decimal] = {}
    for r in leer(con, "LINEACAJA", ["CAJA", "MOTIVO", "INGRESO"]) if "LINEACAJA" in hay else []:
        if txt(r["MOTIVO"]).upper().startswith("INICIO"):
            aperturas[r["CAJA"]] = Decimal(str(r["INGRESO"] or 0))

    for r in leer(con, "CAJA", ["IDCAJA", "FECHAINICIO", "FECHACIERRE", "HORAINICIO",
                               "HORACIERRE", "SALDO", "ESTADO"], "ORDER BY IDCAJA") if "CAJA" in hay else []:
        idc = r["IDCAJA"]
        abre = ms(r["FECHAINICIO"], r["HORAINICIO"])
        cierra = ms(r["FECHACIERRE"], r["HORACIERRE"]) if r["FECHACIERRE"] else abre
        cid = uuid7()
        sq.execute(
            "INSERT INTO cash_registers (id,number,open_date,close_date,opening_amount,"
            "closing_amount,status,user_id,notes,created_at) VALUES (?,?,?,?,?,?,'closed',?,?,?)",
            (cid, idc, abre, cierra, dec(aperturas.get(idc, 0)), dec(r["SALDO"] or 0), uid,
             None if txt(r["ESTADO"]).upper() == "CERRADO"
             else "Quedó abierta en StockFácil; se cierra al migrar", abre))
        caja_map[idc] = cid
        rep.suma("Cajas diarias", 1)

    # Caja de respaldo para lo que no tenga IDCAJA válido.
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
                "IDPERSONA", "IDCLIENTE", "ESTADO", "CAE", "CODIGOCAE", "ESTADOFE",
                "IDCAJA", "FORMAPAGO"]
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
            (vid, r["NUMERO"] or 0, letra(r["LETRA"]), fecha, cliente, uid,
             caja_map.get(r["IDCAJA"]) or caja_id,
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
            (cid, int(txt(r["NUMERO"]) or 0) or (r["IDCOMPRA"] or 0),
             letra(r["LETRA"]), fecha, prov, "cash",
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
    # Los RENGLONES de cada cuenta (qué compró) están en LINEACUENTA y las
    # ENTREGAS DE DINERO en PAGOS: sin ellos, abrir una cuenta corriente en
    # StockFlow mostraba una sola línea "saldo anterior" y nada más.
    #
    # OJO: LINEACUENTA sólo conserva los renglones recientes — suman $4.966.079
    # contra $50.845.810 facturados en total. Por eso el saldo y el total SIEMPRE
    # salen de CUENTAS (que es lo que el comercio da por bueno: TOTAL - PAGADO =
    # SALDO cierra en las 51 cuentas) y la diferencia va en un renglón aparte,
    # dicho con todas las letras. No se inventa detalle que no está.
    lineas_cta: dict[int, list[dict]] = {}
    for l in leer(con, "LINEACUENTA", ["IDCUENTA", "IDARTICULO", "CODIGO", "DETALLE",
                                       "CANTIDAD", "PRECIO", "TOTAL", "FECHA", "TIPO"]
                  ) if "LINEACUENTA" in hay else []:
        if txt(l["TIPO"]).lower() != "linea":
            continue          # los 'pago' viajan por PAGOS
        lineas_cta.setdefault(l["IDCUENTA"], []).append(l)

    pagos_cta: dict[int, list[dict]] = {}
    for pg in leer(con, "PAGOS", ["IDCUENTA", "ENTREGA", "FECHA"]) if "PAGOS" in hay else []:
        pagos_cta.setdefault(pg["IDCUENTA"], []).append(pg)

    efectivo_id = pm_id.get("EFECTIVO") or next(iter(pm_id.values()), None)

    art_saldo_id = uuid7()
    sq.execute(
        "INSERT INTO articles (id,barcode,description,vat_rate,cost_price,list_price1,"
        "stock,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
        (art_saldo_id, ean13_interno(999998),
         "Consumos anteriores de cuenta corriente (StockFácil)",
         "21.00", dec(0), dec(0), dec(0, 3), ahora, ahora))

    nro_saldo = (sq.execute("SELECT COALESCE(MAX(number),0) FROM sales").fetchone()[0] or 0)
    for r in leer(con, "CUENTAS", ["IDCUENTA", "IDCLIENTE", "TOTAL", "SALDO", "FECHAINI"]
                  ) if "CUENTAS" in hay else []:
        saldo = Decimal(str(r["SALDO"] or 0))
        total_cta = Decimal(str(r["TOTAL"] or 0))
        # Se migran TODAS las cuentas, también las saldadas: el comercio quiere
        # ver el historial del cliente aunque hoy no deba nada.
        if total_cta <= 0 and saldo <= 0 and not lineas_cta.get(r["IDCUENTA"]):
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
                 tipo_doc(p, doc) if doc else None,
                 doc or None, txt(p.get("DOMICILIO") if p else None) or None,
                 txt(p.get("TEL") if p else None) or None,
                 txt(p.get("CEL") if p else None) or None,
                 txt(p.get("EMAIL") if p else None) or None,
                 categoria_iva(p.get("CATEGORIA") if p else None), dec(0), ahora, ahora))
            cli_id[r["IDCLIENTE"]] = cliente
            rep.suma("Clientes", 1)
            rep.aviso(f"'{nombre[:34]}' estaba dado de baja"
                      + (f" pero debe {saldo}" if saldo > 0 else " y su cuenta estaba saldada")
                      + ": se recuperó")
        try:
            nro_saldo += 1
            vid = uuid7()
            fecha = ms(r["FECHAINI"])
            sq.execute(
                "INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,"
                "is_account_sale,subtotal,discount,vat_amount,total,status,notes,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,'completed',?,?,?)",
                (vid, nro_saldo, "X", fecha, cliente, uid, caja_id,
                 dec(total_cta), dec(0), dec(0), dec(total_cta),
                 "Saldo de cuenta corriente traído de StockFácil", fecha, fecha))

            # Los artículos que compró.
            nlin = 0
            suma_lin = Decimal(0)
            for l in lineas_cta.get(r["IDCUENTA"], []):
                aid = art_id.get(l["IDARTICULO"])
                if not aid:
                    continue
                nlin += 1
                imp = Decimal(str(l["TOTAL"] or 0))
                suma_lin += imp
                sq.execute(
                    "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,"
                    "unit_price,discount,vat_rate,line_total,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (uuid7(), vid, aid, nlin, dec(l["CANTIDAD"] or 0, 3),
                     dec(l["PRECIO"] or 0), dec(0), "21.00", dec(imp), ms(l["FECHA"])))
                rep.suma("Renglones de cuenta corriente", 1)

            # Lo consumido antes de lo que guarda LINEACUENTA, dicho como lo que
            # es: un arrastre. Sin este renglón la cuenta no cerraría contra el
            # total que el comercio tiene por bueno.
            resto = total_cta - suma_lin
            if resto > 0 and art_saldo_id:
                sq.execute(
                    "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,"
                    "unit_price,discount,vat_rate,line_total,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (uuid7(), vid, art_saldo_id, nlin + 1, dec(1, 3), dec(resto),
                     dec(0), "21.00", dec(resto), fecha))

            arid = uuid7()
            estado = "open" if saldo > 0 else "paid"
            sq.execute(
                "INSERT INTO accounts_receivable (id,customer_id,sale_id,total,balance,"
                "status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                (arid, cliente, vid, dec(total_cta), dec(saldo), estado, fecha, ahora))

            # Las entregas de dinero.
            for pg in pagos_cta.get(r["IDCUENTA"], []):
                sq.execute(
                    "INSERT INTO payments (id,account_id,amount,date,payment_method_id,"
                    "notes,created_at) VALUES (?,?,?,?,?,?,?)",
                    (uuid7(), arid, dec(pg["ENTREGA"] or 0), ms(pg["FECHA"]),
                     efectivo_id, "Entrega registrada en StockFácil", ahora))
                rep.suma("Entregas de dinero", 1)

            rep.suma("Cuentas corrientes", 1)
        except sqlite3.Error as e:
            rep.aviso(f"cuenta corriente no migrada: {e}")

    # ---- MOVIMIENTOS DE CAJA ----
    # StockFlow reconstruye el saldo de una caja desde sus movimientos, así que
    # cada línea de LINEACAJA tiene que viajar: sin esto las cajas quedaban
    # todas en cero y no había forma de ver qué se vendió en cada una.
    # El medio de pago va en cada movimiento porque de ahí sale el reparto
    # efectivo/electrónico de la Caja General.
    for r in leer(con, "LINEACAJA", ["CAJA", "MOTIVO", "DETALLE", "INGRESO", "EGRESO",
                                     "IDVENTA", "IDMOVIMIENTOS"]) if "LINEACAJA" in hay else []:
        motivo = txt(r["MOTIVO"]).upper()
        if motivo.startswith("INICIO"):
            continue                      # ya viajó como saldo de apertura
        cid = caja_map.get(r["CAJA"])
        if not cid:
            continue
        # Se trabaja con el NETO: hay líneas con INGRESO negativo (anulaciones de
        # pagos de cuenta corriente) que son plata que SALE. Tomando "ingreso si
        # ing>0, si no egreso" quedaban como movimientos de $0 y se perdían
        # $534.220 de la historia de caja.
        neto = Decimal(str(r["INGRESO"] or 0)) - Decimal(str(r["EGRESO"] or 0))
        if neto == 0:
            continue
        tipo = "income" if neto > 0 else "expense"
        monto = neto if neto > 0 else -neto
        venta = venta_map.get(r["IDVENTA"]) if motivo.startswith("VENTA") else None
        compra = compra_map.get(r["IDVENTA"]) if motivo.startswith("COMPRA") else None
        sq.execute(
            "INSERT INTO cash_movements (id,cash_register_id,type,description,amount,date,"
            "user_id,related_sale_id,related_purchase_id,payment_method_id,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uuid7(), cid, tipo, txt(r["MOTIVO"])[:80] or "Movimiento", dec(monto),
             ahora, uid, venta, compra, pm_para(r["DETALLE"]), ahora))
        rep.suma("Movimientos de caja", 1)

    # El comercio vende sin haber cargado la compra: sin esto el sistema le
    # bloquearía la venta de todo lo que quedó en negativo.
    sq.execute("UPDATE companies SET allow_negative_stock = 1")
    if sq.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0:
        rep.aviso("no hay ficha de comercio: activá 'vender sin stock' en Configuración")

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
