# Facturas de compra por teléfono — diseño (2-oct-2026)

Estado: **en desarrollo, sólo en la Mac de Bruno. NO se taggea ni se sube la versión.** Opción **apagada por defecto**.

## Qué hace

1. En StockFlow se toca **"Vincular teléfono"**: aparece un QR. El teléfono lo escanea y abre una página web (servida por la PC) con la cámara.
2. Se sacan las fotos de las hojas de UNA factura y se envían. La PC las guarda y las **lee de fondo** con un lector de documentos local (Ollama, modelo `glm-ocr:q8_0`, 1,6 GB; ~30 s por hoja con GPU, ~2 min sin).
3. El texto leído se pasa a renglones **con código** (sin otra IA) y se controla por aritmética: cantidad × unidades por bulto × precio = importe.
4. En **Compras → Facturas escaneadas** se revisa (renglones dudosos en rojo, foto al lado), se vincula cada renglón con un artículo y se **carga en Compras** (el formulario de compra queda precargado; la compra la confirma el usuario como siempre).
5. El vínculo código-del-proveedor → artículo se recuerda (`article_supplier_codes`): la segunda factura del mismo proveedor sale vinculada sola.

Mediciones previas: `tools/ocr-facturas/RESULTADOS.md` (GLM-OCR 97–99 % de renglones bien; Tesseract 40 % → descartado).

## Reglas duras

- Nada cambia para quien no lo activa: con la opción apagada no hay servidor de fotos, la ruta responde 404 y no aparece el botón en Compras.
- **Nunca se crea una compra sola.** Sólo se precarga el formulario de Compras.
- Un solo modelo de IA en memoria: el lector se pide con `keep_alive: '2m'` y de a UNA hoja por vez (la Mac de Bruno tiene 8 GB).
- Textos de UI: tono formal (usted, sin tutear), estados en una palabra.
- Código y comentarios en castellano, como el resto del repo. Tests = scripts `tsx` con `check()`, como `electron/__tests__/catalogo.smoke.ts`.
- No agregar dependencias nativas. Dependencias nuevas permitidas (JS puro): `jsqr`, `jpeg-js`.

## Piezas

### A. Base de datos (`packages/db`)
Migración `0037_facturas_escaneadas.sql` (+ entrada en `meta/_journal.json`, idx 37, when = último + 1) y schema en `local.ts` (+ `localSchema`):

- `article_supplier_codes`: `id`, `article_id` (FK articles, ON DELETE CASCADE), `supplier_id` (FK suppliers), `code` (text), `created_at`, `updated_at`. Único `(supplier_id, code)`; índice por `article_id`.
- `scanned_invoices`: `id`, `status` (text: `recibiendo` | `en_cola` | `leyendo` | `lista` | `error` | `cargada` | `descartada`), `supplier_id` (nullable), `photos` (JSON: nombres de archivo), `pages_text` (JSON: texto leído por hoja), `header` (JSON), `lines` (JSON), `error` (text), `pages_done` (int), `created_by` (user id, nullable), `created_at`, `updated_at`.

Repositorios (síncronos, estilo `audit.repository.ts`), registrados en `repositories/index.ts`:
- `ArticleSupplierCodeRepository`: `buscar(supplierId, code)`, `listarPorProveedor(supplierId)`, `guardar(supplierId, code, articleId)` (upsert por el único), `borrar(id)`.
- `ScannedInvoiceRepository`: `crear({createdBy})`, `obtener(id)`, `listar({estados?, limite?})`, `actualizar(id, cambios)` (serializa JSON), `siguienteEnCola()`.
- `SupplierRepository.findByCuit(cuit)`: compara sólo dígitos.

Tests: agregar las 2 tablas a `EXPECTED_TABLES` de `local.smoke.ts` y un bloque en `repositories.smoke.ts`.

### B. Motor (`apps/desktop/electron/facturas/`, archivos nuevos, sin Electron: testeable con tsx)
- `parser.ts`: `parsearTexto(texto: string): RenglonLeido[]` y `unirHojas(textos: string[]): RenglonLeido[]`.
  ```ts
  interface RenglonLeido {
    codigo: string | null; descripcion: string;
    cantidad: number | null;            // en la unidad del precio (bultos/unidades/kg tal cual la factura)
    unidadesPorBulto: number | null;    // UxB
    precioUnitario: number | null;      // sin IVA si hay dos
    importe: number | null;             // neto del renglón (negativo en descuentos/promociones)
    esDescuento: boolean;               // renglón de promoción/bonificación (importe negativo)
    estado: 'ok' | 'corregido' | 'revisar';  // ok = la cuenta cierra; corregido = se ajustó la cantidad por la cuenta; revisar = no cierra o faltan datos
    motivo: string | null;              // texto corto para la pantalla de revisión
    original: string;                   // el renglón tal como se leyó
    hoja: number;
  }
  ```
  El texto llega en dos formas (ver fixtures): líneas simples con columnas separadas por espacios, o una tabla HTML (`<table>…<tr><td>`) — convertir cada `<tr>` a una línea uniendo celdas. Detectar el formato de números del documento (argentino `1.234,56` vs `1,234.56`). Para cada línea con importes: código = primer token de 5+ dígitos; elegir (cantidad, UxB, precio) de modo que `cantidad × UxB × precio ≈ importe` (tolerancia 0,05 o 0,05 %): el importe es el último número con decimales; el precio es el primero de los importes que haga cerrar la cuenta; la cantidad sale de los números chicos anteriores a la descripción (o, si no cierra y `importe ÷ (UxB × precio)` da entero, se corrige → `corregido`). Ignorar encabezados, totales, "Total Ahorro", líneas de asteriscos. Descuentos: importe negativo (`- 276,78`).
  Fixtures y resultado esperado: `electron/__tests__/fixtures/facturas/*.txt` + `esperado.json`. Meta: **100 % en vital-12/13/14/15 y buensol** (códigos: comparar por los últimos 6 dígitos en vital-15, cortados en la foto; en vital-15 los dos descuentos no traen código). `pedido-munini` (precio en otra línea) y `bebidas` (sólo descripción y precio): mejor esfuerzo, sin romperse.
- `qrFiscal.ts`: `leerQrFiscal(jpeg: Buffer): DatosQr | null` con `jsqr` + `jpeg-js` (probar a tamaño original y reducido; mejor esfuerzo). Decodifica la URL `https://www.afip.gob.ar/fe/qr/?p=<base64 JSON>` → `{ fecha, cuit, ptoVta, tipoCmp, nroCmp, importe, codAut }`. `tipoCmp` 1/6/11 → letra A/B/C. Test con `tools/ocr-facturas/muestras/vital-15.jpg` y `vital-12.jpg` si decodifican (si no, test sólo de `decodificarUrlQr`).
- `lector.ts`: `class LectorFacturas({ cliente: OllamaClient, modelo })` con `leerHoja(jpeg: Buffer): Promise<string>`: `/api/chat` **en streaming** (acumular por `alToken`; si Ollama corta con "token repeat limit" conservar lo acumulado), prompt `Table Recognition:`, `images: [base64]`, opciones `{ temperature: 0, num_ctx: 8192, num_predict: 6000 }`, `keepAlive: '2m'`, timeout 10 min; después `cortarRepeticion(texto)` (si una línea larga se repite, cortar ahí). Ampliar `ChatMensaje` en `assistant/ia/ollama.ts` con `images?: string[]`.
- `servicio.ts`: `class FacturasTelefono({ userDataDir, repos, cliente, log })`.
  - Config en `userData/facturas-telefono.json`: `{ activo: false, modelo: 'glm-ocr:q8_0' }`. `getConfig()`, `configurar()`, `estado()` (ollama disponible, modelo descargado, descarga en curso, cola), `descargarLector()` (patrón de `FlowyIA.descargarModelos`).
  - Sesiones de teléfono: `crearSesion(userId)` → `{ token (32 hex), vence (30 min) }`; `validarToken(token)` en tiempo constante.
  - Fotos en `userData/facturas-escaneadas/<id>/hoja-N.jpg`. `recibirFoto(token, jpeg)` (crea la factura `recibiendo` si no hay una abierta para ese token; máx. 12 hojas, 12 MB por foto, validar cabecera JPEG `FF D8`), `cerrarFactura(token)` → `en_cola` y arranca la cola.
  - Cola: de a una factura, de a una hoja; actualiza `pages_done`; al terminar: `unirHojas` + `leerQrFiscal` sobre cada hoja hasta encontrar uno + proveedor por CUIT del QR + vínculos (`article_supplier_codes`, o `barcode === codigo`) → `lista`. Errores → `error` con mensaje claro (Ollama apagado, modelo faltante). `releer(id)`, `descartar(id)` (borra fotos), al arrancar la app reencolar las que quedaron en `leyendo`/`en_cola`.
- `servidorFotos.ts`: `atenderFotos(servicio)` → `(req, res) => Promise<boolean>` para rutas `/lan/foto/<token>[/...]`:
  - `GET /lan/foto/<token>` → página HTML del teléfono (`paginaTelefono.ts`, HTML+JS inline, sin dependencias): botón grande "Sacar foto" (`<input type="file" accept="image/*" capture="environment">`), reduce en el teléfono a 2000 px de lado mayor (canvas → JPEG 0,88), miniaturas con "quitar", "Enviar factura", y después estado con sondeo ("Leyendo hoja 2 de 3", "Lista para revisar en la PC") y "Cargar otra factura".
  - `POST /lan/foto/<token>/hoja` (cuerpo `image/jpeg` crudo), `POST …/cerrar`, `GET …/estado`.
  - Token inválido/vencido u opción apagada → 404 con página "El enlace venció". Cabeceras `cache-control: no-store`, sin CORS abierto.
  - `class ServidorFotos` : escucha propia en `0.0.0.0:7790` (configurable) que sólo atiende esas rutas; `start()/stop()`; se levanta sólo con la opción activa (sirve en modo de una sola PC, donde LanServer no escucha en la red).
  - `LanServer`: nueva opción `rutaExtra?: (req, res) => Promise<boolean>` consultada al principio de `handle()` para URLs que empiezan con `/lan/foto/` (así también anda por el túnel `…mistockflow.com`). Sin otros cambios en LanServer.
- Test `electron/__tests__/facturas.smoke.ts` (+ script `test:facturas`): parser contra fixtures, servicio completo con Ollama falso (servidor http local que devuelve el texto de un fixture por streaming NDJSON), rutas HTTP (token malo → 404, foto no-JPEG → 400, límite de tamaño, flujo completo hoja→cerrar→estado→lista), vínculos por código.

### C. IPC (`facturas:*`) — `ipc/handlers/facturas.handlers.ts`, `types.ts`, `preload-bridge.ts`, `src/lib/api.ts`, `main.ts`, `handler-context.ts`
Grupo `facturas` ruteado por LAN (lo atiende el servidor). Canales (todos `withSession`; permiso `manage_purchases`, y `manage_hardware` para configurar/descargar):
`estado`, `configurar({activo})`, `descargarLector`, `vincular()` → `{ urlLocal, urlInternet | null, vence }` (IP local:7790; túnel si está conectado), `listar`, `obtener(id)` (renglones + artículo vinculado + sugerencias por descripción), `foto({id, hoja})` → data URL, `guardar({id, supplierId, header, lines})`, `releer(id)`, `descartar(id)`, `marcarCargada({id, vinculos: [{code, articleId}]})` (guarda los códigos de proveedor).
`configurar`, `descargarLector` van en `LAN_SERVER_DENIED_CHANNELS` y `REMOTO_DENIED_CHANNELS`.

### D. Pantallas
- `Configuración` → pestaña **"Facturas por teléfono"** (`src/components/FacturasTelefonoConfig.tsx`): casilla para activar, estado del lector (Ollama / modelo descargado, botón "Descargar lector (1,6 GB)" con barra), botón "Vincular teléfono" con QR.
- Ventana nueva **`facturasEscaneadas`** (`src/pages/FacturasEscaneadas.tsx`, registrada en `windows/registry.ts`, `requires: 'manage_purchases'`): lista (Estado: Leyendo/Lista/Error/Cargada), botón "Vincular teléfono", y vista de revisión: foto de la hoja a la izquierda; a la derecha proveedor, tipo, número y fecha (del QR si se leyó) y la tabla de renglones editable (código, descripción leída, artículo vinculado con buscador, cantidad, costo, importe, estado en color); suma de renglones contra el total del QR; "Descartar", "Volver a leer", "Cargar en Compras".
- `Compras.tsx`: botón "Facturas escaneadas" (visible sólo con la opción activa) y ampliar el prefill existente (`extras.prefilledLines`) con `header?: { supplierId, voucherType, invoiceNumber, dateIso, discount }`.
- Al cargar en Compras: cantidad = cantidad × UxB; costo = precio unitario de la factura. **Revisar en `Compras.tsx`/`purchases.service.ts` si `costPrice` se ingresa con o sin IVA** y convertir si hace falta (Factura A: los precios leídos son netos). Los renglones de descuento no son artículos: se suman y se informan; se cargan en el descuento global de la compra sólo si la base coincide; si no, se muestran para que el usuario decida.

## Ajustes de la auditoría (2-oct-2026)

Cambian lo escrito arriba en estos puntos:

- **Enlace del teléfono con topes**: vida máxima 2 h desde que se crea (aunque se lo siga usando), 20 facturas y 300 MB por enlace, 30 facturas sin leer entre todos. El QR fiscal no se busca en fotos de más de 25 MP.
- **Sólo lectura**: con la licencia fuera de `active` las rutas del teléfono contestan 404 y no se entregan enlaces (lo ya recibido se sigue leyendo).
- **Vínculo por código de barras**: sólo se vincula solo si el código leído tiene forma de EAN/UPC (8, 12, 13 o 14 dígitos con verificador). Si coincide con un código del padrón pero no es un EAN, se ofrece como primera sugerencia. «Quitar el vínculo» se guarda en el renglón (`sinVinculo`).
- **Parser**: reconoce la columna de bonificación por renglón (cantidad × precio × (1 − d/100) = importe → precio neto, `corregido`); no corrige la cantidad si la deducida no se parece a la leída; guarda la tasa de IVA del renglón (`tasaIva`); marca `revisar` el renglón repetido en el borde de dos hojas.
- **Revisión**: el tipo elegido se guarda en `header.tipo` (A/B/C/X); avisos por IVA de la factura ≠ IVA del artículo y por costo leído a más del doble o menos de la mitad del costo actual; las notas de crédito no se cargan; aviso de comprobante repetido (otra factura escaneada o compra ya registrada con ese proveedor y número).
- **`marcarCargada` lo llama Compras al REGISTRAR la compra**, no la revisión al abrir el formulario: hasta entonces la factura sigue `lista`.
- `estado()` trae `listas` (contador de Compras) y apagado no llama a Ollama. Las fotos y el texto de las facturas `cargada` se borran a los 90 días.
- `lectorSistema.ts` y `native/` (lector del sistema operativo) NO están integrados ni se empaquetan: el servicio lee sólo con GLM-OCR. Su prueba es `test:facturas-sistema`.

## Carga desde Compras y vinculador (2-oct-2026, tarde)

Pedido del dueño: "sacar la foto y que la factura complete el formulario de Compras; después el usuario sigue desde la PC", y vincular el teléfono desde Compras y no desde Configuración.

- **Compras → «Cargar con el teléfono»** (sólo con la opción activa; apagada, Compras queda igual: sin botón y sin sondear nada más que el estado de siempre). Abre el QR (el mismo `VincularTelefonoDialog`) y sigue la factura de ESE enlace con `facturas:seguir` ("Recibiendo hoja N…", "Leyendo hoja N de M…"). Al quedar lista, `decidirAtajo` (facturaACompra.ts, la misma decisión que el atajo de la lista):
  - completa (proveedor, tipo, todos los renglones con artículo —vinculado o **sugerido con confianza**—, nada en revisar, total que coincide, no cargada antes) → llena el formulario abierto, sin recargarlo, y avisa "Factura cargada desde el teléfono: revise y confirme la compra";
  - si no → abre Facturas escaneadas directo en la revisión de esa factura (`extras.facturaId`) y espera. Al tocar «Cargar en Compras» en la revisión, `facturas:aCompras` le avisa a la pantalla de Compras que la espera (la que pregunta con `esperaRevision`) y ésta la carga sin recargarse. Si nadie la espera (ventana cerrada), la revisión abre Compras con la factura como siempre.
  - Si el formulario ya tiene renglones, se pregunta antes de reemplazarlos.
- **Configuración** queda sólo para activar y «Mejorar lectura».
- **Vinculador** (servicio, al quedar `lista` y en `obtener`), en orden: (a) código del proveedor aprendido (`article_supplier_codes`); (b) código leído = código de barras (sólo con forma de EAN); (c) descripción aprendida de ese proveedor (`code = 'desc:' + descripción normalizada`, para los que no usan códigos, como ROA; sin migración nueva); (d) `asociador.ts` → `articleId` precargado con `sugerido: true`, etiqueta «Sugerido». Si el código del padrón (no EAN) dice un artículo y el parecido otro, no se propone ninguno. El padrón del asociador (artículos activos, sin los espejos de promociones) se arma una vez y se reusa mientras no cambie `count(*)`/`max(updated_at)` de `articles` (`ArticleRepository.huella`). `VERSION_LECTURA` = 4.
- **Lo sugerido no se recuerda** hasta que el usuario lo acepta («Aceptar sugeridos» o eligiéndolo): el pasaje no lo manda en `vinculos` y `marcarCargada` lo descarta igual. Tampoco nada de una hoja cortada en un borde (ahora `codigoDudoso` marca todos los renglones de esa hoja, con o sin código). En Compras los renglones sugeridos llevan la marca «Sugerido».
- **Revisión**: columna «Vínculo» (Código / Aprendido / Sugerido / Elegido / —), «Aceptar sugeridos», candidatos del asociador en el selector, **«Crear artículo»** (descripción, código de barras si el leído es EAN —si no, se escanea o se genera el próximo código interno—, costo con la regla neto/IVA del pasaje, proveedor de la factura, IVA y precio de venta opcional; usa `articles:create`), casilla marcada **"Guardar el CUIT … en este proveedor"** (proveedor elegido sin CUIT + CUIT leído válido que ningún otro proveedor tiene; se guarda con `suppliers:update` al guardar o cargar).
- Proveedor: además del CUIT y el nombre exacto, se SUGIERE (nunca se asigna) por los otros nombres de la hoja (`header.otrosNombres`: el de "Razón Social:", el de fantasía).
- **Factura repetida**: `obtener` trae `yaCargada` (compra registrada de ese proveedor con ese número, o factura escaneada «Cargada» con el mismo comprobante; `marcarCargada` anota `header.cargadaEl`). La revisión y Compras avisan "Esta factura ya fue cargada el dd/mm/aaaa" y no hay atajo.

## Revisión final (2-oct-2026, noche): lo que cambió

- **Código aprendido con descripción** (migración 0039: `article_supplier_codes.description`). `marcarCargada` guarda cómo imprimió el proveedor cada código; el vinculador (a) sólo confía en el código si la descripción de hoy es compatible con la aprendida (`descripcionesCompatibles`: las palabras de la más corta aparecen en la otra, tolerando un error de lectura o una abreviatura, y los tamaños no se contradicen). Si no, el artículo se OFRECE (primera sugerencia) y la factura va a revisión. Motivo: los códigos de proveedor no tienen dígito verificador; uno mal leído al aprenderlo es el código real de otro producto. Vínculos aprendidos antes de la columna (`NULL`) se confían como siempre.
- **Código en una línea aparte** (`parser.ts`, `RenglonLeido.codigoSuelto` → `codigoDudoso`): con columna de código, el suelto va al renglón siguiente (confiable sólo si el anterior tiene código); sin columna, si la hoja arranca con un renglón los códigos están DEBAJO (van al anterior), si no al siguiente, y siempre dudosos (no vinculan solos ni se recuerdan). `VERSION_LECTURA` = 5.
- **Clave de comprobante sin `tipoCmp`** (`ptoVta:nroCmp` + CUIT/proveedor, o CAE): la misma factura con y sin QR legible se reconoce como repetida.
- **`marcarCargada` recibe el `supplierId` de la compra**: los códigos se aprenden para ESE proveedor y la factura queda asociada a él si difiere. Compras marca «Cargada» sólo si queda alguno de los renglones precargados (`CompraLine.deFactura`); al quitarlos todos con el tacho, la referencia se limpia.
- **Espera por pantalla**: Compras se identifica (`pantalla`) en `seguir({ esperaRevision })`, la revisión lo recibe en `extras` y lo manda en `aCompras`; `recibe: true` sólo para esa pantalla. El sondeo baja a 15 s con la ventana en segundo plano, se corta si se cierra la ventana de revisión y a las 2 h.
- **`extras` sin recargar** (`WindowDef.extrasEnVivo`, Compras y Facturas escaneadas): el main process manda `desktopWindow:extras` a la ventana ya abierta en vez de `loadFile`. Compras pregunta «¿Reemplazar la compra en curso?» si tiene renglones; la revisión guarda lo corregido antes de cambiar de factura. Las demás ventanas siguen recargándose.
- **«Crear artículo» exige el tipo de comprobante** (sin tipo, el costo no se puede convertir); `puedeConfigurar` por permiso `manage_hardware`; `facturas:obtener/foto/seguir` son lecturas para la licencia en sólo lectura; `LectorSistema.disponible()` en Mac ejecuta `vision-ocr --probar`; el release de Mac compila `vision-ocr` en CI (`.github/workflows/release.yml`).

## Qué lector usa cada plataforma (3-oct-2026)

El lector de Windows (Windows.Media.Ocr) midió mal (122 de 140 renglones, 18 perdidos). Se integró **PaddleOCR (PP-OCRv5 mobile) sobre ONNX Runtime** en Node puro (`native/ocr-paddle/leer.mjs`, dependencia `onnxruntime-node`, decodificación con `jpeg-js`, sin sharp ni OpenCV): 140/140 renglones y las 4 facturas con total impreso cierran. Corre con el propio ejecutable de Electron como Node (`ELECTRON_RUN_AS_NODE=1`), así la PC del cliente no necesita Node. `LectorSistema` prueba los lectores en orden y, si uno falla (error, salida ilegible o ni una caja), pasa al siguiente; `LecturaSistema.lector` dice cuál leyó y el servicio lo registra en el log.

| Plataforma | 1.º | Respaldo | Notas |
|---|---|---|---|
| Windows (x64) | **paddle** (`ocr-paddle/leer.mjs`) | `windows-ocr` (`ocr-win/leer.ps1`) | Paddle: 2–4 s por hoja medidos sólo en la Mac; falta medir en una PC de comercio. `onnxruntime-node` viaja en `app.asar.unpacked` (onnxruntime.dll + DirectML/dxcompiler/dxil, 65 MB). |
| Mac (Apple Silicon) | **vision** (`ocr-mac/vision-ocr`, ~0,5 s) | `paddle` | Si Vision falla en una hoja, la lee Paddle sin que el usuario haga nada. |
| Mac (Intel) | **vision** | — | `onnxruntime-node` 1.30 no trae binario darwin/x64: Paddle da "no disponible" y queda sólo Vision. |
| Linux | **paddle** | — | Sin lector del sistema operativo. |

Después de todos los lectores sigue valiendo el respaldo de siempre: GLM-OCR por Ollama («Mejorar lectura»), si está instalado.

## Verificación final (la hace quien integra)
Typecheck, las baterías (`test:facturas`, `test:facturas-parser`, `test:facturas-servidor`, `test:facturas-compra`, `test:facturas-sistema` + las 26), `pnpm build` + `package:dry`, y prueba de punta a punta en la Mac: activar, vincular, subir las 4 fotos de `tools/ocr-facturas/muestras/` por HTTP como lo haría el teléfono, esperar la lectura real con Ollama y revisar la pantalla.
