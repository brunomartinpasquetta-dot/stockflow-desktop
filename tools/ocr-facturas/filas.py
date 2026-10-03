"""Arma renglones a partir de las cajas de texto del lector del sistema:
endereza la hoja (pendiente mediana de las cajas) y agrupa por altura."""
import json, statistics, sys

def renglones(datos):
    W, H = datos["ancho"], datos["alto"]
    ts = [dict(t, x0=t["x0"]*W, x1=t["x1"]*W, y0=t["y0"]*H, y1=t["y1"]*H, h=t["h"]*H) for t in datos["textos"]]
    largos = [t for t in ts if t["x1"] - t["x0"] > W * 0.08]
    pend = statistics.median((t["y1"] - t["y0"]) / (t["x1"] - t["x0"]) for t in largos) if largos else 0.0
    for t in ts:
        t["y"] = (t["y0"] + t["y1"]) / 2 - pend * ((t["x0"] + t["x1"]) / 2)   # altura corregida por la inclinación
    ts.sort(key=lambda t: t["y"])
    alto = statistics.median(t["h"] for t in ts) if ts else 1
    filas = []
    for t in ts:
        if filas and abs(t["y"] - statistics.mean(x["y"] for x in filas[-1])) < alto * 0.55:
            filas[-1].append(t)
        else:
            filas.append([t])
    return ["  ".join(x["t"] for x in sorted(f, key=lambda x: x["x0"])) for f in filas]

if __name__ == "__main__":
    print("\n".join(renglones(json.load(open(sys.argv[1])))))
