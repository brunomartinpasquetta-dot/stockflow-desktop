# ocr-paddle — lector de texto PaddleOCR para "Facturas por teléfono"

`leer.mjs` lee la foto de una factura y devuelve las cajas de texto con su posición,
en el mismo JSON que `ocr-mac/vision.swift` y `ocr-win/leer.ps1`. Es el lector
**principal en Windows** y el **respaldo en Mac** (si Apple Vision falla); la cadena
está en `electron/facturas/lectorSistema.ts`.

```
ELECTRON_RUN_AS_NODE=1 <StockFlow.exe | Electron> leer.mjs <foto.jpg>   # JSON por stdout
ELECTRON_RUN_AS_NODE=1 <electron> leer.mjs --probar                     # "disponible" | "no disponible: …"
```

Corre con el propio ejecutable de Electron como Node: la PC del cliente no necesita
Node ni Python. Sólo CPU, 2–4 s por hoja en la Mac (M2, 4 hilos), ~600–800 MB mientras
lee; el proceso termina con cada hoja.

**Dependencias** (en `apps/desktop/package.json`, cargadas desde `app.asar` por la
variable `STOCKFLOW_OCR_NODE_MODULES` que manda `main.ts`): `onnxruntime-node` (MIT,
Microsoft; trae `onnxruntime.dll` / `libonnxruntime.1.dylib`) y `jpeg-js` (MIT). Nada
nativo propio: la reducción, el gris, los contornos y los recortes son JavaScript puro.

## Modelos (`modelos/`)

| Archivo | Qué es | Tamaño | SHA-256 |
|---|---|---|---|
| `ch_PP-OCRv5_det_mobile.onnx` | Detector de texto DB, PP-OCRv5 mobile | 4,8 MB | `4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae` |
| `latin_PP-OCRv5_rec_mobile.onnx` | Reconocedor CRNN, PP-OCRv5 mobile, alfabeto latino; el diccionario viene embebido en los metadatos del ONNX (clave `character`) | 7,9 MB | `b20bd37c168a570f583afbc8cd7925603890efbcdc000a59e22c269d160b5f5a` |

Origen: modelos PP-OCRv5 "mobile" de [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)
(PaddlePaddle), exportados a ONNX con el diccionario embebido por el proyecto
[RapidOCR](https://github.com/RapidAI/RapidOCR) (RapidAI). Se eligieron entre seis
variantes medidas en `tools/ocr-facturas/RESULTADOS.md` (3-oct-2026); copiados de
`tools/ocr-facturas/modelos/`. Licencia **Apache-2.0** (PaddleOCR y RapidOCR):
`modelos/LICENSE-Apache-2.0.txt`.

## Dónde se prueba y se mide

- `pnpm test:facturas-paddle` (`electron/__tests__/facturas-paddle.smoke.ts`): corre
  `leer.mjs` con el Electron del repo sobre dos fotos reales y pasa el resultado por el
  pipeline de la app (`armarRenglones` → `parsearTexto`).
- `tools/ocr-facturas/evaluar.mts` evalúa una carpeta de JSON contra las 8 fotos reales;
  `tools/ocr-facturas/paddle-ocr.mjs` es el prototipo (con sharp + OpenCV, `--dibujar`)
  del que se portó este script.
