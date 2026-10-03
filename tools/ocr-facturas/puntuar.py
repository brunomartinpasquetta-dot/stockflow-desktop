"""Compara el texto del lector con la planilla correcta, renglón por renglón.
Uso: python3 puntuar.py <prefijo>   (ej. tess)"""
import re, sys, unicodedata
from difflib import SequenceMatcher
from verdad import VERDAD

NUM = re.compile(r"-?\s?\d[\d.,]*")

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().upper()
    return re.sub(r"[^A-Z0-9]+", " ", s).strip()

def numero(tok):
    t = tok.replace(" ", "")
    neg = t.startswith("-"); t = t.lstrip("-").rstrip(".,")
    t = t.replace(".", "").replace(",", ".")
    try: v = float(t)
    except ValueError: return None
    return -v if neg else v

def numeros(linea):
    return [v for v in (numero(m.group()) for m in NUM.finditer(linea)) if v is not None]

def esta(valor, nums):
    return valor is None or any(abs(abs(n) - abs(valor)) < 0.011 for n in nums)

def puntuar(txt, clave):
    if "<tr" in txt:  # GLM-OCR a veces devuelve la tabla en HTML
        txt = "\n".join(" ".join(re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", f, flags=re.S)) for f in re.findall(r"<tr>(.*?)</tr>", txt, flags=re.S))
    lineas = [l for l in txt.split("\n") if l.strip()]
    usadas, res = set(), []
    for v in VERDAD[clave]:
        mejor, mi = 0, None
        for i, l in enumerate(lineas):
            if i in usadas: continue
            s = SequenceMatcher(None, norm(v["desc"]), norm(l)).ratio()
            if esta(v["importe"], numeros(l)): s += 0.3
            if s > mejor: mejor, mi = s, i
        if mi is None or mejor < 0.45:
            res.append((False, v["desc"], "FALTA", "")); continue
        usadas.add(mi); l = lineas[mi]; nums = numeros(l)
        malos = [k for k, val in (("precio", v["precio"]), ("importe", v["importe"]), ("cant", v["cant"]), ("uxb", v["uxb"])) if not esta(val, nums)]
        if v["codigo"] and v["codigo"][-6:] not in re.sub(r"\D", "", l): malos.append("codigo")
        res.append((not malos, v["desc"], ",".join(malos), l.strip()[:110]))
    return res

if __name__ == "__main__":
    pref = sys.argv[1]; tot = okt = 0
    for clave in VERDAD:
        try: txt = open(f"salida/{pref}_{clave}.txt").read()
        except FileNotFoundError: continue
        res = puntuar(txt, clave); ok = sum(r[0] for r in res); tot += len(res); okt += ok
        print(f"{clave}: {ok}/{len(res)}")
        for bien, desc, motivo, linea in res:
            if not bien: print(f"   ✗ {motivo:18} {desc[:38]:38} ← {linea}")
    print(f"TOTAL {pref}: {okt}/{tot} = {100*okt/max(tot,1):.0f}%")
