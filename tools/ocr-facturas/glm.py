"""Lee las fotos de muestras/ con GLM-OCR (Ollama) y guarda salida/glm_<nombre>.txt"""
import base64, io, json, sys, time, urllib.request
from pathlib import Path
from PIL import Image, ImageOps

def leer(ruta, modelo="glm-ocr:q8_0", lado=1600):
    im = ImageOps.exif_transpose(Image.open(ruta)).convert("RGB"); im.thumbnail((lado, lado))
    b = io.BytesIO(); im.save(b, "JPEG", quality=90)
    body = {"model": modelo, "stream": True, "keep_alive": "5m",
            "messages": [{"role": "user", "content": "Table Recognition:", "images": [base64.b64encode(b.getvalue()).decode()]}],
            "options": {"temperature": 0, "num_ctx": 8192, "num_predict": 6000}}
    req = urllib.request.Request("http://127.0.0.1:11434/api/chat", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    out = []
    for line in urllib.request.urlopen(req, timeout=1800):
        j = json.loads(line)
        if "error" in j: break
        out.append(j.get("message", {}).get("content", ""))
        if j.get("done"): break
    return "".join(out)

if __name__ == "__main__":
    fotos = sys.argv[1:] or sorted(p.stem for p in Path("muestras").glob("*.jpg"))
    for n in fotos:
        t = time.time(); txt = leer(f"muestras/{n}.jpg")
        Path("salida").mkdir(exist_ok=True); open(f"salida/glm_{n}.txt", "w").write(txt)
        print(f"{n}: {time.time()-t:.0f}s · {txt.count(chr(10))} líneas", flush=True)
