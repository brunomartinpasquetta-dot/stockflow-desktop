"""Prototipo: proponer el artículo del sistema para cada renglón de factura.
Pistas: tamaño (ml/g) igual, palabras de marca/variedad, y abstenerse si no hay un candidato claro."""
import re, sqlite3, unicodedata, sys
db = sqlite3.connect(sys.argv[1])
ARTS = [(i, d) for i, d in db.execute("select id, description from articles where active=1")]

SIN = {"S/AZUC": "ZERO", "SIN AZUCAR": "ZERO", "RETOR": "RET", "RETORNABLE": "RET", "F.TROP": "FTROP", "F. TROP": "FTROP", "COCA-COLA": "COCA COLA", "IMP ": "IMPERIAL "}
RUIDO = {"CERVEZA", "PET", "X", "DE", "LTS", "LT", "L", "CC", "ML", "G", "GR", "U", "UN", "LATA", "BOTELLA", "DESC", "COMUN"}

def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().upper()
    for a, b in SIN.items(): s = s.replace(a, b)
    return s

def tamano(s):
    """Tamaño de la unidad en ml (o g). Entiende '12X500', '6X11/5', '6X 1/2', '8X1 1/4', '8X2 LTS', '1.5L', '473CC', 'X 1L X 12'."""
    s = norm(s)
    m = re.search(r"\b\d{1,2}\s*X\s*(1\s?1/[245]|11/[245]|1/2|1/4|\d+(?:[.,]\d+)?)\s*(LTS?|L|CC|ML|G|GR)?\b", s)   # pack X tamaño
    cand = None
    if m:
        v, u = m.group(1).replace(" ", ""), m.group(2)
        frac = {"11/2": 1500, "11/5": 1500, "11/4": 1250, "1/2": 500, "1/4": 250}
        if v in frac: return frac[v]
        x = float(v.replace(",", "."))
        if u and u.startswith("L"): return int(x * 1000)
        if x <= 5 and not u: return int(x * 1000)      # 8X2 → 2 litros
        return int(x)
    m = re.search(r"(\d+(?:[.,]\d+)?)\s*(LTS?|L|CC|ML|GRS?|G)\b", s)
    if m:
        x = float(m.group(1).replace(",", ".")); u = m.group(2)
        return int(x * 1000) if u.startswith("L") else int(x)
    return None

def palabras(s):
    s = norm(s)
    s = re.sub(r"\b\d{1,2}\s*X\s*[\d ./,]+(LTS?|L|CC|ML|G|GR)?\b", " ", s)
    s = re.sub(r"\b\d+(?:[.,]\d+)?\s*(LTS?|L|CC|ML|GRS?|G)\b", " ", s)
    return {w for w in re.findall(r"[A-Z]{2,}", s) if w not in RUIDO}

IDX = [(i, d, tamano(d), palabras(d)) for i, d in ARTS]

def proponer(desc):
    t, p = tamano(desc), palabras(desc)
    if not p: return None, []
    punt = []
    for i, d, ta, pa in IDX:
        if t and ta and t != ta: continue            # tamaños distintos: no es el mismo producto
        comun = p & pa
        if not comun: continue
        cubre_factura = len(comun) / len(p)          # todas las palabras de la factura deben estar
        cubre_art = len(comun) / len(pa)
        s = 0.6 * cubre_factura + 0.4 * cubre_art + (0.05 if t and ta else 0)
        punt.append((s, d, cubre_factura, cubre_art))
    punt.sort(reverse=True)
    if not punt: return None, []
    mejor = punt[0]
    seguro = mejor[2] == 1.0 and mejor[3] >= 0.99 and (len(punt) == 1 or mejor[0] - punt[1][0] >= 0.10) and t is not None
    return (mejor[1] if seguro else None), [x[1] for x in punt[:3]]

CASOS = [  # (renglón de la factura, artículo correcto en un drugstore cliente o None si no existe / es ambiguo)
 ("AGUA BONAQUA 12X500", "AGUA BONAQUA 500CC"), ("AGUA BONAQUA 6X11/5", "AGUA BONAQUA 1.5L"), ("COCA-COLA 12X500 PET", "COCA COLA  500CC"),
 ("FANTA-NARANJA 12X500 PET", "FANTA 500CC"), ("COCA-COLA S/AZUC 12X500", "COCA COLA ZERO 500CC"), ("AQUARIUS PERA 6X 1/2", "AQUARIUS 500CC PERA"),
 ("AQUARIUS MANZANA 6X 1/2", "AQUARIUS 500CC MANZANA"), ("AQUARIUS NARANJA 6X 1/2", "AQUARIUS 500CC NARANJA"), ("COCA-COLA VIDRIO 8X1 1/4", "COCA COLA VIDRIO 1.25L RET"),
 ("SPRITE VIDRIO 8X11/4", "SPRITE 1.25L VIDRIO RET"), ("FANTA NARANJA VIDRIO 8X11/4", None), ("CERVEZA TEMPLE WOLF IPA 6XX473", None), ("CERVEZA TEMPLE HONEY 6X473", None),
 ("CERVEZA TEMPLE SCOTTISH 6X473", None), ("COCA-COLA RETOR. 8X2 LTS", "COCA COLA  2L RET"), ("SPRITE RETOR. BX2 LTS", "SPRITE 2L RET"), ("SPEED CON CAFE 24X24", None),
 ("POWERADE MOUNTAIN BLAST 6X500", "POWERADE MOUNTAIN BLAST 500CC"), ("POWERADE F.TROP. 6X500", "POWERADE F. TROP 500CC"),
 ("CERVEZA IMPERIAL X 1L X 12", None), ("CERVEZA HEINEKEN X 1L X 12", "HEINEKEN 1L"), ("CERVEZA BARRIL X 30L IMPERIAL", None), ("CERVEZA IMPERIAL STOUT X 500 X 12", None), ("CERVEZA LATA IMP IPA X 473 X 6", None),
 ("GIN BOMBAY X 750 cc. (12X750)", "GIN BOMBAY 750CC"), ("RON BACARDI BCO. 12 X 1 LI.", None), ("GIN BEEFEATER x 1 Lt (6x1000cc", None),
 ("FERNET BRANCA 12X750", "FERNET BRANCA 750CC"), ("GANCIA 12X1", "GANCIA 1L"), ("SCHWEPPES POMELO ZERO 6X1500", "SCHWEPPES POMELO ZERO 1.5L"), ("SPRITE 6X1500", "SPRITE 1.5L"),
 ("COCA-COLA 6X1500 PET", "COCA COLA  1.5L"), ("COCA-COLA 6X21/4", "COCA COLA 2.25L DESC"), ("CERVEZA MILLER 12X1LT", "MILLER 1L"), ("TORO TINTO T.BRIK 12X1", "TORO VINO TINTO T.BRIK"),
 ("SODA SIFON ESTAMBUL 6X1,75", None), ("AQUARIUS NARANJA 6X1500", "AQUARIUS 1.5L NARANJA"), ("AQUARIUS POMELO 6X1500", "AQUARIUS 1.5L POMELO"), ("CEPITA HF DURAZNO 6X1LT", "CEPITA DURAZNO 1L"), ("CEPITA HF NARANJA 6X1LT", "CEPITA NARANJA 1L"),
]
bien = mal = blanco_ok = blanco_perdido = 0
for desc, real in CASOS:
    prop, sug = proponer(desc)
    en_sug = real in sug if real else None
    if prop and prop == real: bien += 1; marca = "✓ vinculó bien"
    elif prop and prop != real: mal += 1; marca = "✗ VINCULÓ MAL"
    elif not prop and real is None: blanco_ok += 1; marca = "· en blanco (correcto: no existe o es ambiguo)"
    else: blanco_perdido += 1; marca = f"· en blanco, existía ({'estaba entre las 3 sugerencias' if en_sug else 'NO sugerido'})"
    print(f"{desc[:34]:34} → {str(prop)[:30]:30} {marca}" + ("" if prop == real else f"   [real: {real}; sugiere: {sug}]"))
n = len(CASOS)
print(f"\n{n} renglones: vinculó bien {bien} · VINCULÓ MAL {mal} · en blanco correcto {blanco_ok} · en blanco pero existía {blanco_perdido}")
