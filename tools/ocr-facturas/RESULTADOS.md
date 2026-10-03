# Lectura de facturas de compra con el teléfono — pruebas (2-oct-2026)

Fotos reales de Bruno (celular, con resaltador y tildes de birome): `muestras/`.
Planilla correcta a mano: `verdad.py` (90 renglones, verificados por cantidad × precio = importe).

| Lector | Qué es | Peso | Renglones bien | Tiempo por hoja |
|---|---|---|---|---|
| Tesseract (tesseract.js) | detector de texto clásico, sin IA | 10 MB | **36/90 (40 %)**; con binarizado 25/90 | 3 s |
| GLM-OCR q8 (Ollama) | IA chica dedicada a OCR de documentos | 1,6 GB | **148/149 (99 %)** sobre 7 fotos (prueba anterior, se perdió la carpeta temporal) | 20–60 s con GPU (Mac M2); **~2 min sin placa de video** (CPU, 4 hilos) |

Conclusiones:
- Tesseract no sirve para fotos de celular con resaltador/birome: falla en cantidades y códigos.
- GLM-OCR lee casi perfecto, pero en una PC de comercio sin GPU tarda ~2 min por hoja y necesita ~2 GB de RAM libre.
- El paso texto → renglones de compra se hace con CÓDIGO (columnas fijas por proveedor + control cantidad × precio = importe + total del QR fiscal), NO con una segunda IA.
- OJO memoria: en la Mac de Bruno (8 GB) cargar dos modelos a la vez la tiró abajo. Un solo modelo a la vez.

Cómo repetir: `node leer.mjs` (Tesseract) y `python3 puntuar.py tess`. GLM-OCR: Ollama con `glm-ocr:q8_0`, prompt `Table Recognition:`, imagen a 1600 px, `num_ctx` 8192+.

## Lector de texto del sistema operativo (idea de Bruno, 2-oct-2026)

Apple Vision (`VNRecognizeTextRequest`, el mismo motor de "Texto en vivo" del iPhone), probado en la Mac con `vision.swift` + `filas.py` (endereza la hoja y agrupa las cajas de texto por renglón):

| Lector | Peso extra | Renglones bien (4 hojas Vital, 90 renglones) | Tiempo por hoja |
|---|---|---|---|
| Lector del sistema (Apple Vision) + cuenta importe ÷ precio | 0 | **78/90 (87 %)** | **0,3 s** (la primera vez ~45 s de arranque) |
| GLM-OCR q8 | 1,6 GB | 87/90 (97 %) | 30 s con GPU / ~2 min sólo CPU |

- Lee muy bien lo impreso (precios, importes). Falla donde hay birome encima (cantidades: se recuperan con la cuenta) y cuando la foto corta el borde de la hoja (códigos de vital-15).
- No da tabla: los renglones se arman por posición (código en `filas.py`).
- En Windows el equivalente es `Windows.Media.Ocr` (viene con Windows 10/11, gratis). **Sin probar**: hay que medirlo en una PC con Windows.
- Desde una página web el teléfono NO puede usar su lector (Safari no lo expone a las páginas); el lector corre en la PC.
- Diseño resultante: lector del sistema primero (instantáneo); GLM-OCR sólo como respaldo opcional para las hojas donde muchos renglones no cierran.

## Asociación automática renglón → artículo (2-oct-2026)

Prototipo `asociar.py` contra la base REAL de un drugstore cliente (599 artículos; copia local de Bruno, no versionada) y 40 renglones de facturas reales de bebidas (Bernardi, ROA, Al Vino Vino, lista de bebidas). Verdad armada a mano.

| Resultado | Renglones |
|---|---|
| Vinculó bien solo | 20 |
| **Vinculó MAL** | **0** |
| En blanco, y era correcto (el artículo no existe o es ambiguo) | 12 |
| En blanco pero existía (7 de 8 con el correcto como primera sugerencia) | 8 |

Método: tamaño de la unidad igual (ml/g, entendiendo "12X500", "6X11/5", "8X1 1/4", "1.5L"), todas las palabras de marca/variedad presentes en los dos lados, y abstenerse si no hay un único candidato claro.
Límites: 40 renglones, un solo rubro (bebidas), artículos de ese drugstore bien nombrados, sinónimos puestos a mano (S/AZUC→ZERO, RETOR→RET). El costo no sirvió de pista (facturas de 2021). Falta medir con almacén/golosinas y con una base peor nombrada.

## Estado final del día (2-oct-2026, 23:00)
Función completa instalada en la Mac de Bruno (sin commit ni tag): lector del sistema principal + GLM-OCR opcional ("Mejorar lectura"), parser con regla "ningún renglón se pierde en silencio", encabezado/proveedor desde el texto, vinculador automático (asociador.ts) con 0 vínculos equivocados en pruebas, botón "Cargar con el teléfono" en Compras, control de total, calidad de foto, crear proveedor/artículo, factura repetida. Las 3 facturas reales de Bruno releídas en la app: 7/7, 19/19, 5/5 renglones, sumas iguales al total. 34 baterías (33 OK; `arca` requiere certificado).

## Hallazgo clave (3-oct-2026): leer la foto SIN COLOR
En la 2ª foto real de Bernardi (torcida, con cruces de birome) la lectura en color perdía 2 descripciones y pegaba otra. Comparación con el iPhone (que sí las leía) → la diferencia no era resolución ni versión del lector: era el COLOR. Pasando la foto a gris "canal más claro" (max(R,G,B): borra birome y resaltador) el mismo Apple Vision lee todo. Medido con las 8 fotos reales (pipeline completo lector→renglones→parser):
- Color: 2 fotos con renglones perdidos (bernardi-2 17/19, vital-14 32/33) y varias con renglones sin descripción.
- Sin color (max): 7/8 perfectas (vital-12 22/23).
- Dos pasadas (sin color + color sólo para lo no visto): 7/8 perfectas (vital-14 32/33, por el agrupador de filas, no por la lectura).
Implementado en native/ocr-mac/vision.swift (CIMaximumComponent + segunda pasada) y en native/ocr-win/leer.ps1 (C# Add-Type, SIN PROBAR en Windows). Tiempo: 0,46 s por hoja con las dos pasadas.

## Lector de Windows (medido en GitHub Actions, 3-oct-2026)

No hay PC con Windows a mano: se midió `native/ocr-win/leer.ps1` (Windows.Media.Ocr) en un runner `windows-latest` con las 8 fotos reales de `muestras/`. Rama `prueba/ocr-windows` (workflow `.github/workflows/prueba-ocr-windows.yml`; corre con cada push a esa rama porque GitHub sólo deja disparar a mano los workflows de `main`); las fotos viajaron en un release BORRADOR temporal (ya borrado, nunca hubo tag) y volvieron como artifact (JSON de cajas, sin la foto; artifacts borrados después de bajarlos). Runs: 37094459136 (falló al bajar las fotos: con `contents: read` el token no ve borradores), 37096076418 (primera medición) y 37096394848 (con el arreglo de decimales). Salida cruda en `salida-windows/<run>/` (no versionada), evaluada en la Mac con el MISMO pipeline de la app (`interpretarLectura → armarRenglones → parsearTexto`, script `evaluar.mts`).

**Entorno.** Microsoft Windows Server 2025 Datacenter 10.0.26100 (el mismo build que Windows 11 24H2), Windows PowerShell 5.1.26100.33438, sistema en `en-US`. Idiomas de lectura instalados: **sólo `en-US`**; `IsLanguageSupported` da `False` para es-AR, es-ES, es-MX y es. `Add-WindowsCapability -Online -Name Language.OCR~~~es-ES~0.0.1.0` se quedó colgado hasta el tope de 10 min (Server no baja "Features on Demand"). **Todo lo de abajo está medido con el motor en inglés**, no con el castellano que tendrán los clientes. `MaxImageDimension` = 10000 (las fotos de 4000×3000 no se reducen).

**El script corrió a la primera** en Windows PowerShell 5.1: cargan los tipos WinRT, anda `AsTask`, el preproceso en C# (`Add-Type`) compila y corre, `-Probar` imprime `disponible` en 0,4–0,6 s. 16/16 lecturas (8 fotos × con/sin preproceso) con código 0 y stderr vacío. Cambios que quedaron en la rama (PORTADOS a `main` el 3-oct junto con una caché del ensamblado compilado en `%TEMP%\stockflow-ocr\` para no recompilar el C# en cada hoja — la caché NO se probó en Windows; diff en `salida-windows/leer.ps1.diff`, copia completa en `salida-windows/leer.ps1.rama-prueba-ocr-windows`):
- **Windows parte los importes en el separador decimal**: devuelve `4.169,` + `28`, `21,` + `oo`, `495,` + `04` como palabras separadas, y el parser recibía `4.169, 28`. Ahora `leer.ps1` vuelve a pegar un número terminado en coma/punto seguido de exactamente dos dígitos (u `oo` → `00`). Efecto medido: 55 → 37 renglones en revisar.
- Carga explícita de los enums `BitmapPixelFormat`, `BitmapAlphaMode`, `ExifOrientationMode` y `ColorManagementMode` (se usaban sin declararlos; seguro adicional).
- Switch `-SinPreproceso` (sólo para comparar) y aviso por stderr si el preproceso en C# falla (antes caía en silencio a la foto en color).

**Tiempo por hoja** (runner de 4 vCPU; incluye arrancar PowerShell): **1,0–1,7 s sin preproceso; 2,2–3,3 s con preproceso** (el `Add-Type` compila el C# en cada invocación y el PNG de 12 MP es lento; la primera hoja tras el arranque 3,6–4,7 s). Si se quiere bajar: guardar el temporal como BMP/JPEG en vez de PNG y/o no recompilar el C# en cada hoja.

**Windows vs Mac, por foto** (Windows = run 37096394848 con preproceso; Mac = `vision-ocr` actual sobre las mismas fotos, mismo pipeline, hoy):

| Foto | Esperados | Windows: renglones · exactos · revisar · cierra con el total | Mac: renglones · exactos · revisar · cierra |
|---|---|---|---|
| alvinovino | 7 | 7/7 · 5/7 · 2 · sí | 6/7 · 5/7 · 1 · no (hoy; el fixture `sistema/alvinovino.json` da 7/7: el binario recompilado el 3-oct perdió "GASTOS DE ENVIO". **Causa, 3-oct**: no es la lectura ni la mezcla de pasadas: Vision sobre el gris actual parte la marca de lista "L5" en dos cajas "L" + "5" y el parser no la reconocía como prefijo; arreglado en el parser → 7/7 todo ok, fixture `sistema/alvinovino-v2.json`) |
| bernardi | 19 | 19/19 (19 códigos en orden) · 1 · no (−4.321,55: la FANTA llegó como `4.417` sin decimales, quedó en revisar) | 19/19 · 0 · sí |
| bernardi-2 | 19 | 16/19 · 0 · no (−10.945,89: 3 renglones perdidos) | 19/19 · 0 · sí |
| roa | 5 | 3/5 · 3/5 · 0 · no (**2 renglones perdidos en silencio**: cantidades `7.00`/`4.00` leídas `.00`/`00`) | 5/5 · 5/5 · 0 · sí |
| vital-12 | 23 | 21/23 · 15/23 · 6 · (sin total impreso) | 23/23 · 22/23 · 2 |
| vital-13 | 24 | 18/24 · 3/24 · 15 | 24/24 · 24/24 · 0 |
| vital-14 | 33 | 30/33 · 25/33 · 5 | 33/33 · 33/33 · 0 |
| vital-15 | 10 | 8/10 · 0/10 · 8 | 10/10 · 10/10 · 0 |
| **Total** | **140** | **122/140 · 37 en revisar · 18 perdidos · 0 mal sin aviso · 1 de 4 hojas con total cierra** | **139/140 · 3 en revisar · 1 perdido · 0 mal sin aviso · 3 de 4 cierran** |

Sin preproceso (foto en color) Windows da 120/140, 41 en revisar, 2 de 4 cierran (bernardi cierra en color y no en gris): **el "sin color" casi no cambia nada en Windows**, al revés que en Mac. Antes del pegado de decimales (run 37096076418): 123/140 y 55 en revisar.

Cómo falla Windows (visto en el texto): dígitos mal leídos (`1.144,63` → `14 4 63`; `7.00` → `.00`; `6.738,84` → `6.738 84,`), `00` → `oo`, precios truncados (`1335,`, `5044,`, `7499,`), casi nunca ve las cantidades escritas con birome (Mac tampoco, pero el parser las recupera con importe ÷ precio porque los importes llegan bien), y descripciones con l/1/i (`xlkg`, `x3it`, `Iou`). Ninguno de los dos lectores dejó un renglón MAL sin aviso; pero en Windows el parser perdió renglones en silencio (roa 2, vital-13 hasta 6): la regla "descripción + importe nunca se pierde" no alcanzaba cuando la cantidad llega como `.00`. **Arreglado en el parser el 3-oct** (zona de renglones extendida hacia arriba y abajo del primer/último renglón, cantidad cero → deducida por la cuenta, cola con basura → importe ilegible, y renglón vacío en revisar cuando no se entiende nada): con los mismos JSON, roa 5/5 (suma = total) y vital-13 24/24 (10 en revisar); son los fixtures `sistema/windows-roa.json` y `sistema/windows-vital-13.json` de la batería `facturas-sistema`. La tabla de arriba es la medición ANTERIOR al arreglo.

**Conclusión: tal como está, el lector de Windows funciona (cero instalación, 1–3 s por hoja) pero NO alcanza como lector principal para los clientes.** Lee bien las facturas prolijas de bebidas (Bernardi/Al Vino Vino: todos los códigos), pero en las hojas de almacén (Vital) manda ~1 de cada 4 renglones a revisar y pierde ~1 de cada 8, varios sin aviso. En Windows el respaldo GLM-OCR ("Mejorar lectura") se necesitaría en la mayoría de las hojas, no como excepción. Lo que falta medir antes de decidir: el motor **en castellano** en un Windows 10/11 real de comercio (es lo que tendrán los clientes; puede leer distinto) y si conviene ofrecer el GLM-OCR automáticamente en Windows cuando varios renglones no cierran. Para repetir la prueba: subir las fotos a un release borrador `prueba-ocr-windows` y hacer push a la rama `prueba/ocr-windows`.

## PaddleOCR en Node (3-oct-2026)

**Estado: PaddleOCR integrado como lector principal de Windows (y respaldo de Mac) en `apps/desktop/native/ocr-paddle/leer.mjs`; medido sólo en la Mac; falta medir tiempo en una PC de comercio.**

Prototipo: `paddle-ocr.mjs` (sharp + OpenCV WASM + js-clipper; `--dibujar` para mirar las cajas), variantes en `salida-paddle/*/opciones.txt`, evaluadas con `evaluar.mts`. La mejor: detector `ch_PP-OCRv5_det_mobile.onnx` + reconocedor `latin_PP-OCRv5_rec_mobile.onnx` (diccionario embebido), lado 2000 px, gris max(R,G,B), `--caja 0`: **140/140 renglones, 12 en revisar, 0 mal sin aviso, 4 de 4 hojas con total impreso cierran**; 1,7–3,8 s por hoja (M2, hilos por defecto), 500–800 MB de RSS.

Puerto a la app (`leer.mjs`, sin sharp ni OpenCV: jpeg-js + reducción/gris/contornos/recortes en JavaScript puro; corre con el Electron del repo como Node, `onnxruntime-node` 1.30 a 4 hilos): mismas 8 fotos con el mismo pipeline → **140/140 renglones, 12 en revisar, 4 sin descripción, 0 mal sin aviso, 4 de 4 cierran** (igual o mejor que el prototipo); 1,5–3,3 s por hoja, 510–760 MB de RSS. Detalle que importó: reducir la foto con Lanczos3 (como hacía sharp) y recortar con bicúbica; con filtro triangular y bilineal salían 14 en revisar y 7 sin descripción. Prueba: `pnpm test:facturas-paddle`. No medido: tiempo en una PC de comercio con Windows (la Mac es M2) ni el paquete de Windows en una PC real (los .dll de onnxruntime-node van en app.asar.unpacked; sólo se verificó el paquete de Mac).

## Vinculador contra catálogo real (3-oct-2026)

`asociador.ts` (prepararCatalogo + proponerArticulo, el código que corre en la app) contra la base REAL de un drugstore cliente (599 artículos, 592 activos sin espejos de promo; kiosco/drugstore: bebidas, golosinas, cigarrillos, snacks; casi nada de almacén ni limpieza) y los 151 renglones de TODAS las facturas de prueba: vital-12..15, buensol, pedido-munini, bebidas (fixtures/facturas/esperado.json), alvinovino, roa y bernardi (reales/; Bernardi sacado del texto con el parser, con las marcas de birome "Y "/"X " adelante). Proveedor pasado para Bernardi (CUIT 33715137009) y ROA; precio de la factura tal cual (facturas de 2021 contra costos de 2026: la pista del costo no juega). Verdad juzgada a mano leyendo el catálogo entero. Script en el scratchpad de la sesión (no versionado), corrido con el electron del repo y better-sqlite3 en sólo lectura.

| Rubro | Propuso bien | **Propuso MAL** | En blanco, correcto | En blanco, existía | Dudoso | Descuentos | Total |
|---|---|---|---|---|---|---|---|
| Bebidas | 19 | **0** | 15 | 1 | 0 | 0 | 35 |
| Almacén | 2 | **0** | 60 | 0 | 0 | 0 | 62 |
| Limpieza / perfumería | 0 | **0** | 24 | 0 | 0 | 0 | 24 |
| Golosinas / galletitas | 0 | **0** | 4 | 0 | 0 | 0 | 4 |
| Congelados | 0 | **0** | 4 | 0 | 0 | 0 | 4 |
| Otros (bazar, envío, descuentos) | 0 | **0** | 4 | 0 | 0 | 18 | 22 |
| **Total** | **21** | **0** | **111** | **1** | **0** | **18** | **151** |

Lectura: de los 133 renglones que son productos (151 menos 18 descuentos), sólo 22 tienen contraparte en un drugstore cliente. Vinculó 21 (los 2 de almacén son KESITAS 75G y REX 75G) y en el restante quedó en blanco con el correcto PRIMERO entre los candidatos: #131 "FANTA-NARANJA 12X500 PET" → FANTA 500CC (al artículo le falta la palabra NARANJA). Los otros 111 no existen en un drugstore cliente o son ambiguos y en TODOS quedó en blanco: 0 falsos positivos pese a palabras compartidas (NARANJA, LIMÓN, QUESO, PIZZA, BLANCO, SURTIDO, CAFE, DULCE…) y a trampas reales del catálogo: COFLER BLANCO C CHOCOLINAS 55G ante galletitas Chocolinas 250; OFF NARANJA 127G ante OFF family 165; SODA ESTAMBUL 1.5L ante sifón 1,75; IMPERIAL GOLDEN 1L e IMPERIAL LAGER 1L ante "CERVEZA IMPERIAL X 1L X 12" (se abstuvo y mostró los dos); tres tamaños de SPEED ante "SPEED CON CAFE 24X24"; MAGDALENAS GAONA ante magdalena BON MASE.

- **Propuestos incorrectos: ninguno. Dudosos: ninguno.**
- Indeterminables (en blanco, y está bien): #12 "Mani frito S&P salado s/piel x250gr" vs BOLSA MANI SALADO (sin marca ni tamaño); #118 "AGUA DE MESA 6X2 LITROS" vs AGUA BONAQUA 2 L (el renglón no trae marca).
- Rendimiento: prepararCatalogo 7,8 ms la primera vez / 2,7 ms promedio (592 artículos); proponerArticulo 0,08 ms por renglón en el primer pase y 5 µs en caliente; los 151 renglones en 12 ms. Irrelevante frente a la lectura de la foto.
- Límite del muestreo: almacén, limpieza y congelados sólo midieron la ABSTENCIÓN (un drugstore cliente no vende eso); la precisión en un catálogo de almacén con variantes cercanas (mayonesa 250/500, fideos por corte) sigue sin medirse. un drugstore cliente además tiene dos proveedores Bernardi (con CUIT 31 artículos, sin CUIT 72): la pista del proveedor pierde fuerza con padrones duplicados.

### Sondeos extra (NO cuentan en la tabla): ~100 renglones escritos a mano con productos que SÍ están en un drugstore cliente
35 propuestas, **4 equivocadas, todas por la misma causa**: el token numérico "0.0"/"0,0" se descarta → "CERVEZA HEINEKEN 0.0 X 473 X 6" y "HEINEKEN 0,0 LATA X 473 X 6" → HEINEKEN LATA 473CC (con alcohol; la sin alcohol existe como "HEINEKEN LATA 473 CC SIN ALCOHOL"); "STELLA ARTOIS 0.0 X 330 X 24" → STELLA ARTOIS 330CC (existe "STELLA ARTOIS 0.0 PININA 330CC"). "CORONA PININA 0.0" se salvó sólo porque las dos Corona empatan. Lo mismo vale para cualquier variedad escrita en números: "MENTHOPLUS 2 CHERRY" y "MENTHOPLUS CHERRY" puntúan igual (1,0). Es la única causa de vínculo equivocado encontrada en toda la medición, y es realista: 0.0 es como lo escriben los distribuidores.
Falsos negativos vistos (no dañan, pero dejan el renglón sin sugerencia útil):
- ~25 por el formato "tamaño X bulto" sin unidad ("CORONA 330 X 24", "OREO 118 X 36", "SMIRNOFF 700 X 12", "KESITAS 125 X 24", "SPEED 250 X 24"): el "X 24" final se lee como 24 unidades (paso 6 de leerTamano) antes que el número suelto 330 (paso 7); el tamaño contradice al del artículo y ni aparece como candidato. Con la X adelante ("CORONA X 710 X 12", como escribe ROA) o con unidad ("710CC X 12") los mismos productos vinculan bien. Tamaños de 2 cifras sin unidad fallan incluso con X adelante ("MILKA LECHE X 55 X 20" → 20 u). Frecuencia real del formato: desconocida; no aparece en las facturas de prueba.
- Rubro en el medio del nombre del artículo: "VILLAVICENCIO AGUA 1.5L" nunca vincula ("AGUA" cuenta como sobrante) ni con "VILLAVICENCIO X 1500 X 6" ni con "AGUA VILLAVICENCIO 6X1500". Y "AGUA VILLAVICENCIO SIN GAS 12X500" rankea primero a la "C GAS" (SIN no es ruido, GAS coincide): no propone, pero el orden de candidatos engaña.
- Artículos sin tamaño (TANG NARANJA, CLIGHT NARANJA, TRIO PEPAS CON CHIPS, SMIRNOFF RASPBERRY): por diseño quedan en blanco aunque las palabras coincidan exactas y únicas; en un kiosco es ~37 % del catálogo (un drugstore cliente: 222 de 599 sin número en el nombre). Golosinas casi nunca se van a pre-vincular.
- Abreviaturas del comerciante: "SIDRA 1888 ORIG LATA 473CC" no vincula con "SIDRA 1888 ORIGINAL LATA X 473 X 6" (ORIGINAL es ruido, ORIG no → sobrante). También PRONTO (BAGGIO PRONTO), CAJITA, CROSS (SALADIX CROSS PIZZA) como sobrantes razonables.

### Mejoras concretas al asociador (no implementadas)
1. **Tokens numéricos de variedad** (la única causa de error): conservar "0.0"/"0,0" como palabra significativa (y en general un número que no sea el tamaño: "2", "7", "24.7", "50%") y agregar sinónimos 0.0 ↔ SIN ALCOHOL (↔ ZERO en cerveza). Sumar los 4 casos a la batería `facturas-asociador`.
2. Tamaño "NNN X n": cuando hay un número suelto de 3-4 cifras Y un "X n" al final, leer tamaño × bulto (330 X 24 → 330 ml), no "n unidades"; y con X adelante aceptar 2 cifras cuando sigue otro X con el bulto ("X 55 X 20" → 55 g).
3. Rubro en cualquier posición: las palabras de RUBROS dentro del nombre del artículo no deberían contar como sobrantes (tratarlas como opcionales); la comparación rubro-vs-rubro sigue sólo al frente.
4. "SIN X" como negación: "SIN GAS" no cubre "GAS" del artículo y penaliza "C GAS"/"CON GAS"; hoy SIN es una palabra significativa suelta.
5. Abreviaturas del lado del catálogo: ORIG → ORIGINAL (ruido); aplicar la aproximación por prefijo también a las palabras de RUIDO abreviadas.
6. Opcional y con cuidado: permitir vincular artículos sin tamaño cuando el renglón sólo trae bulto ("TANG NARANJA X 20"), las palabras coinciden exactas en los dos sentidos y ningún otro artículo las tiene todas (TANG NARANJA DULCE tiene sobrante: no compite). Sin esto las golosinas quedan afuera del pre-vínculo.

### Veredicto
Con las facturas reales: 21 propuestos, 0 equivocados, 1 que faltó, 0 falsos positivos en 111 renglones ajenos al catálogo; recall 21/22 y precisión 21/21. Pero los sondeos encontraron un error sistemático y realista (cerveza 0.0 → la con alcohol) que un "Aceptar todos" cargaría como stock y costo equivocados sin que nadie lo mire. Recomendación: "Sugerido" con "Aceptar todos" SÓLO después de la mejora 1 (con sus casos en la batería); hasta entonces, sugerencia a elegir renglón por renglón, o "Aceptar todos" que deje los renglones sugeridos marcados y visibles para repasar antes de confirmar la compra.

## PaddleOCR vs Mac, re-evaluado con el parser que recupera el signo de los descuentos (3-oct-2026 12:00)
Mismo pipeline de la app (interpretarLectura → armarRenglones → parsearTexto), 8 fotos reales, 140 renglones:

| Lector | Renglones | En revisar | Mal sin aviso | Facturas con total que cierran |
|---|---|---|---|---|
| Apple Vision (Mac, 2 pasadas) | 140/140 | 1 | 0 | 4/4 |
| PaddleOCR det v5 + rec latin v5, 2000 px, gris max(R,G,B) | 140/140 | 12 | **0** | 4/4 |
| PaddleOCR det v4 + rec latin v5 | 140/140 | 8 | 1 | 4/4 |
| PaddleOCR det v4 + rec en v5 | 140/140 | 13 | 2 | 4/4 |
| Windows.Media.Ocr (Server, motor inglés) | 122/140 | 37 | 0 | 1/4 |

Elegido para Windows: **det v5 + rec latin v5** (único con 0 mal sin aviso). Lo que se pierde frente a la Mac son renglones de Vital con resaltador que quedan marcados para revisar, nunca perdidos. Tiempo en M2 (CPU): 1,6–3,8 s por hoja; RSS 500–800 MB mientras lee (proceso aparte que termina con cada hoja).
