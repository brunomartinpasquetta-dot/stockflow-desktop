/* StockFlow landing — tracking (generado por build_landing.py; completar IDs ahí). */
var SF_CONFIG = {
  META_PIXEL_ID: "",
  GA4_MEASUREMENT_ID: "",
  WA_NUMBER: "543425847340",
  WA_TEXT: "Hola! Quiero probar StockFlow en mi comercio."
};
(function () {
  'use strict';
  /* ── Stubs SIEMPRE presentes (encolan llamadas); la carga remota sólo con ID. */
  if (!window.fbq) {
    var n = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    window.fbq = n; window._fbq = n;
  }
  window.dataLayer = window.dataLayer || [];
  if (!window.gtag) { window.gtag = function () { window.dataLayer.push(arguments); }; }
  if (SF_CONFIG.META_PIXEL_ID) {
    var fs = document.createElement('script'); fs.async = true;
    fs.src = 'https://connect.facebook.net/en_US/fbevents.js';
    document.head.appendChild(fs);
    window.fbq('init', SF_CONFIG.META_PIXEL_ID);
    window.fbq('track', 'PageView');
  }
  if (SF_CONFIG.GA4_MEASUREMENT_ID) {
    var gs = document.createElement('script'); gs.async = true;
    gs.src = 'https://www.googletagmanager.com/gtag/js?id=' + SF_CONFIG.GA4_MEASUREMENT_ID;
    document.head.appendChild(gs);
    window.gtag('js', new Date());
    window.gtag('config', SF_CONFIG.GA4_MEASUREMENT_ID);
  }

  /* ── localStorage con guardas: en modo privado no debe romper nada. */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin storage */ } }

  /* ── Atribución: se captura UNA vez y no se pisa con visitas directas. */
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  /* Parser manual del query string: URLSearchParams no existe en Chrome viejo
     (el público real de la landing incluye PCs de comercio antiguas) y un
     ReferenceError acá mataría el módulo entero. */
  function leerQuery() {
    var out = {};
    var q = (window.location.search || '').replace(/^\?/, '');
    if (!q) return out;
    var partes = q.split('&');
    for (var i = 0; i < partes.length; i++) {
      var kv = partes[i].split('=');
      if (!kv[0]) continue;
      try { out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); }
      catch (e) { /* componente malformado: se ignora */ }
    }
    return out;
  }
  function capturarAtribucion() {
    var qs = leerQuery();
    var attr = {}; var hay = false;
    for (var i = 0; i < ATTR_KEYS.length; i++) {
      var v = qs[ATTR_KEYS[i]];
      if (v) { attr[ATTR_KEYS[i]] = v; hay = true; }
    }
    if (hay && !lsGet('sf_attr')) {
      attr.ts = Date.now();
      lsSet('sf_attr', JSON.stringify(attr));
    }
  }

  /* ── Ref de sesión: 6 caracteres A-Z0-9, estable entre recargas. */
  function obtenerRef() {
    var r = lsGet('sf_ref');
    if (r && /^[A-Z0-9]{6}$/.test(r)) return r;
    var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; r = '';
    for (var i = 0; i < 6; i++) r += abc.charAt(Math.floor(Math.random() * abc.length));
    lsSet('sf_ref', r);
    return r;
  }
  function mapearRef() {
    var attr = lsGet('sf_attr');
    if (!attr) return;
    var mapa = {};
    try { mapa = JSON.parse(lsGet('sf_ref_map') || '{}'); } catch (e) { mapa = {}; }
    /* Un 'sf_attr' corrupto no puede dejar al visitante sin tracking para
       siempre: se descarta y listo. */
    try { mapa[obtenerRef()] = JSON.parse(attr); } catch (e) { return; }
    lsSet('sf_ref_map', JSON.stringify(mapa));
  }
  try { capturarAtribucion(); } catch (e) { /* jamás frena el resto del módulo */ }
  try { mapearRef(); } catch (e) { /* ídem */ }

  function evento(fbTipo, fbNombre, fbDatos, gaNombre, gaDatos) {
    try { window.fbq(fbTipo, fbNombre, fbDatos); } catch (e) { /* nunca frena el clic */ }
    try { window.gtag('event', gaNombre, gaDatos); } catch (e) { /* ídem */ }
  }

  /* ── Delegación por data-sf-cta. SIN preventDefault: la navegación sigue. */
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-sf-cta]') : null;
    if (!a) return;
    var tipo = a.getAttribute('data-sf-cta');
    var ref = obtenerRef();
    /* Beacon first-party al access.log de nginx (conteo histórico por /ev).
       Antes vivía en un script aparte; acá queda el módulo único. */
    try {
      if (navigator.sendBeacon) {
        if (tipo === 'whatsapp') {
          var sec = a.closest ? a.closest('section') : null;
          navigator.sendBeacon('/ev?e=wa&s=' + encodeURIComponent((sec && sec.id) || 'top') + '&r=' + ref);
        } else {
          navigator.sendBeacon('/ev?e=dl&f=' + encodeURIComponent((a.getAttribute('href') || '').split('/').pop()) + '&r=' + ref);
        }
      }
    } catch (e) { /* el beacon jamás frena el clic */ }
    if (tipo === 'whatsapp') {
      /* El href se arma EN EL CLIC, con el ref: es lo único que ata la
         conversación de WhatsApp al anuncio. Mutar href acá llega a tiempo:
         el navegador lo lee después de los handlers. */
      a.href = 'https://wa.me/' + SF_CONFIG.WA_NUMBER + '?text=' +
        encodeURIComponent(SF_CONFIG.WA_TEXT + ' (ref: ' + ref + ')');
      evento('track', 'Lead', { content_name: 'whatsapp_cta', ref: ref },
        'generate_lead', { method: 'whatsapp', ref: ref });
    } else if (tipo === 'download-win') {
      evento('trackCustom', 'DescargaWindows', { ref: ref },
        'file_download', { file_name: 'StockFlow-Setup.exe', ref: ref });
    } else if (tipo === 'download-mac') {
      evento('trackCustom', 'DescargaMac', { ref: ref },
        'file_download', { file_name: 'StockFlow.dmg', ref: ref });
    }
  }, true);

  /* ── Vio el precio: una sola vez por sesión. */
  function vigilarPrecio() {
    var el = document.getElementById('precio');
    if (!el || !('IntersectionObserver' in window)) return;
    var visto = false;
    try { visto = sessionStorage.getItem('sf_vp') === '1'; } catch (e) { /* sin storage */ }
    if (visto) return;
    var io = new IntersectionObserver(function (entradas) {
      for (var i = 0; i < entradas.length; i++) {
        if (entradas[i].isIntersecting) {
          try { sessionStorage.setItem('sf_vp', '1'); } catch (e) { /* sin storage */ }
          evento('trackCustom', 'VioPrecio', {}, 'view_pricing', {});
          io.disconnect();
          return;
        }
      }
    }, { threshold: 0.5 });
    io.observe(el);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', vigilarPrecio);
  } else {
    vigilarPrecio();
  }
})();
