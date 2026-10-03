/**
 * Página que abre el teléfono al escanear el QR de "Vincular teléfono".
 *
 * Es UN solo documento: HTML + CSS + JS en línea, sin dependencias y sin
 * pedir nada a internet (el teléfono puede estar en un Wi-Fi sin salida).
 *
 * Decisiones:
 *  - Dos modos, según cómo llegó el teléfono:
 *      · Por Wi-Fi (HTTP plano) los navegadores no dan la cámara "en vivo":
 *        la foto se saca con `<input type="file" capture>`, que abre la cámara
 *        del sistema, y se controla después de sacada.
 *      · Por internet (túnel, HTTPS) hay `getUserMedia`: se abre una vista en
 *        vivo con un recuadro guía A4 que, cada 300 ms, mide luz, reflejo,
 *        nitidez y cuánto del recuadro ocupa la hoja, y lo dice con un
 *        semáforo (rojo / ámbar / verde). La captura se recorta al recuadro y
 *        entra por EXACTAMENTE el mismo camino que una foto del input. Si la
 *        cámara falla (sin permiso, sin cámara) se cae al modo del input.
 *  - La foto se achica EN EL TELÉFONO a 2000 px de lado mayor (JPEG 0,88):
 *    una foto de 12 Mpx pesa 4–6 MB y el lector no gana nada con más de eso.
 *  - Orientación: los navegadores actuales ya giran la imagen según el EXIF
 *    al dibujarla; los viejos no. Se detecta con una imagen de prueba y, si
 *    hace falta, se lee el EXIF y se gira a mano.
 *  - La miniatura es un JPEG chico aparte: mostrar 12 fotos de 2000 px
 *    decodificadas tumba el Safari de un iPhone viejo.
 *  - Fotos malas: antes de subir se mide en el teléfono si la foto salió muy
 *    oscura o muy borrosa (sólo lo claramente malo: umbrales medidos con las
 *    fotos reales de tools/ocr-facturas/muestras), y al subir la PC la lee y
 *    puede rechazarla (422 `FOTO`: cortada, torcida, ilegible). En los dos
 *    casos se muestra el motivo y se pide repetirla, con «Usar igual» para no
 *    trabar a nadie (se reenvía con `?forzar=1`).
 *  - JS en ES5 (var/function) a propósito: tiene que andar en el teléfono
 *    que haya en el depósito, no sólo en el último modelo.
 *  - El token no se escribe en el HTML: el script lo toma de la dirección.
 *
 * OJO al editar el script: va dentro de `String.raw`, así que no puede
 * contener acentos graves ni la secuencia "${".
 */

const ESTILOS = String.raw`
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:#f3f4f6;color:#111827;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
header{padding:16px 16px 8px;padding-top:calc(16px + env(safe-area-inset-top))}
h1{margin:0;font-size:22px}
header p{margin:4px 0 0;color:#4b5563;font-size:15px}
main{padding:8px 16px 220px}
[hidden]{display:none!important}
.aviso{margin:8px 0;padding:12px;border-radius:10px;background:#fef3c7;color:#78350f;font-size:15px}
.aviso.error{background:#fee2e2;color:#7f1d1d}
.aviso button{margin-top:8px;margin-right:8px}
.vacio{margin:32px 0;text-align:center;color:#6b7280}
.hojas{list-style:none;margin:8px 0;padding:0}
.hojas li{display:flex;align-items:center;gap:12px;margin:0 0 8px;padding:8px;border-radius:12px;background:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.08)}
.hojas img{width:64px;height:84px;object-fit:cover;border-radius:6px;background:#e5e7eb;flex:none}
.hojas .dato{flex:1;min-width:0}
.hojas .num{font-weight:600}
.hojas .det{font-size:13px;color:#6b7280}
.chico{min-height:44px;padding:0 14px;border:1px solid #d1d5db;border-radius:10px;background:#fff;color:#b91c1c;
  font:inherit;font-size:15px}
.barra{position:fixed;left:0;right:0;bottom:0;padding:12px 16px;padding-bottom:calc(12px + env(safe-area-inset-bottom));
  background:rgba(255,255,255,.96);border-top:1px solid #e5e7eb}
.btn{display:block;width:100%;min-height:60px;margin:0 0 10px;padding:16px;border:0;border-radius:14px;
  font:inherit;font-size:19px;font-weight:600;text-align:center;cursor:pointer;-webkit-appearance:none;appearance:none}
.primario{background:#1d4ed8;color:#fff}
.secundario{background:#fff;color:#1d4ed8;border:2px solid #1d4ed8}
.btn[disabled],.btn.apagado{opacity:.45;pointer-events:none}
.enlace{display:block;min-height:36px;padding:6px;text-align:center;color:#4b5563;font-size:15px;text-decoration:underline}
.oculto{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none}
.centro{margin-top:48px;text-align:center}
.centro .titulo{font-size:22px;font-weight:600;margin:0 0 8px}
.centro .detalle{color:#4b5563;margin:0 0 20px}
progress{width:100%;height:14px}
.bien{color:#166534}
.mal{color:#b91c1c}
@media (prefers-color-scheme:dark){
  body{background:#111827;color:#f3f4f6}
  header p,.vacio,.centro .detalle,.enlace,.hojas .det{color:#9ca3af}
  .hojas li{background:#1f2937}
  .barra{background:rgba(17,24,39,.96);border-color:#374151}
  .secundario{background:#111827;color:#93c5fd;border-color:#93c5fd}
  .chico{background:#1f2937;border-color:#4b5563;color:#fca5a5}
  .bien{color:#86efac}.mal{color:#fca5a5}
}
/* cámara guiada (sólo HTTPS): vista en vivo a pantalla completa con recuadro A4 */
body.cam-abierta{overflow:hidden}
.cam{position:fixed;left:0;top:0;right:0;bottom:0;z-index:20;background:#000;color:#fff;overflow:hidden;
  -webkit-user-select:none;user-select:none}
.cam video{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#000}
.cam-guia{position:absolute;color:#e5e7eb;border:2px solid currentColor;border-radius:8px;
  box-shadow:0 0 0 4000px rgba(0,0,0,.55);transition:color .25s}
.cam-guia i{position:absolute;width:30px;height:30px;border:0 solid currentColor}
.cam-guia i:nth-child(1){left:-3px;top:-3px;border-left-width:5px;border-top-width:5px;border-top-left-radius:10px}
.cam-guia i:nth-child(2){right:-3px;top:-3px;border-right-width:5px;border-top-width:5px;border-top-right-radius:10px}
.cam-guia i:nth-child(3){left:-3px;bottom:-3px;border-left-width:5px;border-bottom-width:5px;border-bottom-left-radius:10px}
.cam-guia i:nth-child(4){right:-3px;bottom:-3px;border-right-width:5px;border-bottom-width:5px;border-bottom-right-radius:10px}
.cam.rojo .cam-guia{color:#ef4444}.cam.ambar .cam-guia{color:#f59e0b}.cam.verde .cam-guia{color:#22c55e}
.cam-arriba{position:absolute;left:0;right:0;top:0;padding:calc(10px + env(safe-area-inset-top)) 16px 0;text-align:center}
.cam-ayuda{margin:0 0 8px;font-size:14px;color:#e5e7eb;text-shadow:0 1px 2px #000}
.cam-msj{display:inline-block;max-width:100%;margin:0;padding:11px 18px;border-radius:999px;background:rgba(17,24,39,.8);
  font-size:17px;font-weight:600;line-height:1.3}
.cam.rojo .cam-msj{background:rgba(185,28,28,.9)}.cam.ambar .cam-msj{background:rgba(180,83,9,.9)}
.cam.verde .cam-msj{background:rgba(21,128,61,.9)}
.cam-abajo{position:absolute;left:0;right:0;bottom:0;padding:8px 16px calc(14px + env(safe-area-inset-bottom))}
.cam-contador{display:flex;align-items:center;justify-content:center;gap:10px;min-height:40px;margin:0 0 6px;
  font-size:15px;text-shadow:0 1px 2px #000}
.cam-contador img{width:30px;height:40px;object-fit:cover;border-radius:4px;border:1px solid #fff;background:#374151}
.cam-fila{display:flex;align-items:center}
.cam-lado{flex:1;display:flex}
.cam-lado.der{justify-content:flex-end}
.cam-btn{min-height:56px;min-width:56px;padding:0 16px;border:0;border-radius:14px;background:rgba(255,255,255,.18);
  color:#fff;font:inherit;font-size:16px;font-weight:600;-webkit-appearance:none;appearance:none}
.cam-captura{flex:none;width:78px;height:78px;padding:0;border:5px solid #fff;border-radius:50%;
  background:rgba(255,255,255,.3);box-shadow:0 0 0 3px rgba(0,0,0,.45);-webkit-appearance:none;appearance:none}
.cam.verde .cam-captura{background:#22c55e}
.cam-captura[disabled]{opacity:.5}
.cam-flash{position:absolute;left:0;top:0;right:0;bottom:0;background:#fff;opacity:0;pointer-events:none;transition:opacity .3s}
.cam-flash.ya{opacity:.9;transition:none}
`;

const SCRIPT = String.raw`
(function () {
  'use strict';
  var MAX_HOJAS = 12, LADO = 2000, CALIDAD = 0.88, SONDEO_MS = 3000;
  // Control de la foto en el teléfono, sobre una copia de 800 px de lado mayor.
  // Con las fotos reales: brillo medio 150-175; nitidez (varianza de bordes)
  // 700-2700 en una foto buena, 35-80 apenas movida (se lee) y menos de 7
  // desenfocada. Se rechaza sólo lo claramente malo.
  var LADO_CONTROL = 800, BRILLO_MINIMO = 45, NITIDEZ_MINIMA = 12;
  // Cámara guiada (sólo HTTPS). La captura se recorta al recuadro con un margen
  // del 4 % y sale como JPEG 0,9 de 2400 px como máximo; después sigue el
  // mismo camino que una foto del input (2000 px, control, miniatura, envío).
  var ANALISIS_MS = 300, LADO_VIVO = 240, LADO_CAPTURA = 2400, CALIDAD_CAPTURA = 0.9, MARGEN_RECORTE = 0.04;
  // Umbrales del análisis en vivo, medidos sobre el recuadro reducido a 240 px
  // de ancho con las mismas fotos reales: luminancia media 153-175; sin píxeles
  // saturados; varianza del laplaciano 980-2200 nítida y 1-28 desenfocada;
  // 74-96 % de píxeles "papel". Se avisa sólo de lo que se nota.
  var LUZ_MINIMA = 80, REFLEJO_MAXIMO = 0.1, NITIDEZ_VIVO = 120, HOJA_MINIMA = 0.25, LLENADO_MINIMO = 0.85;
  var FRANJA_ADENTRO = 0.04, FRANJA_AFUERA = 0.08;
  var guiada = !!(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
    window.Promise && window.Float32Array);
  var cam = { activa: false, stream: null, pista: null, video: null, lienzo: null, gris: null, reloj: null, guia: null,
    nitidez: [], votos: [], cambio: 0, estado: '', clase: '', luz: false, volver: false, preparando: false };
  var base = location.pathname.replace(/\/+$/, '');
  var hojas = [];      // { blob, mini, enviada, forzar }
  var dudosa = null;   // pregunta abierta por una foto mala: { repetir, usar }
  var lugar = null;    // posición donde va la foto que reemplaza a una rechazada
  var previas = 0;     // hojas que la PC ya tenía de esta factura (página recargada)
  var puedeQuitar = false;
  var ocupado = false;
  var reloj = null;
  var vista = 'captura';

  function $(id) { return document.getElementById(id); }
  function plural(n) { return n + (n === 1 ? ' hoja' : ' hojas'); }

  function mostrar(v) {
    vista = v;
    $('v-captura').hidden = v !== 'captura';
    $('barra').hidden = v !== 'captura';
    $('v-enviando').hidden = v !== 'enviando';
    $('v-estado').hidden = v !== 'estado';
    $('v-vencido').hidden = v !== 'vencido';
    if (v !== 'estado' && reloj) { clearTimeout(reloj); reloj = null; }
    window.scrollTo(0, 0);
  }

  function aviso(texto, esError) {
    var a = $('aviso');
    a.textContent = texto || '';
    a.className = 'aviso' + (esError ? ' error' : '');
    a.hidden = !texto;
  }

  /* ---------- foto mala: repetir o usar igual ---------- */

  function preguntar(texto, repetir, usar) {
    dudosa = { repetir: repetir, usar: usar };
    $('dudosa-texto').textContent = texto;
    $('dudosa').hidden = false;
    pintar();
    window.scrollTo(0, 0);
  }

  function responder(usar) {
    var d = dudosa;
    if (!d) return;
    dudosa = null;
    $('dudosa').hidden = true;
    if (usar) d.usar(); else d.repetir();
  }

  function agregar(hoja) {
    // La foto que reemplaza a una rechazada va en su lugar, no al final.
    if (lugar !== null && lugar <= hojas.length) hojas.splice(lugar, 0, hoja);
    else hojas.push(hoja);
    lugar = null;
  }

  /** Motivo por el que la foto no sirve (muy oscura o muy borrosa), o null. */
  function fotoMala(c) {
    try {
      if (!window.Float32Array) return null;
      var esc = Math.min(1, LADO_CONTROL / Math.max(c.width, c.height));
      var w = Math.max(3, Math.round(c.width * esc)), h = Math.max(3, Math.round(c.height * esc));
      var q = document.createElement('canvas');
      q.width = w; q.height = h;
      var qx = q.getContext('2d');
      qx.drawImage(c, 0, 0, w, h);
      var d = qx.getImageData(0, 0, w, h).data;
      q.width = q.height = 0;
      var g = new Float32Array(w * h), suma = 0, i, j, x, y, l;
      for (i = 0, j = 0; i < g.length; i++, j += 4) {
        g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
        suma += g[i];
      }
      if (suma / g.length < BRILLO_MINIMO) {
        return 'La foto salió muy oscura. Por favor, vuelva a sacarla con más luz.';
      }
      // Nitidez: varianza de los bordes (laplaciano) de la imagen en grises.
      var s1 = 0, s2 = 0, n = 0;
      for (y = 1; y < h - 1; y++) {
        for (x = 1; x < w - 1; x++) {
          i = y * w + x;
          l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
          s1 += l; s2 += l * l; n++;
        }
      }
      if (n && s2 / n - (s1 / n) * (s1 / n) < NITIDEZ_MINIMA) {
        return 'La foto salió muy borrosa. Por favor, vuelva a sacarla sin mover el teléfono y espere a que enfoque.';
      }
    } catch (e) { /* si no se puede medir, la foto sigue: la controla la PC */ }
    return null;
  }

  /* ---------- pedidos a la PC ---------- */

  function pedir(metodo, ruta, cuerpo, listo, alProgreso) {
    var x = new XMLHttpRequest();
    x.open(metodo, base + ruta);
    x.timeout = cuerpo ? 120000 : 15000;
    if (cuerpo) x.setRequestHeader('Content-Type', 'image/jpeg');
    if (alProgreso && x.upload) {
      x.upload.onprogress = function (e) { if (e.lengthComputable) alProgreso(e.loaded / e.total); };
    }
    x.onload = function () {
      var r = null;
      try { r = JSON.parse(x.responseText); } catch (e) { r = null; }
      listo(x.status, r);
    };
    x.onerror = x.ontimeout = function () { listo(0, null); };
    x.send(cuerpo || null);
  }

  /* ---------- orientación (sólo navegadores viejos) ---------- */

  var autoOrienta = null, esperando = [];
  function detectarOrientacion(cb) {
    if (autoOrienta !== null) { cb(autoOrienta); return; }
    esperando.push(cb);
    if (esperando.length > 1) return;
    var fin = function (v) {
      autoOrienta = v;
      var e = esperando; esperando = [];
      for (var i = 0; i < e.length; i++) e[i](v);
    };
    // JPEG de 3x2 con orientación EXIF 6: si el navegador la respeta, mide 2x3.
    var p = new Image();
    p.onload = function () { fin(p.width === 2 && p.height === 3); };
    p.onerror = function () { fin(true); };
    p.src = 'data:image/jpeg;base64,/9j/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wCEAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/AABEIAAIAAwMBEQACEQEDEQH/xABRAAEAAAAAAAAAAAAAAAAAAAAKEAEBAQADAQEAAAAAAAAAAAAGBQQDCAkCBwEBAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AG8T9NfSMEVMhQvoP3fFiRZ+MTHDifa/95OFSZU5OzRzxkyejv8ciEfhSceSXGjS8eSdLnZc2HDm4M3BxcXwH/9k=';
  }

  function exifDe(buf) {
    try {
      var v = new DataView(buf);
      if (v.byteLength < 12 || v.getUint16(0) !== 0xFFD8) return 1;
      var p = 2;
      while (p + 4 <= v.byteLength) {
        var m = v.getUint16(p), n = v.getUint16(p + 2);
        if (m === 0xFFE1 && p + 18 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {
          var t = p + 10;
          var le = v.getUint16(t) === 0x4949;
          var ifd = t + v.getUint32(t + 4, le);
          if (ifd + 2 > v.byteLength) return 1;
          var c = v.getUint16(ifd, le);
          for (var i = 0; i < c; i++) {
            var e = ifd + 2 + i * 12;
            if (e + 12 > v.byteLength) return 1;
            if (v.getUint16(e, le) === 0x0112) {
              var o = v.getUint16(e + 8, le);
              return o >= 1 && o <= 8 ? o : 1;
            }
          }
          return 1;
        }
        if ((m & 0xFF00) !== 0xFF00 || m === 0xFFDA) return 1;
        p += 2 + n;
      }
    } catch (e) { /* EXIF roto: se deja como vino */ }
    return 1;
  }

  function orientacionDe(file, cb) {
    detectarOrientacion(function (auto) {
      if (auto || !window.FileReader || !window.DataView) { cb(1); return; }
      var r = new FileReader();
      r.onload = function () { cb(exifDe(r.result)); };
      r.onerror = function () { cb(1); };
      r.readAsArrayBuffer(file.slice(0, 131072));
    });
  }

  /* ---------- reducir la foto ---------- */

  function aBlob(canvas, cb, calidad) {
    if (typeof calidad !== 'number') calidad = CALIDAD;
    if (canvas.toBlob) { canvas.toBlob(cb, 'image/jpeg', calidad); return; }
    var bin = atob(canvas.toDataURL('image/jpeg', calidad).split(',')[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    cb(new Blob([arr], { type: 'image/jpeg' }));
  }

  function reducir(file, listo) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    var soltar = function () { URL.revokeObjectURL(url); img.onload = img.onerror = null; };
    img.onerror = function () { soltar(); listo('No se pudo leer la foto. Intente sacarla de nuevo.'); };
    img.onload = function () {
      orientacionDe(file, function (o) {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) throw new Error('vacía');
          var esc = Math.min(1, LADO / Math.max(w, h));
          var dw = Math.max(1, Math.round(w * esc)), dh = Math.max(1, Math.round(h * esc));
          var gira = o >= 5;
          var c = document.createElement('canvas');
          c.width = gira ? dh : dw;
          c.height = gira ? dw : dh;
          var x = c.getContext('2d');
          x.fillStyle = '#fff';
          x.fillRect(0, 0, c.width, c.height);
          if (o === 2) x.transform(-1, 0, 0, 1, dw, 0);
          else if (o === 3) x.transform(-1, 0, 0, -1, dw, dh);
          else if (o === 4) x.transform(1, 0, 0, -1, 0, dh);
          else if (o === 5) x.transform(0, 1, 1, 0, 0, 0);
          else if (o === 6) x.transform(0, 1, -1, 0, dh, 0);
          else if (o === 7) x.transform(0, -1, -1, 0, dh, dw);
          else if (o === 8) x.transform(0, -1, 1, 0, 0, dw);
          x.drawImage(img, 0, 0, dw, dh);
          soltar();
          var problema = fotoMala(c);

          var em = Math.min(1, 240 / Math.max(c.width, c.height));
          var m = document.createElement('canvas');
          m.width = Math.max(1, Math.round(c.width * em));
          m.height = Math.max(1, Math.round(c.height * em));
          m.getContext('2d').drawImage(c, 0, 0, m.width, m.height);
          var mini = m.toDataURL('image/jpeg', 0.6);
          m.width = m.height = 0;

          aBlob(c, function (blob) {
            c.width = c.height = 0; // Safari no suelta la memoria del canvas si no
            if (!blob) { listo('No se pudo preparar la foto. Intente de nuevo.'); return; }
            listo(null, { blob: blob, mini: mini, enviada: false, forzar: false, problema: problema });
          });
        } catch (e) {
          soltar();
          listo('No se pudo preparar la foto. Intente de nuevo.');
        }
      });
    };
    img.src = url;
  }

  /* ---------- pantalla de captura ---------- */

  function pintar() {
    var lista = $('lista');
    while (lista.firstChild) lista.removeChild(lista.firstChild);
    for (var i = 0; i < hojas.length; i++) lista.appendChild(fila(i));
    var total = previas + hojas.length;
    $('vacio').hidden = total > 0;
    var lleno = total >= MAX_HOJAS;
    // Con una pregunta abierta (foto mala) no se saca ni se envía nada hasta contestarla.
    var trabado = ocupado || !!dudosa;
    var foto = $('btn-foto');
    var proxima = (lugar !== null && lugar <= hojas.length ? previas + lugar : total) + 1;
    foto.textContent = dudosa ? 'Sacar foto de la hoja ' + (total + 1)
      : ocupado ? 'Preparando la foto…'
      : lleno ? 'Máximo de ' + MAX_HOJAS + ' hojas por factura'
      : 'Sacar foto de la hoja ' + proxima;
    foto.className = 'btn ' + (total > 0 ? 'secundario' : 'primario') + (trabado || lleno ? ' apagado' : '');
    $('camara').disabled = $('galeria').disabled = trabado || lleno;
    // Con HTTPS el botón grande abre la cámara guiada en lugar del input.
    var abrir = $('btn-camara');
    abrir.hidden = !guiada;
    foto.hidden = guiada;
    if (guiada) {
      abrir.textContent = ocupado ? 'Preparando la foto…'
        : lleno ? 'Máximo de ' + MAX_HOJAS + ' hojas por factura'
        : total > 0 || lugar !== null ? 'Abrir la cámara para la hoja ' + (dudosa ? total + 1 : proxima)
        : 'Abrir la cámara';
      abrir.className = foto.className;
      abrir.disabled = trabado || lleno;
    }
    $('lbl-galeria').hidden = lleno;
    var enviar = $('btn-enviar');
    enviar.textContent = total > 0 ? 'Enviar factura (' + plural(total) + ')' : 'Enviar factura';
    enviar.disabled = trabado || total === 0;
    enviar.hidden = total === 0;
    var prev = $('previas');
    prev.hidden = previas === 0;
    if (previas > 0) {
      $('previas-texto').textContent = 'Esta factura ya tiene ' + plural(previas) +
        (previas === 1 ? ' enviada' : ' enviadas') + ' a la PC. Las fotos nuevas se agregan a continuación.';
      $('btn-quitar-previa').hidden = !puedeQuitar;
    }
  }

  function fila(i) {
    var h = hojas[i];
    var li = document.createElement('li');
    var img = document.createElement('img');
    img.src = h.mini; img.alt = '';
    var d = document.createElement('div'); d.className = 'dato';
    var n = document.createElement('div'); n.className = 'num';
    n.textContent = 'Hoja ' + (previas + i + 1);
    var det = document.createElement('div'); det.className = 'det';
    det.textContent = h.enviada ? 'Enviada' : Math.max(1, Math.round(h.blob.size / 1024)) + ' KB';
    d.appendChild(n); d.appendChild(det);
    li.appendChild(img); li.appendChild(d);
    if (!h.enviada) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chico'; b.textContent = 'Quitar';
      b.setAttribute('aria-label', 'Quitar la hoja ' + (previas + i + 1));
      b.onclick = function () { if (ocupado || dudosa) return; hojas.splice(i, 1); lugar = null; aviso(''); pintar(); };
      li.appendChild(b);
    }
    return li;
  }

  function alElegir(ev) {
    var entrada = ev.target, cola = [];
    for (var i = 0; entrada.files && i < entrada.files.length; i++) cola.push(entrada.files[i]);
    entrada.value = '';
    if (!cola.length || ocupado) return;
    procesar(cola, false);
  }

  /**
   * Único camino de entrada de las fotos: las del input (cámara del sistema
   * o galería) y las capturadas en la vista en vivo pasan por acá.
   */
  function procesar(cola, desdeCamara) {
    ocupado = true; aviso(''); pintar();
    var sigue = function () {
      var f = cola.shift();
      if (!f || previas + hojas.length >= MAX_HOJAS) {
        ocupado = false; pintar();
        var li = $('lista').lastChild;
        if (li && li.scrollIntoView) li.scrollIntoView(false);
        if (desdeCamara) trasCaptura();
        return;
      }
      reducir(f, function (err, hoja) {
        if (err) { if (desdeCamara) cerrarCamara(); aviso(err, true); sigue(); return; }
        if (!hoja.problema) { agregar(hoja); sigue(); return; }
        // Foto claramente mala: se pregunta antes de agregarla. La pregunta
        // vive en la lista: la cámara se cierra y, contestada, se vuelve a abrir.
        if (desdeCamara) { cerrarCamara(); cam.volver = true; }
        preguntar(hoja.problema, sigue, function () { hoja.forzar = true; agregar(hoja); sigue(); });
      });
    };
    sigue();
  }

  /* ---------- cámara guiada (sólo HTTPS: el enlace "Por internet") ---------- */

  function abrirCamara() {
    if (!guiada || cam.activa || ocupado || dudosa || previas + hojas.length >= MAX_HOJAS) return;
    cam.video = $('cam-video');
    cam.activa = true; cam.nitidez = []; cam.votos = []; cam.cambio = 0; cam.estado = ''; cam.luz = false;
    cam.preparando = false;
    $('cam').hidden = false;
    $('cam-captura').disabled = false;
    $('cam-luz').hidden = true;
    $('cam-luz').textContent = 'Linterna';
    document.body.className = 'cam-abierta';
    semaforo('', 'Buscando la cámara…');
    ubicarGuia();
    camContador();
    var pedido = { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } };
    navigator.mediaDevices.getUserMedia(pedido).then(function (stream) {
      if (!cam.activa) { apagar(stream); return; }
      cam.stream = stream;
      cam.pista = stream.getVideoTracks()[0] || null;
      var v = cam.video;
      v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', ''); v.muted = true;
      if ('srcObject' in v) v.srcObject = stream; else v.src = URL.createObjectURL(stream);
      var p = v.play();
      if (p && p.then) p.then(null, function () {});
      if (cam.pista) {
        cam.pista.onended = function () {
          if (!cam.activa) return;
          cerrarCamara();
          aviso('La cámara se cerró. Toque «Abrir la cámara» para seguir.', true);
        };
        try {
          var caps = cam.pista.getCapabilities ? cam.pista.getCapabilities() : null;
          if (caps && caps.torch) $('cam-luz').hidden = false;
        } catch (e) { /* sin linterna */ }
      }
      semaforo('', 'Encuadre la hoja completa dentro del recuadro');
      cam.reloj = setTimeout(analizar, ANALISIS_MS);
    }, sinCamara);
  }

  /** La cámara no se pudo abrir: se avisa y se sigue con el input, sin recargar. */
  function sinCamara(err) {
    cerrarCamara();
    guiada = false;
    var nombre = (err && err.name) || '';
    aviso((nombre === 'NotAllowedError' || nombre === 'SecurityError'
      ? 'No se dio permiso para usar la cámara en esta página.'
      : nombre === 'NotFoundError' || nombre === 'OverconstrainedError'
        ? 'No se encontró una cámara que se pueda usar desde esta página.'
        : 'No se pudo abrir la cámara en esta página.') +
      ' Puede sacar las fotos igual con el botón «Sacar foto de la hoja».', true);
    pintar();
  }

  function apagar(stream) {
    try {
      var t = stream ? stream.getTracks() : [];
      for (var i = 0; i < t.length; i++) t[i].stop();
    } catch (e) { /* ya estaba apagada */ }
  }

  function cerrarCamara() {
    if (cam.reloj) { clearTimeout(cam.reloj); cam.reloj = null; }
    cam.activa = false; cam.preparando = false; cam.luz = false;
    apagar(cam.stream);
    cam.stream = null; cam.pista = null;
    if (cam.video) {
      try { if ('srcObject' in cam.video) cam.video.srcObject = null; else cam.video.removeAttribute('src'); } catch (e) { /* nada */ }
    }
    $('cam').hidden = true;
    document.body.className = '';
    pintar();
  }

  function semaforo(clase, texto) {
    cam.clase = clase;
    $('cam').className = 'cam' + (clase ? ' ' + clase : '');
    $('cam-msj').textContent = texto;
  }

  function camContador() {
    var total = previas + hojas.length;
    var proxima = (lugar !== null && lugar <= hojas.length ? previas + lugar : total) + 1;
    $('cam-contador-texto').textContent = 'Hoja ' + proxima +
      (total ? ' · ' + plural(total) + (total === 1 ? ' tomada' : ' tomadas') : '');
    var mini = $('cam-mini');
    if (hojas.length) { mini.src = hojas[hojas.length - 1].mini; mini.hidden = false; } else mini.hidden = true;
    $('cam-cerrar').textContent = total ? 'Listo' : 'Cerrar';
  }

  /** Recuadro guía A4 vertical, centrado, entre el mensaje de arriba y los botones de abajo. */
  function ubicarGuia() {
    if (!cam.activa) return;
    var raiz = $('cam'), W = raiz.clientWidth || window.innerWidth, H = raiz.clientHeight || window.innerHeight;
    var arriba = 150, abajo = 175;
    var altoLibre = Math.max(120, H - arriba - abajo), anchoLibre = Math.max(120, W - 32);
    var w = Math.min(anchoLibre, altoLibre * 210 / 297), h = w * 297 / 210;
    cam.guia = { x: (W - w) / 2, y: arriba + (altoLibre - h) / 2, w: w, h: h, W: W, H: H };
    var g = $('cam-guia').style;
    g.left = cam.guia.x + 'px'; g.top = cam.guia.y + 'px'; g.width = w + 'px'; g.height = h + 'px';
  }

  /** El recuadro en píxeles del video (el video se muestra con object-fit: cover). */
  function recuadroEnVideo() {
    var v = cam.video, vw = v ? v.videoWidth : 0, vh = v ? v.videoHeight : 0, g = cam.guia;
    if (!vw || !vh || !g) return null;
    var esc = Math.max(g.W / vw, g.H / vh);
    var ox = (g.W - vw * esc) / 2, oy = (g.H - vh * esc) / 2;
    return { x: (g.x - ox) / esc, y: (g.y - oy) / esc, w: g.w / esc, h: g.h / esc, vw: vw, vh: vh };
  }

  function analizar() {
    cam.reloj = null;
    if (!cam.activa) return;
    cam.reloj = setTimeout(analizar, ANALISIS_MS);
    if (cam.preparando || cam.video.readyState < 2) return;
    var r = recuadroEnVideo();
    if (!r) return;
    try {
      // Región = recuadro + franja de afuera, recortada al cuadro del video,
      // reducida para que el recuadro mida LADO_VIVO px de ancho.
      var fa = FRANJA_AFUERA;
      var x0 = Math.max(0, r.x - r.w * fa), y0 = Math.max(0, r.y - r.h * fa);
      var x1 = Math.min(r.vw, r.x + r.w * (1 + fa)), y1 = Math.min(r.vh, r.y + r.h * (1 + fa));
      if (x1 - x0 < 8 || y1 - y0 < 8) return;
      var esc = LADO_VIVO / r.w;
      var w = Math.max(4, Math.round((x1 - x0) * esc)), h = Math.max(4, Math.round((y1 - y0) * esc));
      var c = cam.lienzo || (cam.lienzo = document.createElement('canvas'));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      var cx = c.getContext('2d', { willReadFrequently: true }) || c.getContext('2d');
      cx.drawImage(cam.video, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h);
      var d = cx.getImageData(0, 0, w, h).data;
      var rx = Math.max(0, Math.min(w - 2, Math.round((r.x - x0) * esc)));
      var ry = Math.max(0, Math.min(h - 2, Math.round((r.y - y0) * esc)));
      var rw = Math.max(2, Math.min(w - rx, Math.round(r.w * esc)));
      var rh = Math.max(2, Math.min(h - ry, Math.round(r.h * esc)));
      var v = medirVivo(d, w, h, rx, ry, rw, rh);
      // Se muestra el veredicto que más se repite en las últimas 3 muestras, y un
      // cambio espera 900 ms desde el anterior (salvo rojo, que entra al instante):
      // con la mano temblorosa no titila, y tampoco puede quedar trabado en uno viejo.
      var clave = v[0] + '|' + v[1], k, q, c2, mas = 0, mejor = clave;
      cam.votos.push(clave);
      if (cam.votos.length > 3) cam.votos.shift();
      for (k = 0; k < cam.votos.length; k++) {
        for (q = 0, c2 = 0; q < cam.votos.length; q++) if (cam.votos[q] === cam.votos[k]) c2++;
        if (c2 > mas) { mas = c2; mejor = cam.votos[k]; }
      }
      var ahora = Date.now(), esRojo = mejor.indexOf('rojo|') === 0;
      if (mejor !== cam.estado && (mas >= 2 || cam.votos.length < 2) && (esRojo || !cam.cambio || ahora - cam.cambio >= 900)) {
        cam.estado = mejor; cam.cambio = ahora;
        var partes = mejor.split('|');
        semaforo(partes[0], partes[1]);
      }
    } catch (e) { /* si no se puede medir, la guía queda neutra y la captura sigue andando */ }
  }

  /**
   * Mide la región reducida y devuelve [clase, mensaje]: una sola cosa a la vez,
   * de lo más grave a lo más fino (luz, reflejo, hoja, encuadre, foco).
   */
  function medirVivo(d, w, h, rx, ry, rw, rh) {
    var g = cam.gris && cam.gris.length === w * h ? cam.gris : (cam.gris = new Float32Array(w * h));
    var i, j, x, y, l, k;
    for (i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    // Núcleo central del recuadro: ahí está la hoja si está más o menos centrada.
    var sc = 0, nc = 0;
    for (y = ry + (rh >> 2); y < ry + rh - (rh >> 2); y++) {
      for (x = rx + (rw >> 2); x < rx + rw - (rw >> 2); x++) { sc += g[y * w + x]; nc++; }
    }
    var Lc = nc ? sc / nc : 0;
    var papelDesde = Math.max(70, 0.72 * Lc), tintaHasta = 0.5 * Lc;
    // Dentro del recuadro: luz, reflejo, papel por columna y fila, nitidez.
    var suma = 0, clip = 0, papel = 0, n = 0, s1 = 0, s2 = 0, nl = 0, lap;
    var cols = new Int32Array(rw), filas = new Int32Array(rh);
    for (y = ry; y < ry + rh; y++) {
      for (x = rx; x < rx + rw; x++) {
        i = y * w + x; l = g[i];
        suma += l; n++;
        if (l >= 252) clip++;
        if (l > papelDesde) { papel++; cols[x - rx]++; filas[y - ry]++; }
        if (x > rx && x < rx + rw - 1 && y > ry && y < ry + rh - 1) {
          lap = 4 * l - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
          s1 += lap; s2 += lap * lap; nl++;
        }
      }
    }
    var media = suma / n, fracPapel = papel / n;
    var nit = nl ? s2 / nl - (s1 / nl) * (s1 / nl) : 0;
    cam.nitidez.push(nit);
    if (cam.nitidez.length > 3) cam.nitidez.shift();
    var nitProm = 0;
    for (k = 0; k < cam.nitidez.length; k++) nitProm += cam.nitidez[k];
    nitProm /= cam.nitidez.length;
    // Cuánto del recuadro cubre la hoja: columnas y filas con más de la mitad de papel.
    var anchoHoja = 0, altoHoja = 0;
    for (x = 0; x < rw; x++) if (cols[x] * 2 > rh) anchoHoja++;
    for (y = 0; y < rh; y++) if (filas[y] * 2 > rw) altoHoja++;
    // Desborde: tinta pegada al borde de adentro y claro justo afuera → la hoja
    // sigue más allá del recuadro y el recorte la cortaría.
    var fi = Math.max(1, Math.round(rw * FRANJA_ADENTRO)), desborda = false;
    var lados = [
      [rx, rx + fi, ry, ry + rh, 0, rx, ry, ry + rh],
      [rx + rw - fi, rx + rw, ry, ry + rh, rx + rw, w, ry, ry + rh],
      [rx, rx + rw, ry, ry + fi, rx, rx + rw, 0, ry],
      [rx, rx + rw, ry + rh - fi, ry + rh, rx, rx + rw, ry + rh, h]
    ];
    for (k = 0; k < lados.length && !desborda; k++) {
      var L = lados[k];
      if (L[5] - L[4] < 2 || L[7] - L[6] < 2) continue; // el recuadro llega al borde del cuadro: no hay franja de afuera
      var ti = 0, ni = 0, cl = 0, no = 0;
      for (y = L[2]; y < L[3]; y++) for (x = L[0]; x < L[1]; x++) { if (g[y * w + x] < tintaHasta) ti++; ni++; }
      for (y = L[6]; y < L[7]; y++) for (x = L[4]; x < L[5]; x++) { if (g[y * w + x] > papelDesde) cl++; no++; }
      if (ni && no && ti / ni > 0.03 && ti / ni < 0.5 && cl / no > 0.6) desborda = true;
    }
    if (media < LUZ_MINIMA) return ['rojo', 'Falta luz'];
    if (clip / n > REFLEJO_MAXIMO) return ['rojo', 'Demasiado reflejo'];
    if (fracPapel < HOJA_MINIMA) return ['rojo', 'Ubique la hoja dentro del recuadro'];
    if (desborda) return ['ambar', 'Aléjese un poco'];
    if (anchoHoja < rw * LLENADO_MINIMO && altoHoja < rh * LLENADO_MINIMO) return ['ambar', 'Acerque la hoja hasta llenar el recuadro'];
    if (nitProm < NITIDEZ_VIVO) return ['ambar', 'Enfocando…'];
    return ['verde', 'Listo. Toque para capturar'];
  }

  function destello() {
    var f = $('cam-flash');
    f.className = 'cam-flash ya';
    setTimeout(function () { f.className = 'cam-flash'; }, 60);
  }

  function capturar() {
    if (!cam.activa || cam.preparando || ocupado) return;
    var r = recuadroEnVideo();
    if (!r || cam.video.readyState < 2) { semaforo(cam.clase, 'La cámara todavía no está lista'); return; }
    // El botón siempre funciona; en rojo sólo se pide confirmar.
    if (cam.clase === 'rojo' && !window.confirm('La imagen no se ve bien: ' + $('cam-msj').textContent + '. ¿Capturar igual?')) return;
    var m = MARGEN_RECORTE;
    var x0 = Math.max(0, r.x - r.w * m), y0 = Math.max(0, r.y - r.h * m);
    var x1 = Math.min(r.vw, r.x + r.w * (1 + m)), y1 = Math.min(r.vh, r.y + r.h * (1 + m));
    var sw = x1 - x0, sh = y1 - y0;
    if (sw < 16 || sh < 16) return;
    var esc = Math.min(1, LADO_CAPTURA / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * esc));
    c.height = Math.max(1, Math.round(sh * esc));
    cam.preparando = true;
    $('cam-captura').disabled = true;
    destello();
    semaforo(cam.clase, 'Preparando la foto…');
    var fallo = function () {
      c.width = c.height = 0;
      cam.preparando = false;
      $('cam-captura').disabled = false;
      cam.estado = '';
      semaforo('rojo', 'No se pudo capturar. Intente de nuevo.');
    };
    try {
      var cx = c.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(cam.video, x0, y0, sw, sh, 0, 0, c.width, c.height);
    } catch (e) { fallo(); return; }
    aBlob(c, function (blob) {
      c.width = c.height = 0;
      if (!blob) { fallo(); return; }
      procesar([blob], true);
    }, CALIDAD_CAPTURA);
  }

  /** Terminó de procesarse una captura: se sigue en vivo con la hoja siguiente. */
  function trasCaptura() {
    cam.preparando = false;
    $('cam-captura').disabled = false;
    if (cam.activa) {
      if (previas + hojas.length >= MAX_HOJAS) { cerrarCamara(); return; }
      camContador();
      // El aviso de "hoja lista" se sostiene 900 ms antes de que vuelva el semáforo.
      cam.estado = ''; cam.votos = []; cam.nitidez = []; cam.cambio = Date.now();
      var total = previas + hojas.length;
      semaforo('', 'Hoja ' + total + ' lista. Encuadre la hoja ' + (total + 1));
      return;
    }
    // Se había cerrado para preguntar por una foto dudosa: contestada, se vuelve a abrir.
    if (cam.volver) { cam.volver = false; abrirCamara(); }
  }

  function linterna() {
    if (!cam.pista || !cam.pista.applyConstraints) return;
    var querer = !cam.luz;
    cam.pista.applyConstraints({ advanced: [{ torch: querer }] }).then(function () {
      cam.luz = querer;
      $('cam-luz').textContent = querer ? 'Apagar linterna' : 'Linterna';
    }, function () { $('cam-luz').hidden = true; });
  }

  /* ---------- envío ---------- */

  var MSJ_RED = 'Se perdió la conexión con la PC. Verifique que el teléfono siga en la red Wi-Fi del local y toque Enviar de nuevo.';

  function falla(texto) {
    ocupado = false;
    mostrar('captura');
    aviso(texto, true);
    pintar();
  }

  function enviar() {
    if (ocupado || previas + hojas.length === 0) return;
    ocupado = true; aviso('');
    mostrar('enviando');
    progreso(0, 'Conectando con la PC…');
    // Antes de subir se pregunta cuántas hojas tiene ya la PC: si un envío
    // anterior se cortó justo después de llegar, esa hoja no se manda dos veces.
    pedir('GET', '/estado', null, function (st, r) {
      if (st === 404) { mostrar('vencido'); return; }
      if (st !== 200 || !r || !r.ok) { falla(MSJ_RED); return; }
      var enPc = r.factura && r.factura.estado === 'recibiendo' ? r.factura.hojas : 0;
      var llegaron = Math.max(0, enPc - previas);
      for (var i = 0; i < hojas.length; i++) hojas[i].enviada = i < llegaron;
      subir(0);
    });
  }

  function progreso(parte, texto) {
    $('env-texto').textContent = texto;
    $('env-barra').value = Math.round(parte * 100);
  }

  function subir(i, reintento) {
    while (i < hojas.length && hojas[i].enviada) i++;
    var n = hojas.length;
    if (i >= n) { cerrar(); return; }
    var texto = 'Enviando hoja ' + (i + 1) + ' de ' + n;
    progreso(i / n, texto);
    // «Usar igual»: la PC acepta la foto aunque la vea mal.
    pedir('POST', '/hoja' + (hojas[i].forzar ? '?forzar=1' : ''), hojas[i].blob, function (st, r) {
      if (st === 200 && r && r.ok) { hojas[i].enviada = true; subir(i + 1); return; }
      if (st === 404) { mostrar('vencido'); return; }
      // La PC todavía está leyendo la hoja anterior: se espera y se reintenta.
      if (st === 429 && (reintento || 0) < 8) { setTimeout(function () { subir(i, (reintento || 0) + 1); }, 2000); return; }
      if (st === 422 && r && r.code === 'FOTO') {
        // La PC leyó la hoja y no sirve: no la agregó. Se repite o se manda igual.
        ocupado = false;
        mostrar('captura');
        aviso('');
        preguntar('Hoja ' + (previas + i + 1) + ': ' + (r.message || 'La foto no se puede leer bien.'),
          function () { hojas.splice(i, 1); lugar = i; pintar(); },
          function () { hojas[i].forzar = true; enviar(); });
        return;
      }
      falla(st === 0 ? MSJ_RED : (r && r.message) || 'No se pudo enviar la hoja ' + (i + 1) + '. Intente de nuevo.');
    }, function (parte) { progreso((i + parte) / n, texto); });
  }

  function cerrar() {
    progreso(1, 'Terminando el envío…');
    pedir('POST', '/cerrar', null, function (st, r) {
      if (st === 200 && r && r.ok) {
        ocupado = false; hojas = []; previas = 0; lugar = null;
        verEstado();
        return;
      }
      if (st === 404) { mostrar('vencido'); return; }
      falla(st === 0 ? MSJ_RED : (r && r.message) || 'No se pudo terminar el envío. Intente de nuevo.');
    });
  }

  /* ---------- estado de la lectura ---------- */

  function estado(titulo, detalle, clase, parte) {
    var t = $('est-titulo');
    t.textContent = titulo;
    t.className = 'titulo' + (clase ? ' ' + clase : '');
    $('est-detalle').textContent = detalle || '';
    var b = $('est-barra');
    b.hidden = parte === null;
    if (parte !== null) b.value = Math.round(parte * 100);
  }

  /** Devuelve true cuando ya no hay nada más que esperar. */
  function pintarEstado(f) {
    if (!f) { estado('Factura enviada', 'Puede revisarla en la PC.', 'bien', null); return true; }
    var e = f.estado, n = f.hojas || 0, leidas = f.hojasLeidas || 0;
    if (e === 'lista' || e === 'cargada') {
      estado('Lista para revisar en la PC', plural(n) + (n === 1 ? ' leída.' : ' leídas.'), 'bien', null);
      return true;
    }
    if (e === 'error') {
      estado('No se pudo leer la factura',
        (f.error ? f.error + ' ' : '') + 'Las fotos quedaron guardadas: puede volver a leerla desde la PC.', 'mal', null);
      return true;
    }
    if (e === 'descartada') { estado('La factura fue descartada en la PC', '', '', null); return true; }
    if (e === 'leyendo') {
      // Con «Mejorar lectura» cada hoja puede tardar minutos: se avisa.
      estado('Leyendo hoja ' + Math.min(leidas + 1, Math.max(n, 1)) + ' de ' + Math.max(n, 1) +
        (f.lento ? ', puede demorar unos minutos' : ''),
        'Puede dejar el teléfono: la lectura sigue en la PC.', '', n ? leidas / n : 0);
      return false;
    }
    estado('En espera', 'La PC va a leer ' + plural(n) + ' en cuanto termine con lo anterior.', '', 0);
    return false;
  }

  function sondear() {
    reloj = null;
    pedir('GET', '/estado', null, function (st, r) {
      if (vista !== 'estado') return;
      if (st === 404) {
        estado('Factura enviada', 'El enlace venció, pero la factura quedó en la PC.', 'bien', null);
        $('btn-otra').hidden = true;
        return;
      }
      if (st === 200 && r && r.ok) { if (pintarEstado(r.factura)) return; }
      else $('est-detalle').textContent = 'Sin conexión con la PC. Reintentando…';
      reloj = setTimeout(sondear, SONDEO_MS);
    });
  }

  function verEstado() {
    mostrar('estado');
    estado('Factura enviada', 'Consultando el estado…', '', 0);
    sondear();
  }

  /* ---------- arranque ---------- */

  $('camara').onchange = alElegir;
  $('galeria').onchange = alElegir;
  $('btn-camara').onclick = abrirCamara;
  $('cam-captura').onclick = capturar;
  $('cam-cerrar').onclick = function () { cerrarCamara(); };
  $('cam-luz').onclick = linterna;
  window.addEventListener('resize', ubicarGuia);
  window.addEventListener('orientationchange', function () { setTimeout(ubicarGuia, 300); });
  // Al pasar a otra aplicación el sistema corta la cámara: se cierra prolija y se vuelve a abrir a mano.
  document.addEventListener('visibilitychange', function () { if (document.hidden && cam.activa) cerrarCamara(); });
  $('btn-enviar').onclick = enviar;
  $('btn-repetir').onclick = function () { responder(false); };
  $('btn-usar').onclick = function () { responder(true); };
  $('btn-otra').onclick = function () { hojas = []; previas = 0; lugar = null; aviso(''); mostrar('captura'); pintar(); };
  $('btn-quitar-previa').onclick = function () {
    if (ocupado) return;
    ocupado = true; pintar();
    pedir('POST', '/quitar', null, function (st, r) {
      ocupado = false;
      if (st === 404) { mostrar('vencido'); return; }
      if (st === 200 && r && r.ok) previas = r.hojas;
      else aviso((r && r.message) || 'No se pudo quitar la hoja.', true);
      pintar();
    });
  };

  pintar();
  // Si la página se recargó a mitad de camino, se retoma donde estaba.
  pedir('GET', '/estado', null, function (st, r) {
    if (st === 404) { mostrar('vencido'); return; }
    if (st !== 200 || !r || !r.ok || !r.factura || vista !== 'captura') return;
    puedeQuitar = !!r.puedeQuitar;
    var e = r.factura.estado;
    if (e === 'recibiendo') { if (!ocupado && !hojas.length) { previas = r.factura.hojas || 0; pintar(); } }
    else if (e === 'en_cola' || e === 'leyendo') { if (!hojas.length) verEstado(); }
  });
})();
`;

const CABEZA = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light dark">`;

/** La página de captura. No lleva nada propio del comercio ni del token. */
export function paginaTelefono(): string {
  return `<!doctype html>
<html lang="es">
<head>
${CABEZA}
<title>Factura de compra — StockFlow</title>
<style>${ESTILOS}</style>
</head>
<body>
<header>
  <h1>Factura de compra</h1>
  <p>Saque una foto de cada hoja, en orden, y envíe la factura.</p>
</header>
<main>
  <section id="v-captura">
    <div id="aviso" class="aviso" role="alert" hidden></div>
    <div id="dudosa" class="aviso error" role="alert" hidden>
      <div id="dudosa-texto"></div>
      <button type="button" id="btn-repetir" class="chico">Repetir la foto</button>
      <button type="button" id="btn-usar" class="chico">Usar igual</button>
    </div>
    <div id="previas" class="aviso" hidden>
      <div id="previas-texto"></div>
      <button type="button" id="btn-quitar-previa" class="chico" hidden>Quitar la última enviada</button>
    </div>
    <ol id="lista" class="hojas"></ol>
    <p id="vacio" class="vacio">Todavía no hay hojas.<br>Apoye la factura sobre una superficie plana y con buena luz.</p>
  </section>
  <section id="v-enviando" class="centro" aria-live="polite" hidden>
    <p class="titulo" id="env-texto">Enviando…</p>
    <progress id="env-barra" max="100" value="0"></progress>
    <p class="detalle">No cierre esta página hasta que termine.</p>
  </section>
  <section id="v-estado" class="centro" aria-live="polite" hidden>
    <p class="titulo" id="est-titulo"></p>
    <p class="detalle" id="est-detalle"></p>
    <progress id="est-barra" max="100" value="0"></progress>
    <p><button type="button" id="btn-otra" class="btn secundario">Cargar otra factura</button></p>
  </section>
  <section id="v-vencido" class="centro" hidden>
    <p class="titulo">El enlace venció</p>
    <p class="detalle">En la PC, toque «Vincular teléfono» y escanee el código nuevo.</p>
  </section>
</main>
<div id="barra" class="barra">
  <button type="button" id="btn-camara" class="btn primario" hidden>Abrir la cámara</button>
  <label id="btn-foto" class="btn primario" for="camara" role="button">Sacar foto de la hoja</label>
  <input id="camara" class="oculto" type="file" accept="image/*" capture="environment">
  <button type="button" id="btn-enviar" class="btn primario" disabled hidden>Enviar factura</button>
  <label id="lbl-galeria" class="enlace" for="galeria">Elegir fotos ya guardadas</label>
  <input id="galeria" class="oculto" type="file" accept="image/*" multiple>
</div>
<div id="cam" class="cam" role="dialog" aria-label="Cámara" hidden>
  <video id="cam-video" playsinline webkit-playsinline muted autoplay></video>
  <div id="cam-guia" class="cam-guia" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
  <div id="cam-flash" class="cam-flash" aria-hidden="true"></div>
  <div class="cam-arriba">
    <p class="cam-ayuda">Encuadre la hoja completa dentro del recuadro</p>
    <p id="cam-msj" class="cam-msj" role="status" aria-live="polite"></p>
  </div>
  <div class="cam-abajo">
    <p id="cam-contador" class="cam-contador"><img id="cam-mini" alt="" hidden><span id="cam-contador-texto"></span></p>
    <div class="cam-fila">
      <div class="cam-lado"><button type="button" id="cam-cerrar" class="cam-btn">Cerrar</button></div>
      <button type="button" id="cam-captura" class="cam-captura" aria-label="Capturar la hoja"></button>
      <div class="cam-lado der"><button type="button" id="cam-luz" class="cam-btn" hidden>Linterna</button></div>
    </div>
  </div>
</div>
<noscript><p style="padding:16px">Esta página necesita JavaScript activado.</p></noscript>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Lo que ve quien llega con un enlace vencido, inválido o con la función apagada. */
export function paginaVencido(): string {
  return `<!doctype html>
<html lang="es">
<head>
${CABEZA}
<title>El enlace venció — StockFlow</title>
<style>${ESTILOS}</style>
</head>
<body>
<main>
  <section class="centro">
    <p class="titulo">El enlace venció</p>
    <p class="detalle">En la PC, toque «Vincular teléfono» y escanee el código nuevo.</p>
  </section>
</main>
</body>
</html>
`;
}
