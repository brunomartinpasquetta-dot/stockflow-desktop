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

    # 3) migrar a una base de StockFlow nueva (vacía: crear-db-vacia.ts), con la
    #    lista de VENTA al público elegida mirando una factura impresa
    python3 migrar.py migrar /ruta/stockflow.db PRECIO2 [--sin-iva]

    # 4) bajar el motor
    python3 migrar.py bajar

    # TODO JUNTO (el día en el local, repetible con un .GDB más nuevo):
    python3 migrar.py todo /ruta/DBPV.GDB /carpeta/salida PRECIO2
    # → deja stockflow-migrado-<fecha>.zip para Configuración → Backup → Restaurar

La base .GDB NO se modifica: se trabaja siempre sobre una copia.
"""
from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import sqlite3
import sys
import time
import uuid
from datetime import datetime, date
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from functools import lru_cache

try:
    import firebirdsql
except ImportError:
    sys.exit("Falta el driver: pip3 install firebirdsql passlib")

try:
    import bcrypt as _bcrypt
except ImportError:
    _bcrypt = None   # sin bcrypt se migran los usuarios con una clave provisoria

# Firebird 2.5 abre bases ODS 10.x–11.x (StockFácil clásico). Si el cliente
# tiene una base de Firebird 3 (ODS 12) el motor no la abre: correr con
# FIREBIRD_IMAGEN=jacobalberty/firebird:3.0 (ya bajada en la Mac).
IMAGEN = os.environ.get("FIREBIRD_IMAGEN", "jacobalberty/firebird:2.5-ss")
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


# Alícuotas que acepta ARCA (Iva.Id de WSFEv1): las mismas que `VAT_IDS` de
# @stockflow/shared.
ALICUOTAS_ARCA = {"0.00": 3, "10.50": 4, "21.00": 5, "27.00": 6}


@lru_cache(maxsize=512)   # se llama una vez por renglón: cientos de miles
def alicuota_valida(v, default: str = "21.00") -> str:
    """Tasa de IVA llevada a la más cercana de las que acepta ARCA.

    StockFácil deja tipear cualquier número, y hay bases con artículos y
    renglones en tasas que ARCA no tiene. StockFlow manda la tasa del artículo
    a ARCA, y una tasa que no existe hace rechazar su factura siempre."""
    if v is None:
        return default
    try:
        x = Decimal(str(v).strip().replace(",", "."))
    except (InvalidOperation, ValueError):
        return default
    if x <= 0:
        return "0.00"
    return min(ALICUOTAS_ARCA, key=lambda k: abs(Decimal(k) - x))


def centavos(x: Decimal) -> int:
    """A centavos enteros redondeando como `Math.round` (lo que usa StockFlow
    para los importes de ARCA): mitad hacia arriba."""
    return int((Decimal(x) * 100 + Decimal("0.5")).to_integral_value(rounding=ROUND_FLOOR))


def detalle_iva(brutos: dict[str, Decimal], neto: Decimal, iva: Decimal, total: Decimal,
                descuento: Decimal) -> list[tuple[int, str, str]]:
    """Filas de `fiscal_voucher_vat` (id ARCA, base, IVA) de un comprobante A/B.

    Con una alícuota (casi siempre) van el neto y el IVA que StockFácil informó
    a ARCA. Con varias se reparte el total como `arcaAmounts` de StockFlow: el
    descuento global prorrateado y el reparto en centavos, así neto + IVA =
    total y la suma de bases es el neto."""
    grupos = {k: v for k, v in brutos.items() if v != 0}
    if total == 0:
        return []
    if len(grupos) <= 1:
        tasa = next(iter(grupos)) if grupos else None
        if iva == 0:
            tasa = "0.00"   # lo informado a ARCA manda: sin IVA es 0 %
        elif tasa in (None, "0.00"):   # sin renglones útiles: sale de IVA / neto
            tasa = alicuota_valida(iva / neto * 100 if neto else 0)
        if tasa == "0.00":
            return [(ALICUOTAS_ARCA["0.00"], f"{total:.2f}", "0.00")]
        return [(ALICUOTAS_ARCA[tasa], f"{neto:.2f}", f"{iva:.2f}")]
    subtotal = sum(grupos.values(), Decimal(0))
    prorratea = descuento != 0 and subtotal != 0
    filas = []
    for tasa, bruto in grupos.items():
        con_desc = bruto - (descuento * bruto / subtotal if prorratea else 0)
        filas.append([Decimal(tasa), tasa, centavos(con_desc)])
    filas = [f for f in filas if f[2] != 0]
    filas.sort(key=lambda f: f[0])
    resto = centavos(total) - sum(f[2] for f in filas)
    if resto and filas:
        max(filas, key=lambda f: f[2])[2] += resto
    out = []
    for r_, tasa, bruto_c in filas:
        iva_c = centavos(Decimal(bruto_c) * r_ / (100 + r_) / 100) if r_ > 0 else 0
        out.append((ALICUOTAS_ARCA[tasa], f"{Decimal(bruto_c - iva_c) / 100:.2f}", f"{Decimal(iva_c) / 100:.2f}"))
    return out


def url_qr_arca(cuit: str, pv: int, codigo: int, numero: int, total: Decimal, doc_tipo: int,
                doc_nro: str, cae: str, fecha_ms: int) -> str | None:
    """URL del QR del comprobante (RG 4892), armada igual que `buildQrUrl` de
    StockFlow. Sin esto, la reimpresión y el PDF de una factura migrada salían
    sin el QR obligatorio."""
    cuit = re.sub(r"\D", "", cuit or "")
    if len(cuit) != 11 or not txt(cae).isdigit():
        return None
    importe = float(f"{total:.2f}")
    payload = {
        "ver": 1,
        "fecha": datetime.fromtimestamp(fecha_ms / 1000).strftime("%Y-%m-%d"),
        "cuit": int(cuit),
        "ptoVta": pv,
        "tipoCmp": codigo,
        "nroCmp": numero,
        "importe": int(importe) if importe == int(importe) else importe,   # como JSON.stringify
        "moneda": "PES",
        "ctz": 1,
        "tipoDocRec": doc_tipo,
        "nroDocRec": int(doc_nro) if str(doc_nro).isdigit() else 0,
        "tipoCodAut": "E",
        "codAut": int(txt(cae)),
    }
    b64 = base64.b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode()
    return f"https://www.afip.gob.ar/fe/qr/?p={b64}"


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
    # El código de barras puede estar en CODIGO2 (Leo Citzia) o en CODIGO
    # (Denver): se cuenta como "sin código" sólo el que no lo tiene en NINGUNO
    # de los dos. De CODIGO vale todo lo numérico (también los códigos cortos
    # que tipean los cajeros), salvo los que son sólo ceros.
    sin_cb = qn(con, """SELECT COUNT(*) FROM ARTICULO
        WHERE (CODIGO2 IS NULL OR TRIM(CODIGO2) = '')
          AND (CODIGO IS NULL OR TRIM(CODIGO) = ''
               OR TRIM(CODIGO) SIMILAR TO '%[^0-9]%' OR TRIM(CODIGO) SIMILAR TO '0+')""")
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
            # Tope alto: con un aviso por usuario, los de la ficha del comercio,
            # el punto de venta o las claves débiles quedaban detrás del corte.
            print("\n  AVISOS:")
            for a in self.avisos[:80]:
                print(f"    - {a}")
            if len(self.avisos) > 80:
                print(f"    … y {len(self.avisos) - 80} más")


def migrar(destino: str, precio_venta: str = "PRECIO1", iva_incluido: bool = True) -> None:
    if not os.path.isfile(destino):
        sys.exit(f"No existe la base destino: {destino}\n"
                 "Instalá StockFlow, abrilo una vez para que cree la base, y pasá esa ruta.")

    con = conectar()
    hay = tablas(con)
    sq = sqlite3.connect(destino, isolation_level=None)
    sq.execute("PRAGMA foreign_keys=OFF")
    rep = Reporte()
    ahora = int(time.time() * 1000)

    # UNA sola transacción: si algo falla a mitad de camino la base destino
    # queda como estaba (vacía), no con la mitad de los clientes y ninguna
    # venta. Antes había un commit intermedio y una excepción dejaba una base
    # a medias que parecía migrada (auditoría sep-2026).
    try:
        sq.execute("BEGIN")
        _migrar_cuerpo(con, hay, sq, rep, ahora, precio_venta, iva_incluido)
        # Con las FK apagadas durante la carga, se verifica la integridad
        # ANTES de confirmar: una referencia rota no llega a la base.
        rotas = sq.execute("PRAGMA foreign_key_check").fetchall()
        if rotas:
            ejemplo = ", ".join(f"{r[0]}→{r[2]}" for r in rotas[:5])
            raise RuntimeError(f"{len(rotas)} referencia(s) rota(s) tras migrar: {ejemplo}")
        sq.commit()
    except SystemExit:
        sq.rollback()
        raise
    except Exception as e:  # noqa: BLE001 — cualquier cosa deja la base como estaba
        sq.rollback()
        sq.close(); con.close()
        sys.exit(f"\n  La migración se canceló y la base destino quedó SIN cambios.\n  Motivo: {e}")
    sq.close()
    con.close()
    rep.imprimir()
    print("\n  La base .GDB del cliente no fue modificada.")


def _migrar_cuerpo(con, hay: set, sq: sqlite3.Connection, rep: "Reporte", ahora: int,
                   precio_venta: str, iva_incluido: bool) -> None:
    # El `admin` de soporte es el dueño de lo que no tiene usuario propio (cajas,
    # comprobantes, ventas sin vendedor). Se lo busca por nombre: "el primero
    # que aparezca" dependía del orden físico de la tabla.
    usuario = (sq.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()
               or sq.execute("SELECT id FROM users ORDER BY created_at LIMIT 1").fetchone())
    if not usuario:
        sq.close(); con.close()
        sys.exit("La base destino no tiene usuarios. Abrí StockFlow una vez antes de migrar.")
    # Todo lo que sigue arma subtotales, descuentos y renglones como los guarda
    # StockFlow en modo 'gross' (precios con IVA), que es el de una base nueva.
    modo = sq.execute("SELECT price_mode FROM companies LIMIT 1").fetchone()
    if modo and modo[0] == "net":
        rep.aviso("OJO: la base destino está en modo de precios NETO; la migración arma los "
                  "importes CON IVA incluido. Pasarla a 'con IVA' antes de usarla.")
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
    # Las mismas claves que StockFlow considera débiles (`usuariosConClaveDebil`):
    # con alguna de ellas activa, el sistema se niega a encender el acceso remoto.
    claves_debiles = {"admin", "Admin", "1234", "12345", "123456", "password", "stockflow"}
    debiles: list[str] = []
    for r in leer(con, "USUARIO", ["IDUSUARIO", "IDPERSONA", "TIPO", "PASS", "USUARIO"]
                  ) if "USUARIO" in hay else []:
        nombre = txt(r["USUARIO"])
        if not nombre or nombre.lower() == "admin":
            continue
        # Sin clave en StockFácil entra con su propio nombre de usuario como
        # clave; y si no hay bcrypt disponible la clave que queda es 'admin'.
        # El aviso dice lo que pasó de verdad (auditoría sep-2026).
        sin_clave = not txt(r["PASS"])
        clave = txt(r["PASS"]) or nombre
        p = personas.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None
        completo = nombre_de(p, nombre) if p else nombre
        uidn = uuid7()
        # El TIPO de StockFácil no siempre coincide con los que conocemos, y el
        # que no se reconoce cae en "seller" — que casi no puede hacer nada. Le
        # pasó al DUEÑO en Leo Citzia: entraba como vendedor y no veía
        # Contabilidad ni Hardware, y se buscó el problema en el sistema. Si no
        # se reconoce, se avisa FUERTE para revisarlo antes de entregar.
        tipo = txt(r["TIPO"]).upper()
        rol = ROLES.get(tipo, "seller")
        if tipo not in ROLES:
            rep.aviso(f"OJO: el usuario '{nombre}' tiene TIPO '{tipo or '(vacío)'}', "
                      f"que no reconocemos: queda como VENDEDOR (casi sin permisos). "
                      f"Revisar el rol en Configuración → Usuarios antes de entregar.")
        try:
            sq.execute(
                "INSERT INTO users (id,username,password_hash,full_name,role,active,"
                "created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)",
                (uidn, nombre[:40], hashear(clave), completo[:80], rol, ahora, ahora))
            usuario_map[r["IDUSUARIO"]] = uidn
            rep.suma("Usuarios", 1)
            if _bcrypt is None or clave in claves_debiles or clave in (nombre[:40], nombre[:40].lower()):
                debiles.append(nombre[:40])
            if _bcrypt is None:
                rep.aviso(f"usuario '{nombre}': NO hay bcrypt en esta máquina, entra con la clave 'admin' (cambiarla)")
            elif sin_clave:
                rep.aviso(f"usuario '{nombre}' no tenía clave en StockFácil: entra con la clave '{nombre}'")
            else:
                rep.aviso(f"usuario '{nombre}' entra con su misma clave de StockFácil")
        except sqlite3.IntegrityError:
            rep.aviso(f"el usuario '{nombre}' ya existía: se deja el de StockFlow")
    if debiles:
        rep.aviso(f"clave débil en: {', '.join(debiles)}. El acceso remoto no se puede activar "
                  "hasta cambiarlas (Configuración → Usuarios).")

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
    codigos_prov: set[str] = {f[0] for f in sq.execute("SELECT code FROM suppliers")}

    def codigo_libre(pedido: str, ide) -> str:
        """suppliers.code es ÚNICO en StockFlow y StockFácil repite códigos (hay
        bases con dos '001' en EMPRESA): el segundo cancelaba la migración
        entera. Al repetido se le agrega el id de StockFácil."""
        cod = (pedido or f"PROV-{str(ide).zfill(4)}")[:20]
        if cod in codigos_prov:
            base_, n_ = f"{cod[:12]}-{ide}"[:20], 2
            cod = base_
            while cod in codigos_prov:
                cod, n_ = f"{base_[:16]}-{n_}", n_ + 1
            rep.suma("  …proveedores con código repetido (se le agregó su id)", 1)
        codigos_prov.add(cod)
        return cod
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
                (pid, codigo_libre(txt(r["CODIGO"]), ide), nombre[:80],
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
            code = codigo_libre(txt(r["CODIGO"]), i)
            pid = uuid7()
            sq.execute(
                "INSERT INTO suppliers (id,code,name,cuit,address,phone,mobile,"
                "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (pid, code, nombre[:80],
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
    # Con --sin-iva el costo se guarda con IVA; el costo congelado de cada
    # renglón de venta tiene que quedar en la misma base que ese costo.
    factor_iva_art: dict[int, Decimal] = {}

    def ean_libre(n: int) -> str:
        """EAN-13 interno que ningún artículo usa: articles.barcode es ÚNICO y
        un código real del comercio puede coincidir con uno generado (los
        artículos de respaldo no tenían reintento y cancelaban todo)."""
        cod = ean13_interno(n)
        while cod in barcodes_usados:
            n += 1
            cod = ean13_interno(n)
        barcodes_usados.add(cod)
        return cod
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
        # Código de barras: se respeta el del fabricante si lo tiene. DÓNDE lo
        # guarda StockFácil VARÍA entre instalaciones: en Leo Citzia está en
        # CODIGO2 y en Denver Drugstore en CODIGO (543 de 604 artículos, con
        # CODIGO2 entero vacío). Se prueban los dos, y de CODIGO se acepta todo
        # lo NUMÉRICO: los códigos de fábrica y también los códigos cortos que
        # los cajeros tipean de memoria (en una base real, 124 de esos
        # códigos). Antes sólo valían los de 8 dígitos para arriba y esos
        # artículos quedaban con un EAN interno: el cajero ya no podía venderlos
        # como siempre (regla de Bruno, 4-oct-2026: la migración es un espejo).
        # Lo no numérico ('PROMO04', '7.62221E+12' roto por Excel) y los que son
        # sólo ceros siguen afuera. Si no hay ninguno se genera un EAN-13
        # interno válido, para que igual pueda imprimir etiquetas y usar el lector.
        cand = ""
        for campo in ("CODIGO2", "CODIGO"):
            v = txt(r[campo])
            if not v or set(v) <= {"0"} or v in barcodes_usados:
                continue
            # Lo ÚNICO que se descarta es lo que rompió Excel ('7.62221E+12'):
            # ahí el código real se perdió y un EAN interno es mejor que un
            # número falso. Todo lo demás entra TAL CUAL, letras incluidas.
            #
            # Antes de CODIGO sólo se aceptaba lo numérico, y en un comercio
            # con códigos como 'TECH358' o 'SURI166' —El Paranacito, 3.674 de
            # 3.677 artículos— TODOS quedaban con un código inventado: el
            # cajero no podía encontrar un solo artículo por el código que usa
            # todos los días (Bruno, 10-oct-2026). La migración es un espejo.
            if re.match(r"^[0-9.]+E\+?[0-9]+$", v, re.IGNORECASE):
                continue
            cand = v
            break
        barcode = cand or ean_libre(r["IDARTICULO"] or 0)
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
        iva = alicuota_valida(r["IVA"])
        if r["IVA"] is not None and dec(r["IVA"], 2) != iva:
            rep.suma(f"  …IVA {dec(r['IVA'], 2)} % no existe en ARCA: se pasó a {iva} %", 1)
        if not iva_incluido:
            # El comercio declaró precios SIN IVA: se le agrega para guardarlos
            # como precio final, que es como los muestra StockFlow.
            f = 1 + Decimal(str(iva)) / 100
            factor_iva_art[r["IDARTICULO"]] = f
            costo = Decimal(str(costo)) * f
            venta = Decimal(str(venta)) * f
            lista2 = Decimal(str(r["PRECIO3"] or 0)) * f
            lista3 = Decimal(str(r["PRECIO4"] or 0)) * f
            mayor = Decimal(str(r["PRECIOU"] or 0)) * f
        else:
            lista2 = r["PRECIO3"] or 0
            lista3 = r["PRECIO4"] or 0
            mayor = r["PRECIOU"] or 0
        # Las listas 2 y 3 NUNCA quedan en cero ni en el costo o por debajo. En
        # Ventas la lista elegida se cobra tal cual (`resolvePrice`): una lista
        # en $0 vende gratis y una igual o menor al costo vende sin ganancia o a
        # pérdida. En Denver PRECIO3 era una copia del costo en 564 de 580
        # artículos y PRECIO4 estaba vacío en la mitad; en otras bases PRECIO3/4
        # quedaron con un costo VIEJO, por debajo del actual. Lo que no es una
        # lista de venta real se rellena con el precio de venta, y la pantalla
        # de precios sigue mostrando algo cobrable en las tres.
        def lista_segura(v, etiqueta: str):
            v = Decimal(str(v or 0))
            if v <= 0 or v <= Decimal(str(costo)):
                rep.suma(f"  …{etiqueta} vacía o no mayor al costo: se usa el precio de venta", 1)
                return venta
            return v
        lista2 = lista_segura(lista2, "lista 2")
        lista3 = lista_segura(lista3, "lista 3")
        # Utilidad por lista, como la siembra la migración 0022 para los
        # artículos que ya existían (precio / costo − 1, dos decimales): sin
        # ella, al cargar una compra con costo nuevo el sistema no propone los
        # precios de venta de ningún artículo migrado. Nunca cambia un precio.
        def margen(precio) -> str | None:
            c, p = float(dec(costo)), float(dec(precio))
            return f"{(p / c - 1) * 100:.2f}" if c > 0 and p > 0 else None
        aid = uuid7()
        fila_art = [aid, barcode[:40], desc[:120], txt(r["MARCA"])[:40] or None,
                    fam_id.get(txt(r["FAMILIA"]) or txt(r["CLASIFICACION"])),
                    prov_id.get(r["PROVEEDOR"]), iva,
                    dec(costo), dec(venta), dec(lista2), dec(lista3), dec(mayor),
                    margen(venta), margen(lista2), margen(lista3),
                    dec(stock, 3), dec(r["STOCKMIN"] or 0, 3), activo, ahora, ahora]
        sql_art = ("INSERT INTO articles (id,barcode,description,brand,family_id,supplier_id,vat_rate,"
                   "cost_price,list_price1,list_price2,list_price3,wholesale_price,"
                   "margin1,margin2,margin3,stock,min_stock,active,created_at,updated_at) "
                   "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        try:
            sq.execute(sql_art, fila_art)
            art_id[r["IDARTICULO"]] = aid
            rep.suma("Artículos", 1)
            if not activo:
                rep.suma("  …dados de baja en StockFácil (inactivos)", 1)
        except sqlite3.IntegrityError:
            # No debería pasar con el código interno; si pasa, se reintenta.
            try:
                fila_art[1] = ean_libre((r["IDARTICULO"] or 0) + 5_000_000)
                sq.execute(sql_art, fila_art)
                art_id[r["IDARTICULO"]] = aid
                rep.suma("Artículos", 1)
            except sqlite3.Error as e:
                rep.aviso(f"no se pudo migrar '{desc[:30]}': {e}")

    # ---- CLIENTES ----
    cli_id: dict[int, str] = {}
    cli_por_persona: dict[int, str] = {}
    # StockFlow ya trae su "CONSUMIDOR FINAL"; el de StockFácil (con DNI
    # 1111111 o similar) se mapea al existente en vez de duplicarlo. Con dos,
    # el punto de venta elegía uno u otro según el orden y las estadísticas por
    # cliente se partían (auditoría sep-2026).
    cf_existente = sq.execute(
        "SELECT id FROM customers WHERE UPPER(last_name) LIKE '%CONSUMIDOR%FINAL%' LIMIT 1").fetchone()
    cf_existente = cf_existente[0] if cf_existente else None
    if "CLIENTES" in hay:
        for r in leer(con, "CLIENTES", ["IDCLIENTES", "IDPERSONA", "CODIGO"]):
            p = personas.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None
            apellido = nombre_de(p, "") if p else ""
            if not apellido:
                apellido = f"Cliente {r['IDCLIENTES']}"
            if cf_existente and re.sub(r"[^A-Z]", "", apellido.upper()).startswith("CONSUMIDORFINAL"):
                cli_id[r["IDCLIENTES"]] = cf_existente
                if r["IDPERSONA"] is not None:
                    cli_por_persona[r["IDPERSONA"]] = cf_existente
                rep.aviso("el 'CONSUMIDOR FINAL' de StockFácil se unificó con el de StockFlow")
                continue
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

    # ---- MEDIOS DE PAGO ----
    # StockFlow trae cuatro; el comercio usa nueve. Si MercadoPago (7.029
    # ventas) entrara como efectivo, el reparto efectivo/electrónico de la
    # Caja General quedaría mal desde el día uno.
    pm_id: dict[str, str] = {}
    for fila in sq.execute("SELECT id, name FROM payment_methods"):
        pm_id[fila[1].upper()] = fila[0]

    def pm_para(nombre: str) -> str | None:
        """FORMAPAGO de StockFácil -> medio de pago de StockFlow (lo crea si falta)."""
        n = re.sub(r"\s+", " ", txt(nombre).upper()).strip()
        if not n:
            return None
        # Cobro combinado partido en renglones de caja ("CONTADO / TRANSFERENCIA
        # Transferencia"): la última palabra es el medio de ESE renglón. Sin
        # esto la parte por transferencia quedaba como efectivo del cajón.
        partes = n.split()
        if "/" in n and partes[-1] in ("EFECTIVO", "TRANSFERENCIA", "TARJETA", "MERCADOPAGO"):
            n = partes[-1]
        equivalencias = {
            "CONTADO": "Efectivo",
            "TARJETA DE CREDITO": "Tarjeta de Crédito",
            "TARJETA DE CREDITO VISA": "Tarjeta de Crédito",
            "TARJETA DE DEBITO": "Tarjeta de Débito",
            "TRANSFERENCIA BANCARIA": "Transferencia",
        }
        destino = equivalencias.get(n, n.title())
        if n.replace(" ", "") == "MERCADOPAGO":
            destino = "Mercado Pago"
        # Sin una sola letra no es un medio de pago: son códigos de barras
        # tipeados en el campo, '.', 'Ç'. Van todos a UN medio, en vez de crear
        # uno por cada basura (puede haber decenas).
        if not re.search(r"[A-ZÁÉÍÓÚÜÑ]", n):
            destino = "Sin identificar (StockFácil)"
        # La clave es el nombre TAL CUAL se guarda (recortado a 40): dos nombres
        # largos con el mismo comienzo chocaban en el índice único de
        # payment_methods.name y cancelaban la migración entera.
        destino = destino[:40]
        clave = destino.upper()
        if clave in pm_id:
            return pm_id[clave]
        # Efectivo de verdad: sólo lo que entra al cajón.
        fisico = 1 if ("CONTADO" in n or "EFECTIVO" in n) else 0
        # Mercado Pago nace con su tipo real: es lo que usan el cobro por QR y
        # los pedidos web pagados para encontrarlo. Como 'other' quedaba
        # invisible para esas dos funciones.
        tipo = "mp" if clave == "MERCADO PAGO" else "other"
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
            "active,sort_order,created_at,updated_at) VALUES (?,?,?,?,'0.0000',0,?,?,?)",
            (nid, destino, tipo, fisico, orden, ahora, ahora))
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
    caja_fecha: dict[int, int] = {}
    caja_usuario: dict[int, str] = {}
    aperturas: dict[int, Decimal] = {}

    def usuario_de(v, defecto: str) -> str:
        """IDUSUARIO de StockFácil (VENTA.USUARIO, CAJA.USUARIO,
        LINEACAJA.IDUSUARIO) → usuario migrado; lo que no se reconoce (0,
        vacío, texto) cae en `defecto`."""
        try:
            return usuario_map.get(int(str(v).strip()), defecto) if v not in (None, "") else defecto
        except ValueError:
            return defecto
    for r in leer(con, "LINEACAJA", ["CAJA", "MOTIVO", "INGRESO"]) if "LINEACAJA" in hay else []:
        if txt(r["MOTIVO"]).upper().startswith("INICIO"):
            aperturas[r["CAJA"]] = Decimal(str(r["INGRESO"] or 0))

    for r in leer(con, "CAJA", ["IDCAJA", "FECHAINICIO", "FECHACIERRE", "HORAINICIO",
                               "HORACIERRE", "SALDO", "ARQUEO", "ESTADO", "USUARIO"],
                  "ORDER BY IDCAJA") if "CAJA" in hay else []:
        idc = r["IDCAJA"]
        # El cajero real (CAJA.USUARIO es su IDUSUARIO): antes las cajas
        # quedaban todas a nombre del admin en Caja → Historial.
        cajero = usuario_de(r["USUARIO"], uid)
        abre = ms(r["FECHAINICIO"], r["HORAINICIO"])
        cierra = ms(r["FECHACIERRE"], r["HORACIERRE"]) if r["FECHACIERRE"] else abre
        cid = uuid7()
        # `closing_amount` es, en StockFlow, el EFECTIVO CONTADO al cerrar: el
        # historial lo compara con el esperado (sólo efectivo) y muestra
        # "Faltante"/"Sobrante". SALDO de StockFácil es ingresos − egresos de
        # TODOS los medios (Mercado Pago, débito, compras a cuenta), no un
        # conteo: usado como cierre, cada caja migrada salía con una diferencia
        # falsa. Se usa ARQUEO si el comercio contó; si no, queda vacío (sin
        # arqueo registrado) y el SALDO viaja en la nota.
        contado = dec(r["ARQUEO"]) if Decimal(dec(r["ARQUEO"])) != 0 else None
        nota = f"Migrada de StockFácil (saldo allá: {dec(r['SALDO'] or 0, 2)}"
        nota += ")" if contado else "; sin arqueo registrado)"
        if txt(r["ESTADO"]).upper() != "CERRADO":
            nota += ". Quedó abierta en StockFácil; se cerró al migrar"
        sq.execute(
            "INSERT INTO cash_registers (id,number,open_date,close_date,opening_amount,"
            "closing_amount,status,user_id,notes,created_at) VALUES (?,?,?,?,?,?,'closed',?,?,?)",
            (cid, idc, abre, cierra, dec(aperturas.get(idc, 0)), contado, cajero, nota, abre))
        caja_map[idc] = cid
        caja_fecha[idc] = abre
        caja_usuario[idc] = cajero
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
    punto_venta_viejo = None
    if "MIEMPRESA" in hay:
        for r in leer(con, "MIEMPRESA", ["PUNTO"]):
            try:
                punto_venta_viejo = int(r["PUNTO"]) if r["PUNTO"] else None
            except (TypeError, ValueError):
                punto_venta_viejo = None
            break
    venta_map: dict[int, str] = {}
    efectivo_pm = pm_id.get("EFECTIVO") or next(iter(pm_id.values()), None)
    campos_v = ["IDVENTA", "FECHA", "HORA", "NUMERO", "LETRA", "TOTAL", "IVA", "DESCUENTO",
                "IDPERSONA", "IDCLIENTE", "CLIENTE", "ESTADO", "CAE", "CODIGOCAE", "ESTADOFE",
                "IDCAJA", "FORMAPAGO", "USUARIO", "NROCOMP", "VENCCAE", "SUBTOTAL", "IDCUENTA",
                "RECARGO"]
    # Comprobantes A/B migrados, para armarles el detalle de IVA cuando ya estén
    # sus renglones: (id comprobante, id venta, neto, IVA, total, descuento).
    comprobantes: list[tuple[str, str, Decimal, Decimal, Decimal, Decimal]] = []
    ventas_con_comprobante: set[str] = set()
    ultimo_cbte: dict[tuple[int, int], tuple[int, int]] = {}
    venta_fecha: dict[int, int] = {}
    # Ventas que fueron a la cuenta corriente del cliente (VENTA.IDCUENTA), por
    # cuenta. Entran como is_account_sale=1 y NO se vuelven a contar en la
    # venta de "saldo anterior" de esa cuenta (auditoría sep-2026, A22).
    venta_cuenta: dict[int, list[tuple[str, Decimal, int]]] = {}
    # StockFlow exige (tipo, número) único. NUMERO es un correlativo global en
    # StockFácil, así que normalmente no choca; si choca (bases mezcladas,
    # renumeraciones), se sigue desde el máximo en vez de abortar todo.
    usados: dict[str, set[int]] = {}
    tope: dict[str, int] = {}
    for t_, n_ in sq.execute("SELECT type, MAX(number) FROM sales GROUP BY type"):
        tope[t_] = int(n_ or 0)

    # Los repetidos van DETRÁS del mayor NUMERO de todo el origen. Antes recibían
    # "el mayor visto hasta ahora + 1", que era el número de una venta posterior:
    # esa también se renumeraba y seguía en cascada (en Nemesis, 23.953 ventas
    # con otro número por unos 60 repetidos). Así cambian sólo los repetidos.
    try:
        mayor_origen = int(qn(con, "SELECT MAX(NUMERO) FROM VENTA") or 0) if "VENTA" in hay else 0
    except (TypeError, ValueError):
        mayor_origen = 0
    siguiente_libre = [max(mayor_origen, max(tope.values(), default=0)) + 1]

    def numero_libre(tipo_: str, pedido: int) -> int:
        vistos = usados.setdefault(tipo_, set())
        n_ = int(pedido or 0)
        if n_ <= 0 or n_ in vistos:
            n_ = siguiente_libre[0]
            siguiente_libre[0] += 1
            rep.suma("Ventas renumeradas por número repetido", 1)
        vistos.add(n_)
        tope[tipo_] = max(tope.get(tipo_, 0), n_)
        return n_
    # Datos del comprobante ARCA que StockFácil guarda en la venta. CODIGOCAE es
    # el código de barras: CUIT(11) + tipo(2) + punto de venta(4) + CAE(14) +
    # vencimiento(8) + dígito. De ahí salen el PV real y el tipo; NROCOMP es el
    # número que autorizó ARCA (NUMERO es el correlativo interno del sistema
    # viejo y NO coincide: en Denver la Factura B 1246 era la venta 61639).
    CODIGO_POR_LETRA = {"A": 1, "B": 6, "C": 11}
    omitidas: dict[str, list] = {}

    def vendedor_de(v) -> str:
        """VENTA.USUARIO es el IDUSUARIO de quien cobró (en Denver, 5 vendedores
        con 60.000 ventas repartidas). Antes todas quedaban a nombre del admin
        y "Ventas por vendedor" arrancaba en blanco. Lo que no se reconoce
        (0, vacío, texto) cae en el admin."""
        return usuario_de(v, uid)
    for r in leer(con, "VENTA", campos_v, "ORDER BY IDVENTA") if "VENTA" in hay else []:
        total = r["TOTAL"]
        if total is None:
            continue
        letra_sf = txt(r["LETRA"]).upper()
        # Notas de crédito y presupuestos NO son ventas. StockFácil los guarda
        # en VENTA con LETRA "NOTA DE CREDITO B" / "PRESUPUESTO"; `letra()` los
        # leería como Factura B y una devolución de $4.200 entraría como una
        # venta más de $4.200. StockFlow tiene módulos propios para las dos
        # cosas; acá se omiten y se avisa cuáles fueron.
        if "NOTA DE CREDITO" in letra_sf or "PRESUPUESTO" in letra_sf:
            f_ = r["FECHA"]
            omitidas.setdefault(letra_sf, []).append(
                f"N° {r['NUMERO']} del {f_.strftime('%Y-%m-%d') if f_ else '?'} por ${total}"
                + (" (CON CAE)" if txt(r["CAE"]) else ""))
            continue
        # En las bases reales el cliente de la venta está en CLIENTE (id de
        # CLIENTES); IDCLIENTE/IDPERSONA no existen o vienen vacíos. Sin esto,
        # el 100% de las ventas quedaba a Consumidor Final.
        cliente = (cli_id.get(r["CLIENTE"]) if r["CLIENTE"] is not None else None) \
            or (cli_id.get(r["IDCLIENTE"]) if r["IDCLIENTE"] is not None else None) \
            or (cli_por_persona.get(r["IDPERSONA"]) if r["IDPERSONA"] is not None else None) \
            or cf_id
        if not cliente:
            rep.aviso("venta sin cliente identificable: se omite")
            continue
        anulada = txt(r["ESTADO"]).upper().startswith("ANUL")
        tipo = letra(r["LETRA"])
        cae = txt(r["CAE"]) or None
        nota = None
        # Una "factura" que nunca obtuvo CAE no es una factura: ARCA no la
        # conoce. Si entrara como tipo A/B/C sin CAE, StockFlow la mostraría
        # como comprobante fiscal PENDIENTE con botón para pedir el CAE — de
        # una venta de hace un mes, que ARCA rechaza por fecha o, peor,
        # autoriza como si fuera de hoy. Entra como comprobante interno (X) y
        # queda dicho en la nota qué era. En Denver eran 376 (ESTADOFE vacío o
        # RECHAZADO).
        if tipo in ("A", "B", "C") and not cae:
            nota = f"En StockFácil figuraba como {letra_sf} sin CAE ({txt(r['ESTADOFE']) or 'sin respuesta de ARCA'})"
            tipo = "X"
            rep.suma("Facturas sin CAE (entran como comprobante interno X)", 1)
        vid = uuid7()
        fecha = ms(r["FECHA"], r["HORA"])
        iva_d = Decimal(dec(r["IVA"]))
        total_d = Decimal(dec(total))
        # Descuento global: VENTA.DESCUENTO es un IMPORTE (total = suma de los
        # renglones − DESCUENTO). RECARGO, donde existe, suma al total: para
        # StockFlow es un descuento negativo.
        desc_d = Decimal(dec(r["DESCUENTO"])) - Decimal(dec(r["RECARGO"]))
        # `subtotal` en StockFlow (modo 'gross') es la suma de los renglones CON
        # IVA antes del descuento global: total = subtotal − descuento. Antes se
        # guardaba el neto (total − IVA) y, con descuento, el detalle mostraba un
        # subtotal menor que el descuento, y el Libro IVA, las devoluciones y el
        # desglose de la Factura A prorrateaban el descuento sobre otra base.
        subtotal_d = total_d + desc_d
        es_cta = r["IDCUENTA"] not in (None, 0, "")
        numero = numero_libre(tipo, r["NUMERO"] or 0)
        # `jornada` (día de caja, migración 0036) NO se escribe acá: la completa
        # el trigger trg_sales_jornada_ins de la base con la apertura de la caja,
        # por eso las cajas se insertan ANTES que las ventas.
        sq.execute(
            "INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,"
            "is_account_sale,subtotal,discount,vat_amount,total,status,afip_cae,notes,"
            "created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (vid, numero, tipo, fecha, cliente, vendedor_de(r["USUARIO"]),
             caja_map.get(r["IDCAJA"]) or caja_id, 1 if es_cta else 0,
             dec(subtotal_d), dec(desc_d), dec(iva_d), dec(total_d),
             "voided" if anulada else "completed", cae, nota, fecha, fecha))
        venta_map[r["IDVENTA"]] = vid
        venta_fecha[r["IDVENTA"]] = fecha
        rep.suma("Ventas", 1)
        if es_cta:
            try:
                venta_cuenta.setdefault(int(r["IDCUENTA"]), []).append((vid, Decimal(str(total)), fecha))
            except (TypeError, ValueError):
                pass
            rep.suma("  …a cuenta corriente", 1)
        elif not anulada and Decimal(str(total)) > 0:
            # Un pago por venta con su forma de pago: sin esto "Ventas por
            # forma de pago" arrancaba en cero para todo el histórico.
            pmid = pm_para(r["FORMAPAGO"]) or efectivo_pm
            if pmid:
                sq.execute(
                    "INSERT INTO sale_payments (id,sale_id,payment_method_id,amount,net_amount,created_at) "
                    "VALUES (?,?,?,?,?,?)",
                    (uuid7(), vid, pmid, dec(total), dec(total), fecha))

        if cae:
            rep.suma("Facturas con CAE", 1)
            # El comprobante fiscal, como lo registra StockFlow cuando emite:
            # así el Historial muestra "Factura B 00004-00001246", la
            # reimpresión y el archivo PDF usan el número de ARCA y no el
            # interno, y "archivar pendientes" no inventa punto de venta.
            codbar = re.sub(r"\D", "", txt(r["CODIGOCAE"]))
            pv = int(codbar[13:17]) if len(codbar) >= 17 and codbar[13:17].isdigit() else None
            vcode = int(codbar[11:13]) if len(codbar) >= 13 and codbar[11:13].isdigit() else None
            if pv is None:
                pv = punto_venta_viejo or 1
            if not vcode:
                vcode = CODIGO_POR_LETRA.get(tipo, 6)
            nro = r["NROCOMP"] if r["NROCOMP"] not in (None, "", 0) else r["NUMERO"]
            try:
                nro = int(Decimal(str(nro).strip()))
            except (TypeError, ValueError, InvalidOperation):
                nro = 0
            venc = None
            v8 = re.sub(r"\D", "", txt(r["VENCCAE"]))
            if len(v8) == 8:
                try:
                    venc = ms(datetime(int(v8[:4]), int(v8[4:6]), int(v8[6:8])))
                except ValueError:
                    venc = None   # fecha imposible: sin esto cancelaba la migración entera
            # Neto e IVA al centavo, que es como los informó a ARCA: neto + IVA =
            # total exacto (con 4 decimales arrastraban el ruido del float con
            # que StockFácil guarda el IVA).
            total2 = Decimal(centavos(total_d)) / 100
            iva2 = Decimal(centavos(iva_d)) / 100
            neto2 = total2 - iva2
            cli = sq.execute("SELECT doc_type, doc_number, last_name, first_name FROM customers WHERE id = ?", (cliente,)).fetchone()
            doc_tipo = 80 if (cli and cli[0] == "CUIT") else (96 if (cli and cli[0] == "DNI" and cli[1]) else 99)
            doc_nro = (cli[1] if cli and cli[1] and doc_tipo != 99 else "0")
            # Mismo formato que al emitir: "Apellido, Nombre".
            nombre_cli = ", ".join(x for x in ((cli[2] if cli else None), (cli[3] if cli else None)) if x) or "CONSUMIDOR FINAL"
            fv_id = uuid7()
            try:
                sq.execute(
                    "INSERT INTO fiscal_vouchers (id,voucher_code,letter,kind,sale_point,number,date,sale_id,"
                    "customer_id,customer_doc_type,customer_doc_number,customer_name,net_amount,vat_amount,"
                    "total,cae,cae_expiry,status,qr_url,user_id,created_at,updated_at) "
                    "VALUES (?,?,?,'invoice',?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',?,?,?,?)",
                    (fv_id, vcode, tipo, pv, nro, fecha, vid, cliente, doc_tipo, str(doc_nro),
                     nombre_cli[:120], f"{neto2:.2f}", f"{iva2:.2f}", dec(total_d), cae, venc,
                     url_qr_arca(codbar[:11], pv, vcode, nro, total2, doc_tipo, str(doc_nro), cae, fecha),
                     uid, fecha, fecha))
                rep.suma("  …con su comprobante fiscal (PV/número de ARCA)", 1)
                # La Factura C no discrimina IVA: no lleva detalle por alícuota.
                if tipo in ("A", "B"):
                    comprobantes.append((fv_id, vid, neto2, iva2, total2, desc_d))
                    ventas_con_comprobante.add(vid)
                if (pv, vcode) not in ultimo_cbte or nro > ultimo_cbte[(pv, vcode)][0]:
                    ultimo_cbte[(pv, vcode)] = (nro, fecha)
            except sqlite3.IntegrityError as e:
                rep.aviso(f"comprobante {tipo} {pv}-{nro} de la venta {r['NUMERO']} no se pudo registrar: {e}")
    for letra_sf, lista in omitidas.items():
        rep.aviso(f"{len(lista)} {letra_sf} NO migradas (no son ventas; cargar a mano si hace falta): "
                  + "; ".join(lista[:4]) + (" …" if len(lista) > 4 else ""))
    # El punto de venta y el último número que usó StockFácil, sacados de los
    # comprobantes. NINGUNA de las dos fuentes es definitiva: MIEMPRESA.PUNTO
    # puede estar viejo (Denver decía 3 y facturaba por el 4) y los códigos de
    # barras pueden traer otro número que el habilitado en ARCA (Nemesis: los
    # comprobantes decían 4 y el punto habilitado era el 7, el de MIEMPRESA).
    # El valor definitivo sale de «Consultar en ARCA» en StockFlow.
    nombres_cbte = {1: "Factura A", 6: "Factura B", 11: "Factura C",
                    2: "Nota de débito A", 7: "Nota de débito B", 12: "Nota de débito C"}
    for (pv_, cod_), (nro_, fecha_) in sorted(ultimo_cbte.items()):
        rep.aviso(f"último comprobante con CAE: {nombres_cbte.get(cod_, f'código {cod_}')} "
                  f"PV {pv_} N° {nro_} ({datetime.fromtimestamp(fecha_ / 1000):%d/%m/%Y}). "
                  "Confirmar el punto de venta con «Consultar en ARCA» antes de configurarlo en StockFlow.")
    pv_comprobantes = sorted({pv_ for (pv_, _cod) in ultimo_cbte})
    if punto_venta_viejo is not None and pv_comprobantes and punto_venta_viejo not in pv_comprobantes:
        rep.aviso(f"OJO: MIEMPRESA.PUNTO dice {punto_venta_viejo} pero los comprobantes dicen "
                  f"{', '.join(str(x) for x in pv_comprobantes)}. Uno de los dos NO es el punto habilitado en "
                  "ARCA para web services: en StockFlow, Facturación Electrónica → «Consultar en ARCA» "
                  "muestra los que sirven. No facturar hasta confirmarlo.")

    art_borrado: str | None = None
    lineas_migradas: set[int] = set()
    renglones_por_venta: dict[str, int] = {}
    # Bruto (con IVA, ya descontado) por alícuota de cada venta con comprobante
    # A/B: de ahí sale el detalle de IVA cuando hay más de una alícuota.
    brutos_cbte: dict[str, dict[str, Decimal]] = {}
    # OJO: en LINEAVENTA la referencia a la venta se llama VENTA, no IDVENTA.
    for r in leer(con, "LINEAVENTA",
                  ["IDLV", "VENTA", "IDVENTA", "IDARTICULO", "CANTIDAD", "PRECIO", "DESCUENTO",
                   "MDESC", "TOTAL", "COSTO", "IVA", "NUMLINEA"]) if "LINEAVENTA" in hay else []:
        idv = r["VENTA"] if r["VENTA"] is not None else r["IDVENTA"]
        sid = venta_map.get(idv)
        if not sid:
            continue
        if r["IDLV"] is not None:
            lineas_migradas.add(r["IDLV"])
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
                    (art_borrado, ean_libre(999999), "Artículo eliminado en StockFácil",
                     "21.00", dec(0), dec(0), dec(0, 3), ahora, ahora))
                rep.aviso("hay ventas de artículos ya borrados: se conservan con un artículo de respaldo")
            aid = art_borrado
        cant = Decimal(dec(r["CANTIDAD"], 3))
        precio = Decimal(dec(r["PRECIO"]))
        bruto = cant * precio
        # En StockFlow el renglón cumple line_total = cantidad × precio −
        # descuento, con el descuento como IMPORTE. En StockFácil
        # LINEAVENTA.DESCUENTO es un PORCENTAJE (30 = 30 %), MDESC el importe y
        # TOTAL el renglón ya descontado. Antes se guardaba el 30 como $30 y el
        # renglón sin descontar: el detalle no sumaba el total de la venta y
        # Estadísticas y el Libro IVA contaban de más.
        neto_l = Decimal(dec(r["TOTAL"])) if r["TOTAL"] is not None else None
        # Devolución dentro de una venta: StockFácil la guarda con cantidad Y
        # precio negativos (−1 × −1000) y TOTAL −1000. Multiplicar daba +1000:
        # el renglón sumaba en vez de restar. Manda el signo de TOTAL; sin él,
        # dos negativos se leen como devolución.
        if neto_l is not None and neto_l != 0 and bruto != 0:
            invertir = (bruto > 0) != (neto_l > 0)
        else:
            invertir = cant < 0 and precio < 0
        if invertir:
            precio, bruto = -precio, -bruto
            rep.suma("  …renglones de devolución (restan del total)", 1)
        if neto_l is not None:
            descuento_l = bruto - neto_l
        elif r["MDESC"] is not None:
            descuento_l = Decimal(dec(r["MDESC"]))
            neto_l = bruto - descuento_l
        else:
            descuento_l, neto_l = Decimal(0), bruto
        # Costo CONGELADO al vender (migración 0024): LINEAVENTA.COSTO es el
        # costo unitario que tenía el artículo ese día (= su PRECIO1). Sin él,
        # el margen de Estadísticas usa el costo de HOY para ventas de años
        # atrás, y con la inflación todo lo viejo sale a pérdida. Costo 0 o
        # vacío = sin dato: queda NULL y la app usa el costo actual.
        costo_l = Decimal(dec(r["COSTO"]))
        costo_venta = (dec(costo_l * factor_iva_art.get(r["IDARTICULO"], Decimal(1)))
                       if costo_l > 0 else None)
        tasa = alicuota_valida(r["IVA"])
        nlin = renglones_por_venta[sid] = renglones_por_venta.get(sid, 0) + 1
        sq.execute(
            "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,unit_price,"
            "discount,vat_rate,line_total,cost_at_sale,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uuid7(), sid, aid, nlin, dec(cant, 3), dec(precio), dec(descuento_l), tasa,
             dec(neto_l), costo_venta, venta_fecha.get(idv, ahora)))
        if sid in ventas_con_comprobante:
            grupo = brutos_cbte.setdefault(sid, {})
            grupo[tasa] = grupo.get(tasa, Decimal(0)) + neto_l
        rep.suma("Líneas de venta", 1)
    renglones_por_venta.clear()

    # ---- DETALLE DE IVA DE LOS COMPROBANTES (fiscal_voucher_vat) ----
    # StockFlow guarda una fila por alícuota de cada comprobante que emite. La
    # nota de crédito la toma de ahí: sin filas, una NC sobre una factura
    # migrada salía "todo neto" (IVA 0, que ARCA rechaza en una NC A/B), y la
    # reimpresión de una Factura A salía sin el IVA discriminado.
    for fv_id, sid, neto2, iva2, total2, desc_venta in comprobantes:
        for vat_id, base, imp in detalle_iva(brutos_cbte.get(sid, {}), neto2, iva2, total2, desc_venta):
            sq.execute(
                "INSERT INTO fiscal_voucher_vat (id,voucher_id,vat_id,base_amount,vat_amount) "
                "VALUES (?,?,?,?,?)", (uuid7(), fv_id, vat_id, base, imp))
        if len(brutos_cbte.get(sid, {})) > 1:
            rep.suma("  …comprobantes con más de una alícuota de IVA", 1)
    brutos_cbte.clear()

    # Control: el detalle de cada venta tiene que sumar su subtotal (así lo
    # calcula StockFlow). Si en otra base TOTAL/MDESC significan otra cosa,
    # salta acá y no recién cuando el contador mira el Libro IVA.
    descuadradas = sq.execute(
        "SELECT COUNT(*) FROM sales s JOIN (SELECT sale_id, SUM(CAST(line_total AS REAL)) AS t "
        "FROM sale_lines GROUP BY sale_id) l ON l.sale_id = s.id "
        "WHERE ABS(CAST(s.subtotal AS REAL) - l.t) > 0.05").fetchone()[0]
    if descuadradas:
        rep.aviso(f"{descuadradas} venta(s) cuyo detalle no suma su subtotal: abrir algunas en "
                  "Historial de ventas y compararlas con StockFácil antes de entregar")

    # ---- MEDIOS DE PAGO QUE SE USAN HOY ----
    # Nacen inactivos (ver medio_de_pago), pero los que el comercio usó de
    # verdad en el último año tienen que quedar ACTIVOS: en Nemesis Mercado Pago
    # fue el 41 % de las ventas y el cajero no podía cobrar con él al día
    # siguiente. El mínimo de 100 usos deja afuera la basura tipeada
    # ("Mercadopago 7790895000454", "Ç").
    hace_un_anio = ahora - 365 * 24 * 3600 * 1000
    activados = sq.execute(
        "UPDATE payment_methods SET active = 1 WHERE active = 0 AND id IN ("
        "  SELECT payment_method_id FROM sale_payments WHERE created_at >= ?"
        "  GROUP BY payment_method_id HAVING COUNT(*) >= 100)", (hace_un_anio,)).rowcount
    if activados:
        nombres = [n for (n,) in sq.execute(
            "SELECT name FROM payment_methods WHERE active = 1 AND id IN ("
            "  SELECT payment_method_id FROM sale_payments WHERE created_at >= ?"
            "  GROUP BY payment_method_id HAVING COUNT(*) >= 100)", (hace_un_anio,))]
        rep.aviso(f"medios de pago activos porque se usaron en el último año: {', '.join(nombres)}")

    # ---- COMPRAS ----
    compra_map: dict[int, str] = {}
    compra_fecha: dict[int, int] = {}
    prov_generico: list[str] = []

    def proveedor_generico() -> str:
        """Compras con PROVEEDOR = 0 o que apunta a nada. Antes iban al PRIMER
        proveedor de la lista, que no tenía nada que ver con esas compras.
        Ahora van a uno genérico, visible."""
        if not prov_generico:
            pid_ = uuid7()
            sq.execute(
                "INSERT INTO suppliers (id,code,name,created_at,updated_at) VALUES (?,?,?,?,?)",
                (pid_, codigo_libre("PROV-0001", 0), "Proveedor sin identificar (de StockFácil)", ahora, ahora))
            prov_generico.append(pid_)
            rep.aviso("hay compras sin proveedor: quedaron en 'Proveedor sin identificar (de StockFácil)'")
        return prov_generico[0]
    # Donde existen VDESC/VIVA, son los IMPORTES y DESCUENTO/IVA los
    # PORCENTAJES (DESCUENTO 1,5 = 1,5 %; VDESC, la plata descontada).
    cols_compra = set(columnas(con, "COMPRA")) if "COMPRA" in hay else set()
    percepciones = [c for c in ("IMPINTERNO", "PERCIVA", "PERCIIBB", "OTRASPERC") if c in cols_compra]
    for r in leer(con, "COMPRA", ["IDCOMPRA", "FECHA", "NUMERO", "LETRA", "PROVEEDOR",
                                  "SUBTOTAL", "IVA", "VIVA", "DESCUENTO", "VDESC", "TOTAL",
                                  "FORMAPAGO", "ESTADO"] + percepciones,
                  "ORDER BY IDCOMPRA") if "COMPRA" in hay else []:
        # Sin proveedor reconocible (también si el comercio nunca cargó
        # proveedores): uno genérico, para no perder la compra.
        prov = prov_id.get(r["PROVEEDOR"]) or prov_por_persona.get(r["PROVEEDOR"]) or proveedor_generico()
        cid = uuid7()
        fecha = ms(r["FECHA"])
        nro_txt = txt(r["NUMERO"])
        try:
            sub = Decimal(dec(r["SUBTOTAL"]))
            iva = Decimal(dec(r["VIVA"] if "VIVA" in cols_compra else r["IVA"]))
            descuento = Decimal(dec(r["VDESC"] if "VDESC" in cols_compra else r["DESCUENTO"]))
            percep = sum((Decimal(dec(r[c])) for c in percepciones), Decimal(0))
            # El total es lo que se PAGÓ (TOTAL), con descuento y percepciones.
            # Antes era SUBTOTAL + IVA: ignoraba los dos y no coincidía con el
            # egreso de caja de esa misma compra.
            total = (Decimal(dec(r["TOTAL"])) if r["TOTAL"] is not None
                     else sub + iva - descuento + percep)
            notas = []
            if txt(r["FORMAPAGO"]).upper().startswith("CUENTA CORRIENTE"):
                # StockFlow pediría su cuenta por pagar si entrara 'a crédito', y
                # las cuentas de proveedor de StockFácil no se migran.
                notas.append("Comprada a cuenta corriente del proveedor en StockFácil")
            if percep:
                notas.append(f"El total incluye percepciones/impuestos por {percep:.2f}")
            # `number` es el correlativo INTERNO (como en StockFlow, que sigue
            # desde el máximo): el IDCOMPRA. El número del comprobante del
            # proveedor ("0003-00012345", texto libre) va TAL CUAL en su columna,
            # que es la que muestran el detalle, el Libro IVA Compras y la que usa
            # "Facturas por teléfono" para avisar que una factura ya se cargó.
            sq.execute(
                "INSERT INTO purchases (id,number,type,supplier_invoice_number,date,supplier_id,"
                "payment_type,subtotal,discount,vat_amount,total,status,notes,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (cid, int(r["IDCOMPRA"] or 0), letra(r["LETRA"]), nro_txt or None, fecha, prov,
                 "cash", dec(sub), dec(descuento), dec(iva), dec(total),
                 "voided" if txt(r["ESTADO"]).upper().startswith("ANUL") else "completed",
                 "; ".join(notas) or None, fecha, fecha))
        except (sqlite3.Error, ValueError, TypeError, InvalidOperation) as e:
            rep.aviso(f"compra {r['IDCOMPRA']} (N° {nro_txt or '?'}) no se pudo migrar: {e}")
            continue
        compra_map[r["IDCOMPRA"]] = cid
        compra_fecha[r["IDCOMPRA"]] = fecha
        rep.suma("Compras", 1)

    # ---- LO QUE SE LES DEBE A LOS PROVEEDORES ----
    # CUENTASP es la cuenta corriente de cada proveedor (IDCLIENTE = el
    # IDEMPRESA del proveedor) y SALDO, lo que se le debe hoy. Antes no se
    # migraba y la deuda desaparecía.
    # Va como en StockFlow: una compra a cuenta corriente "saldo anterior" con su
    # cuenta por pagar, así figura en Cuentas Corrientes — Proveedores y se paga
    # desde ahí. Los renglones viejos ya están en las compras de arriba.
    if "CUENTASP" in hay:
        nro_saldo = (sq.execute("SELECT COALESCE(MAX(number),0) FROM purchases").fetchone()[0] or 0)
        for r in leer(con, "CUENTASP", ["IDCUENTA", "IDCLIENTE", "SALDO", "ESTADO"]):
            saldo = Decimal(dec(r["SALDO"] or 0))
            if saldo < 1:                       # milésimos de redondeo: no es deuda
                continue
            prov = prov_id.get(r["IDCLIENTE"]) or proveedor_generico()
            nro_saldo += 1
            pid_ = uuid7()
            try:
                sq.execute(
                    "INSERT INTO purchases (id,number,type,supplier_invoice_number,date,supplier_id,"
                    "payment_type,subtotal,discount,vat_amount,total,status,notes,created_at,updated_at) "
                    "VALUES (?,?,'X',?,?,?,'credit',?,'0.0000','0.0000',?,'completed',?,?,?)",
                    (pid_, nro_saldo, f"Saldo anterior (cuenta {r['IDCUENTA']})", ahora, prov,
                     dec(saldo), dec(saldo), "Saldo de cuenta corriente traído de StockFácil", ahora, ahora))
                sq.execute(
                    "INSERT INTO supplier_accounts_payable (id,supplier_id,purchase_id,total,balance,"
                    "status,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?)",
                    (uuid7(), prov, pid_, dec(saldo), dec(saldo), ahora, ahora))
                rep.suma("Deudas con proveedores (saldo de cuenta corriente)", 1)
            except sqlite3.Error as e:
                rep.aviso(f"deuda con el proveedor de la cuenta {r['IDCUENTA']} no migrada: {e}")

    renglones_por_compra: dict[str, int] = {}
    for r in leer(con, "LINEACOMPRA",
                  ["COMPRA", "IDCOMPRA", "IDARTICULO", "CANTIDAD", "PRECIO", "DESCUENTO",
                   "IVA", "NUMLINEA"]) if "LINEACOMPRA" in hay else []:
        idc_ = r["COMPRA"] if r["COMPRA"] is not None else r["IDCOMPRA"]
        pid = compra_map.get(idc_)
        aid = art_id.get(r["IDARTICULO"])
        if not pid or not aid:
            continue
        cant = r["CANTIDAD"] or 0
        precio = r["PRECIO"] or 0
        # Renglones numerados 1..n como los numera StockFlow (NUMLINEA viene
        # vacío en bases reales y todos quedaban "1").
        nlin = renglones_por_compra[pid] = renglones_por_compra.get(pid, 0) + 1
        try:
            sq.execute(
                "INSERT INTO purchase_lines (id,purchase_id,article_id,line_number,quantity,"
                "cost_price,sale_price,vat_rate,line_total,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                (uuid7(), pid, aid, nlin, dec(cant, 3), dec(precio), dec(precio),
                 alicuota_valida(r["IVA"]),
                 dec(Decimal(str(cant)) * Decimal(str(precio))), compra_fecha.get(idc_, ahora)))
            rep.suma("Líneas de compra", 1)
        except sqlite3.Error:
            pass
    renglones_por_compra.clear()

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
    ya_en_venta = 0
    for l in leer(con, "LINEACUENTA", ["IDCUENTA", "IDARTICULO", "CODIGO", "DETALLE",
                                       "CANTIDAD", "PRECIO", "TOTAL", "FECHA", "TIPO", "IDLV"]
                  ) if "LINEACUENTA" in hay else []:
        if txt(l["TIPO"]).lower() != "linea":
            continue          # los 'pago' viajan por PAGOS
        # El renglón ya está en la venta real (LINEACUENTA.IDLV → LINEAVENTA):
        # repetirlo acá contaba la misma mercadería dos veces (A22).
        if l["IDLV"] is not None and l["IDLV"] in lineas_migradas:
            ya_en_venta += 1
            continue
        lineas_cta.setdefault(l["IDCUENTA"], []).append(l)
    if ya_en_venta:
        rep.suma("Renglones de cuenta que ya viajaron con su venta (no se duplican)", ya_en_venta)

    pagos_cta: dict[int, list[dict]] = {}
    for pg in leer(con, "PAGOS", ["IDCUENTA", "ENTREGA", "FECHA"]) if "PAGOS" in hay else []:
        pagos_cta.setdefault(pg["IDCUENTA"], []).append(pg)

    efectivo_id = pm_id.get("EFECTIVO") or next(iter(pm_id.values()), None)

    art_saldo_id = uuid7()
    sq.execute(
        "INSERT INTO articles (id,barcode,description,vat_rate,cost_price,list_price1,"
        "stock,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)",
        (art_saldo_id, ean_libre(999998),
         "Consumos anteriores de cuenta corriente (StockFácil)",
         "21.00", dec(0), dec(0), dec(0, 3), ahora, ahora))

    nro_saldo = (sq.execute("SELECT COALESCE(MAX(number),0) FROM sales").fetchone()[0] or 0)
    for r in leer(con, "CUENTAS", ["IDCUENTA", "IDCLIENTE", "TOTAL", "SALDO", "FECHAINI"]
                  ) if "CUENTAS" in hay else []:
        saldo = Decimal(dec(r["SALDO"]))
        total_cta = Decimal(dec(r["TOTAL"]))
        # Menos de un centavo es ruido del float de StockFácil (saldos de
        # milésimos): como deuda dejaba la cuenta "abierta" por nada.
        if abs(saldo) < Decimal("0.01"):
            saldo = Decimal(0)
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
            fecha = ms(r["FECHAINI"])
            reales = venta_cuenta.get(r["IDCUENTA"], [])
            total_reales = sum((t for _, t, _ in reales), Decimal(0))
            renglones = [l for l in lineas_cta.get(r["IDCUENTA"], []) if art_id.get(l["IDARTICULO"])]
            suma_lin = sum((Decimal(str(l["TOTAL"] or 0)) for l in renglones), Decimal(0))
            # Lo consumido antes de lo que guardan VENTA y LINEACUENTA, dicho
            # como lo que es: un arrastre. Sin este renglón la cuenta no
            # cerraría contra el total que el comercio tiene por bueno. Las
            # ventas reales de la cuenta ya viajaron como ventas (a cuenta):
            # no se vuelven a sumar acá (A22).
            resto = total_cta - total_reales - suma_lin
            total_sintetica = suma_lin + (resto if resto > 0 else Decimal(0))

            if total_sintetica > 0 or not reales:
                nro_saldo += 1
                vid = uuid7()
                sq.execute(
                    "INSERT INTO sales (id,number,type,date,customer_id,seller_id,cash_register_id,"
                    "is_account_sale,subtotal,discount,vat_amount,total,status,notes,"
                    "created_at,updated_at) VALUES (?,?,?,?,?,?,?,1,?,?,?,?,'completed',?,?,?)",
                    (vid, nro_saldo, "X", fecha, cliente, uid, caja_id,
                     dec(total_sintetica), dec(0), dec(0), dec(total_sintetica),
                     "Saldo de cuenta corriente traído de StockFácil"
                     + (f" (además de {len(reales)} venta(s) a cuenta migradas aparte)" if reales else ""),
                     fecha, fecha))
                usados.setdefault("X", set()).add(nro_saldo)

                # Los artículos que compró y que no están en una venta real.
                nlin = 0
                for l in renglones:
                    aid = art_id.get(l["IDARTICULO"])
                    nlin += 1
                    imp = Decimal(str(l["TOTAL"] or 0))
                    sq.execute(
                        "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,"
                        "unit_price,discount,vat_rate,line_total,created_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (uuid7(), vid, aid, nlin, dec(l["CANTIDAD"] or 0, 3),
                         dec(l["PRECIO"] or 0), dec(0), "21.00", dec(imp), ms(l["FECHA"])))
                    rep.suma("Renglones de cuenta corriente", 1)

                if resto > 0 and art_saldo_id:
                    sq.execute(
                        "INSERT INTO sale_lines (id,sale_id,article_id,line_number,quantity,"
                        "unit_price,discount,vat_rate,line_total,created_at) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (uuid7(), vid, art_saldo_id, nlin + 1, dec(1, 3), dec(resto),
                         dec(0), "21.00", dec(resto), fecha))
            else:
                # Todo el total de la cuenta está explicado por ventas reales:
                # la cuenta cuelga de la última de ellas, sin venta sintética.
                vid = reales[-1][0]
                fecha = reales[-1][2]

            arid = uuid7()
            # La misma regla que StockFlow al registrar un pago: saldo 0 →
            # pagada, saldo igual al total → abierta, cualquier otro → parcial.
            estado = "paid" if saldo == 0 else ("open" if saldo == total_cta else "partial")
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
                                     "IDVENTA", "IDMOVIMIENTOS", "IDUSUARIO"]) if "LINEACAJA" in hay else []:
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
        # La fecha real del movimiento: la de la venta o la compra si la hay, si
        # no la apertura de esa caja. Con `ahora`, 62.596 movimientos históricos
        # de Denver quedaban fechados el día de la migración. LINEACAJA.IDVENTA
        # guarda el IDCOMPRA en las compras y otro número en los movimientos
        # manuales: buscarlo siempre entre las ventas fechaba esos movimientos
        # con el día de una venta cualquiera, a veces años antes de su caja.
        if motivo.startswith("VENTA"):
            fecha_mov = venta_fecha.get(r["IDVENTA"])
        elif motivo.startswith("COMPRA"):
            fecha_mov = compra_fecha.get(r["IDVENTA"])
        else:
            fecha_mov = None
        fecha_mov = fecha_mov or caja_fecha.get(r["CAJA"]) or ahora
        sq.execute(
            "INSERT INTO cash_movements (id,cash_register_id,type,description,amount,date,"
            "user_id,related_sale_id,related_purchase_id,payment_method_id,created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (uuid7(), cid, tipo, txt(r["MOTIVO"])[:80] or "Movimiento", dec(monto), fecha_mov,
             usuario_de(r["IDUSUARIO"], caja_usuario.get(r["CAJA"], uid)),
             venta, compra, pm_para(r["DETALLE"]), fecha_mov))
        rep.suma("Movimientos de caja", 1)

    # El comercio vende sin haber cargado la compra: sin esto el sistema le
    # bloquearía la venta de todo lo que quedó en negativo.
    sq.execute("UPDATE companies SET allow_negative_stock = 1")

    # ---- FICHA DEL COMERCIO ----
    # Los datos están en MIEMPRESA, pero con los campos CORRIDOS: el programa
    # usa ese registro para el encabezado de la factura y guardó el CUIT en la
    # columna EMAIL y los Ingresos Brutos en WEB. Sin esto había que recargar
    # nombre, domicilio, CUIT e IIBB a mano después de cada migración.
    if "MIEMPRESA" in hay:
        for r in leer(con, "MIEMPRESA", ["NOMBRE", "DOMICILIO", "TEL", "EMAIL", "WEB"]):
            nombre = txt(r["NOMBRE"])
            if not nombre:
                continue
            cuit = re.sub(r"\D", "", txt(r["EMAIL"]))
            iibb = txt(r["WEB"])
            # En Denver el comercio cargó el CUIT también en WEB: eso no es un
            # número de Ingresos Brutos y no puede salir impreso como tal.
            if re.sub(r"\D", "", iibb) == cuit:
                iibb = ""
            sq.execute(
                "UPDATE companies SET name = ?, address = ?, phone = ?, "
                "cuit = COALESCE(NULLIF(?, ''), cuit), "
                "ing_brutos = COALESCE(NULLIF(?, ''), ing_brutos)",
                (nombre[:80], txt(r["DOMICILIO"])[:120] or None,
                 txt(r["TEL"])[:40] or None,
                 cuit if len(cuit) == 11 else "", iibb),
            )
            rep.aviso(
                f"ficha del comercio: '{nombre}'"
                + (f" · CUIT {cuit}" if len(cuit) == 11 else " · SIN CUIT (cargarlo a mano)")
                + (f" · IIBB {iibb} (CONFIRMAR con el cliente)" if iibb else "")
            )
            break
    if sq.execute("SELECT COUNT(*) FROM companies").fetchone()[0] == 0:
        rep.aviso("no hay ficha de comercio: activá 'vender sin stock' en Configuración")


# ------------------------------------------------------------------ paquete

def empaquetar(db: str, version_app: str = "migracion") -> None:
    """Arma un .zip con el MISMO formato que los backups de StockFlow
    (`database/stockflow.db` + `metadata.json`), así la base migrada se carga
    en la PC del cliente desde Configuración → Backup → Restaurar: la app
    cierra su base, la reemplaza, limpia el WAL y se reinicia. No hay que
    buscar la carpeta AppData ni cerrar nada a mano."""
    import json
    import zipfile
    if not os.path.isfile(db):
        sys.exit(f"No existe: {db}")
    # Todo lo escrito tiene que estar EN el .db antes de zipearlo: si quedara
    # algo en el -wal, el archivo dentro del zip estaría incompleto.
    c = sqlite3.connect(db)
    c.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    c.execute("PRAGMA journal_mode=DELETE")
    c.close()
    salida = os.path.join(os.path.dirname(os.path.abspath(db)),
                          f"stockflow-migrado-{time.strftime('%Y-%m-%d-%H%M%S')}.zip")
    with zipfile.ZipFile(salida, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(db, "database/stockflow.db")
        z.writestr("metadata.json", json.dumps({
            "createdAt": int(time.time() * 1000),
            "appVersion": version_app,
            "dbPath": os.path.abspath(db),
            "schemaVersion": "auto",
            "origen": "migracion StockFácil",
        }, indent=2))
    mb = os.path.getsize(salida) / 1048576
    print(f"Listo: {salida} ({mb:.1f} MB)")
    print("En la PC del cliente: StockFlow → Configuración → Backup → Restaurar → elegir este .zip.")


# ---------------------------------------------------------------- todo junto

def crear_base_vacia(destino: str) -> None:
    """Base de StockFlow nueva (esquema al día + admin), con el Electron del
    repo, que es el que tiene better-sqlite3 compilado para su ABI."""
    aqui = os.path.dirname(os.path.abspath(__file__))
    desktop = os.path.abspath(os.path.join(aqui, "..", "..", "apps", "desktop"))
    electron = os.path.join(desktop, "node_modules", ".bin", "electron")
    tsx = os.path.join(desktop, "node_modules", "tsx", "dist", "cli.mjs")
    script = os.path.join(aqui, "crear-db-vacia.ts")
    if not os.path.isfile(electron):
        sys.exit(f"No encuentro Electron en {electron}: correr `pnpm install` en el repo.")
    env = dict(os.environ, ELECTRON_RUN_AS_NODE="1")
    subprocess.run([electron, tsx, script, destino], check=True, env=env, cwd=desktop)


def todo(gdb: str, salida: str, precio: str, sin_iva: bool) -> None:
    """Migración completa de una sola vez, para el día en el local: levanta el
    motor, muestra qué hay, crea la base destino, migra, empaqueta y baja el
    motor. Repetible: si se vuelve a copiar el .GDB (el cliente siguió
    vendiendo), se corre de nuevo y sale un .zip nuevo."""
    os.makedirs(salida, exist_ok=True)
    destino = os.path.join(salida, f"stockflow-{time.strftime('%Y-%m-%d-%H%M%S')}.db")
    servidor(gdb)
    try:
        inspeccionar()
        print("\n" + "=" * 62 + f"\nMIGRANDO con lista {precio}, precios "
              f"{'SIN' if sin_iva else 'CON'} IVA incluido\n" + "=" * 62)
        crear_base_vacia(destino)
        migrar(destino, precio, iva_incluido=not sin_iva)
        empaquetar(destino)
    finally:
        bajar()


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
        # La lista de venta se elige A PROPÓSITO, nunca por defecto: en la base
        # de Leo Citzia PRECIO1 era el COSTO y PRECIO2 el precio al público. Un
        # default silencioso hubiera vendido todo al costo. Se decide mirando
        # `inspeccionar` contra una factura impresa del comercio.
        listas = ("PRECIO1", "PRECIO2", "PRECIO3", "PRECIO4", "PRECIOU")
        precio = sys.argv[3] if len(sys.argv) > 3 else ""
        if precio not in listas:
            sys.exit("Falta decir cuál de los precios de StockFácil es el de VENTA AL PÚBLICO.\n"
                     f"  python3 migrar.py migrar {sys.argv[2]} PRECIO2 [--sin-iva]\n"
                     f"  Opciones: {', '.join(listas)} (PRECIO1 suele ser el costo).\n"
                     "  Mirá 'python3 migrar.py inspeccionar' y comparalo con una factura impresa.")
        sin_iva = "--sin-iva" in sys.argv
        print(f"Lista de venta: {precio} — precios {'SIN' if sin_iva else 'CON'} IVA incluido "
              f"({'se les agrega el IVA' if sin_iva else 'se guardan tal cual'}).")
        migrar(sys.argv[2], precio, iva_incluido=not sin_iva)
    elif cmd == "empaquetar":
        if len(sys.argv) < 3:
            sys.exit("Falta la ruta a la base migrada (stockflow.db)")
        empaquetar(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "migracion")
    elif cmd == "todo":
        listas = ("PRECIO1", "PRECIO2", "PRECIO3", "PRECIO4", "PRECIOU")
        if len(sys.argv) < 5 or sys.argv[4] not in listas:
            sys.exit("Uso: python3 migrar.py todo /ruta/DBPV.GDB /carpeta/salida PRECIO2 [--sin-iva]\n"
                     f"  (la lista de VENTA al público es obligatoria: {', '.join(listas)})")
        todo(sys.argv[2], sys.argv[3], sys.argv[4], "--sin-iva" in sys.argv)
    elif cmd == "bajar":
        bajar()
    else:
        sys.exit(__doc__)
