#!/usr/bin/env python3
# Landing StockFlow v3 — modelo StockFacil, colores del sistema (azul). Self-contained.
import base64, os
from io import BytesIO
from PIL import Image
W = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(W, 'assets')
os.makedirs(ASSETS, exist_ok=True)
def b64(p): return base64.b64encode(open(p,'rb').read()).decode()
IMG_WH = {}  # ruta emitida -> (w,h) reales, para width/height en los <img> (sin CLS)
def img(n, maxw=1400, q=80, lossless=False):
    """Optimiza la imagen (resize + WebP) y la escribe como ARCHIVO en assets/
    en vez de embeberla en base64: el HTML queda liviano (carga instantánea en
    celular) y el navegador cachea/lazy-loadea las imágenes de verdad.
    Deploy: subir index3.html (como index.html) + assets/ + js/ + og.jpg + favicon.png al docroot."""
    im = Image.open(os.path.join(W, 'img', n))
    if im.width > maxw:
        im = im.resize((maxw, round(im.height * maxw / im.width)), Image.LANCZOS)
    im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB')
    buf = BytesIO()
    if lossless:
        im.save(buf, 'WEBP', lossless=True, method=6)
    else:
        im.save(buf, 'WEBP', quality=q, method=6)
    slug = os.path.splitext(n)[0].replace('.', '-')
    fn = f"{slug}-{maxw}{'ll' if lossless else f'q{q}'}.webp"
    open(os.path.join(ASSETS, fn), 'wb').write(buf.getvalue())
    IMG_WH[f"assets/{fn}"] = (im.width, im.height)
    return f"assets/{fn}"
def wh(src):
    w, h = IMG_WH[src]
    return f"width='{w}' height='{h}'"
def font(f): return base64.b64encode(open(os.path.join(W,'fonts',f),'rb').read()).decode()
PDV=img('pdv.png'); ART=img('articulos.png', maxw=1200, q=67); CTA_=img('ctacte.png'); PRES=img('presupuesto.png'); EST=img('estadisticas.png')
# caja: la captura nueva es más densa; q=72 la deja <55 KB con los montos legibles
CAJA2=img('caja-abierta-resumen.png', q=72); CONTA=img('contabilidad-resumen.png'); COMPRAS=img('compras-principal.png'); CLIENTES=img('clientes-listado.png')
# El cubo es el LCP del hero: mitad de tamaño visual (CSS) + mitad de píxeles (maxw=400,
# alcanza para 180px CSS a 2x DPR) + lossy q90 para quedar ~60 KB en vez de 172 KB.
LOGO=img('logo-full.png', maxw=760, lossless=True); CUBE=img('cube-hd.png', maxw=400, q=90)
# Logos de integraciones para el hero, en colores originales y fondo transparente
# (oficiales de Wikimedia Commons; van debajo del botón de descarga).
L_ARCA=img('logo-arca.png', maxw=440, q=85); L_BNA=img('logo-bna.png', maxw=130, q=85); L_UALA=img('logo-uala.png', maxw=150, q=85); L_MP=img('logo-mp.png', maxw=284, q=85)
# ────────────────────────────────────────────────────────────────────────────
# TRACKING — completar ACÁ y regenerar (python3 build_landing.py).
# Estos valores se inyectan en js/tracking.js y en el <noscript> del píxel.
# NO inventar IDs: vacíos = los snippets quedan inertes (stubs sin red).
META_PIXEL_ID = "1363051382693261"  # ← ID numérico del Píxel de Meta (Administrador de eventos)
GA4_MEASUREMENT_ID = ""   # ← "G-XXXXXXXXXX" de la propiedad GA4
WA_NUM = "543425847340"   # único lugar donde vive el número de WhatsApp
WA_TEXT = "Hola! Quiero probar StockFlow en mi comercio."
# ────────────────────────────────────────────────────────────────────────────
import urllib.parse as _up
WA = f"https://wa.me/{WA_NUM}?text={_up.quote(WA_TEXT)}"
CUBE_HTML=("<div class='cube3d' aria-hidden='true'><div class='c-halo'></div>"
 "<div class='c-scene'><div class='c-cube'>"
 + "".join(f"<div class='c-face {c}'><img class='c-lg' src='{CUBE}' alt=''/></div>" for c in ['cf-fr','cf-bk','cf-ri','cf-le','cf-tp','cf-bo'])
 + "</div></div><div class='c-sh'></div></div>")

# (archivo fuente en img/, título visible en la barra de ventana, alt descriptivo)
GAL=[('panel-principal.png','Pantalla principal','Pantalla principal de StockFlow con todos los módulos del sistema'),
 ('pdv.png','Ventas — Punto de venta','Punto de venta de StockFlow cobrando artículos de ferretería'),
 ('articulos.png','Artículos y precios','Listado de artículos de ferretería con stock, familias y tres listas de precios'),
 ('ctacte.png','Cuentas corrientes','Cuentas corrientes con los saldos de cada cliente al día'),
 ('presupuestos-crear.png','Presupuestos','Pantalla de presupuestos de StockFlow listos para convertir en venta'),
 ('estadisticas.png','Estadísticas','Estadísticas de ventas con margen bruto y ticket promedio'),
 ('caja-abierta-resumen.png','Caja diaria','Caja diaria con el efectivo esperado y la comisión de tarjeta descontada'),
 ('contabilidad-resumen.png','Contabilidad y Libro IVA','Resumen contable y Libro IVA generados por StockFlow'),
 ('compras-principal.png','Compras','Pantalla de compras con órdenes a proveedores'),
 ('clientes-listado.png','Clientes','Listado de clientes del comercio en StockFlow')]
GAL_I=[(img(f),c,a) for f,c,a in GAL]
# Sin gbar en el carrusel (pedido de Bruno, sep-2026): las capturas ya traen la
# barra de la ventana de la app y la barrita del carrusel la duplicaba.
GAL_SLIDES="".join(f"<figure class='cf-card' data-i='{k}'><div class='cwin'><img loading='lazy' src='{s}' {wh(s)} alt='{a}'/></div></figure>" for k,(s,c,a) in enumerate(GAL_I))
GAL_DOTS="".join(f"<button class='gdot' data-i='{k}' aria-label='Pantalla {k+1}'></button>" for k in range(len(GAL_I)))
# Vista previa de actualización de precios (actual / nuevo / diferencia): va en el
# showcase de precios; el listado de artículos queda solo en el carrusel.
# Tablas de texto densas: 1200px (sobra para ~600px CSS a 2x) + q agresiva = <55 KB.
PRECIOS=img('precios-preview.png', maxw=1200, q=64)

def face(w): return (f"@font-face{{font-family:'Jak';font-style:normal;font-weight:{w};font-display:swap;"
                     f"src:url(data:font/woff2;base64,{font(f'jakarta-{w}.woff2')}) format('woff2');}}")
def face2(fam,fn,w): return (f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;"
                     f"src:url(data:font/woff2;base64,{font(fn)}) format('woff2');}}")
# Tipografía ÚNICA de la página = la del logo StockFlow: Plus Jakarta Sans.
# Solo DOS caras embebidas (400 y 700): las 5 caras eran el 57% del HTML crítico.
# El matching CSS resuelve el resto sin tocar cada declaración: 500→400, 600→700, 800→700.
FONTS="".join(face(w) for w in (400,700))

# iconos line (24) currentColor
def sic(p): return f"<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'>{p}</svg>"
G={
 'box':sic("<path d='M21 8 12 3 3 8v8l9 5 9-5V8Z'/><path d='M3 8l9 5 9-5M12 13v8'/>"),
 'truck':sic("<path d='M3 6h11v9H3zM14 9h4l3 3v3h-7z'/><circle cx='7' cy='18' r='1.6'/><circle cx='18' cy='18' r='1.6'/>"),
 'users':sic("<circle cx='9' cy='8' r='3'/><path d='M3 20a6 6 0 0 1 12 0'/><path d='M16 5.5a3 3 0 0 1 0 5.8M21 20a6 6 0 0 0-4-5.6'/>"),
 'shield':sic("<path d='M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z'/><path d='M9 12l2 2 4-4'/>"),
 'cart':sic("<circle cx='9' cy='20' r='1.5'/><circle cx='18' cy='20' r='1.5'/><path d='M2 3h3l2.5 12.5A2 2 0 0 0 9.5 17H18a2 2 0 0 0 2-1.6L21.5 8H6'/>"),
 'ledger':sic("<rect x='4' y='4' width='16' height='16' rx='2'/><path d='M8 4v16M8 9h4M8 13h4'/>"),
 'cash':sic("<rect x='2.5' y='6' width='19' height='12' rx='2'/><circle cx='12' cy='12' r='2.6'/><path d='M6 9v6M18 9v6'/>"),
 'chart':sic("<path d='M4 20V4M4 20h16'/><path d='M8 16v-4M12 16V8M16 16v-6'/>"),
 'arrows':sic("<path d='M7 7h10l-3-3M17 17H7l3 3'/>"),
 'lock':sic("<rect x='5' y='11' width='14' height='9' rx='2'/><path d='M8 11V8a4 4 0 0 1 8 0v3'/>"),
 'barcode':sic("<path d='M4 5v14M7 5v14M10 5v10M13 5v14M16 5v10M20 5v14'/>"),
 'tag':sic("<path d='M4 12.5 12.5 4H20v7.5L11.5 20 4 12.5Z'/><circle cx='16' cy='8' r='1.2'/>"),
 'image':sic("<rect x='3' y='4' width='18' height='16' rx='2'/><circle cx='9' cy='10' r='2'/><path d='M4 18l5-4 4 3 3-2 4 3'/>"),
 'list':sic("<path d='M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01'/>"),
 'alert':sic("<path d='M12 4 2.5 20h19L12 4Z'/><path d='M12 10v4M12 17h.01'/>"),
 'excel':sic("<rect x='4' y='3' width='16' height='18' rx='2'/><path d='M9 8l6 8M15 8l-6 8'/>"),
 'refresh':sic("<path d='M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4'/><path d='M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4'/>"),
 'save':sic("<path d='M5 4h11l3 3v13H5V4Z'/><path d='M8 4v5h7M8 20v-6h8v6'/>"),
 'receipt':sic("<path d='M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21V3Z'/><path d='M9 8h6M9 12h6'/>"),
 'calc':sic("<rect x='5' y='3' width='14' height='18' rx='2'/><path d='M8 7h8M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h4'/>"),
 'qr':sic("<rect x='4' y='4' width='7' height='7' rx='1'/><rect x='13' y='4' width='7' height='7' rx='1'/><rect x='4' y='13' width='7' height='7' rx='1'/><path d='M13 13h3v3M20 13v.01M16 20h4v-4'/>"),
 'a4':sic("<path d='M6.5 3.5h7L18 8v12.5H6.5V3.5Z'/><path d='M13.5 3.5V8H18M9 12h6M9 15h6'/>"),
 'wifi':sic("<path d='M5 12.5a10 10 0 0 1 14 0M8 16a5 5 0 0 1 8 0'/><circle cx='12' cy='19' r='1'/>"),
 'bolt':sic("<path d='M13 3 4 14h6l-1 7 9-11h-6l1-7Z'/>"),
 'lu_wrench':sic("<path d='M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'/>"),
 'lu_forklift':sic("<path d='M12 12H5a2 2 0 0 0-2 2v5'/><circle cx='13' cy='19' r='2'/><circle cx='5' cy='19' r='2'/><path d='M8 19h3m5-17v17h6M6 12V7c0-1.1.9-2 2-2h3l5 5'/>"),
 'lu_store':sic("<path d='m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7'/><path d='M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8'/><path d='M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4'/><path d='M2 7h20'/><path d='M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7'/>"),
 'lu_boxes':sic("<path d='M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z'/><path d='m7 16.5-4.74-2.85'/><path d='m7 16.5 5-3'/><path d='M7 16.5v5.17'/><path d='M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z'/><path d='m17 16.5-5-3'/><path d='m17 16.5 4.74-2.85'/><path d='M17 16.5v5.17'/><path d='M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z'/><path d='M12 8 7.26 5.15'/><path d='m12 8 4.74-2.85'/><path d='M12 13.5V8'/>"),
 'lu_gear':sic("<path d='M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'/><circle cx='12' cy='12' r='3'/>"),
 'lu_truck':sic("<path d='M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2'/><path d='M15 18H9'/><path d='M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14'/><circle cx='7' cy='18' r='2'/><circle cx='17' cy='18' r='2'/>"),
 'lu_shirt':sic("<path d='M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z'/>"),
 'headset':sic("<path d='M4 13v-1a8 8 0 0 1 16 0v1'/><rect x='3' y='13' width='3.5' height='6' rx='1.4'/><rect x='17.5' y='13' width='3.5' height='6' rx='1.4'/><path d='M19 19a3 3 0 0 1-3 3h-3'/>"),
}
WA_SVG="<svg class='wai' viewBox='0 0 24 24' fill='currentColor'><path d='M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2Zm5.8 14.1c-.2.7-1.4 1.3-2 1.4-.5.1-1.2.1-1.9-.1-.4-.1-1-.3-1.7-.6-3-1.3-4.9-4.3-5.1-4.5-.1-.2-1.2-1.5-1.2-2.9s.7-2 1-2.3c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.1.1.3 0 .5l-.4.5-.3.3c-.2.2-.4.4-.2.7.2.4.9 1.4 1.9 2.3 1.3 1.1 2.3 1.5 2.7 1.6.3.1.5.1.7-.1l.9-1.1c.2-.2.4-.2.6-.1l2 .9c.2.1.4.2.4.3.1.2.1.6-.1 1.1Z'/></svg>"

def money(v): return f"<span class='mny'>$&#8202;{v}</span>"

CSS=f"""
{FONTS}
:root{{
 --blue:#2b6fd6; --blue-d:#1f57b5; --blue-t:#eaf1fd; --blue-t2:#f2f7fe;
 --ink:#14213d; --body:#586074; --paper:#ffffff; --soft:#eff4fb; --line:#e4eaf3;
 --green:#16a34a; --wa:#25d366; --coral:#f97316; --indigo:#4f46e5;
 --jak:'Jak',system-ui,sans-serif; --disp:'Jak',system-ui,sans-serif; --wrap:1280px;
}}
*{{box-sizing:border-box;}}
html{{scroll-behavior:smooth;}}
body{{margin:0;font-family:var(--jak);color:var(--body);background:var(--paper);font-size:17px;line-height:1.6;
 -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}}
/* height:auto es clave: los <img> llevan width/height (anti-CLS) y el CSS los
   escala por width; sin esto la altura del atributo queda fija y deforma. */
img{{max-width:100%;height:auto;display:block;}} a{{color:inherit;text-decoration:none;}}
h1,h2,h3,h4{{color:var(--ink);font-family:var(--disp);font-weight:800;line-height:1.1;letter-spacing:-.02em;margin:0;text-wrap:balance;}}
.fitem h4,.why h3,.show li,.faq summary{{font-family:var(--disp);font-weight:700;}}
p{{margin:0;}}
.wrap{{max-width:var(--wrap);margin:0 auto;padding:0 24px;}}
.mny{{font-variant-numeric:tabular-nums;white-space:nowrap;}}
.eyebrow{{color:var(--blue);font-weight:700;font-size:13px;letter-spacing:.14em;text-transform:uppercase;}}
.btn{{display:inline-flex;align-items:center;gap:9px;font-weight:700;font-size:16px;padding:14px 26px;border-radius:12px;
 border:2px solid transparent;cursor:pointer;transition:transform .15s,box-shadow .15s,background .15s;}}
.btn:focus-visible{{outline:3px solid var(--blue);outline-offset:2px;}}
.btn-blue{{background:var(--blue);color:#fff;box-shadow:0 8px 20px rgba(43,111,214,.28);}}
.btn-blue:hover{{background:var(--blue-d);transform:translateY(-2px);}}
.btn-ghost{{background:#fff;color:var(--ink);border-color:var(--line);}}
.btn-ghost:hover{{border-color:var(--blue);color:var(--blue);}}
.btn-wa{{background:var(--wa);color:#053d1c;box-shadow:0 8px 20px rgba(37,211,102,.28);}}
.btn-wa:hover{{transform:translateY(-2px);}}
.wai{{width:19px;height:19px;}}

/* NAV */
/* Fondo SÓLIDO: el contenido no debe traslucirse debajo de la nav al scrollear. */
.nav{{position:sticky;top:0;z-index:300;background:#fff;border-bottom:1px solid var(--line);}}
.nav .wrap{{display:flex;align-items:center;justify-content:space-between;height:70px;gap:20px;}}
.brand-img{{height:60px;width:auto;display:block;transform:translateX(-2cm);}}
.foot-logo{{height:26px;width:auto;filter:brightness(0) invert(1);opacity:.94;}}
.nlinks{{display:flex;gap:26px;align-items:center;}}
.nlinks a{{font-weight:600;font-size:15px;color:var(--body);}} .nlinks a:hover{{color:var(--blue);}}
.nav .cta{{display:flex;gap:14px;align-items:center;}}
/* Solo texto: el CTA de la nav es el botón VERDE; este link acompaña, -1pt. */
.nav-txt{{font-weight:600;font-size:14px;color:var(--body);}} .nav-txt:hover{{color:var(--blue);}}
/* WhatsApp de la nav reducido a ícono: el CTA verde protagonista es la mbar inferior. */
.nav-wa{{padding:11px 13px;}} .nav-wa .wai{{width:21px;height:21px;}}
@media(max-width:960px){{.nlinks{{display:none;}} .nav .cta .nav-txt{{display:none;}} .brand-img{{transform:translateX(0);height:46px;}}}}

/* HERO */
.hero{{background:radial-gradient(120% 120% at 85% 0%,var(--blue-t) 0%,#fff 55%);overflow:hidden;}}
/* Grid ASIMÉTRICO (captura de referencia de Bruno, sep-2026): la sección del
   logo+texto ocupa ~1/3 y el carrusel ~2/3. La fila de abajo hereda el mismo
   reparto: botones angostos a la izquierda, características anchas a la derecha. */
.hero .wrap{{display:grid;grid-template-columns:1fr 2fr;gap:50px;align-items:start;padding:15px 24px 48px;}}
.hero .wrap>div{{min-width:0;}}
.badge{{display:inline-flex;align-items:center;gap:8px;background:var(--blue-t);color:var(--blue-d);font-weight:700;
 font-size:13.5px;padding:7px 14px;border-radius:999px;}}
.badge .st{{color:#f5a623;}}
h1.big{{font-size:clamp(36px,4.6vw,54px);margin:20px 0 0;}} h1.big .hl{{color:var(--blue);}}
.hero-title{{grid-column:1 / -1;font-family:var(--disp);font-weight:800;color:var(--ink);
 font-size:clamp(30px,4.2vw,54px);line-height:1.06;letter-spacing:-.025em;margin:0 0 2px;text-wrap:balance;}}
.hero-title b{{color:var(--blue);}}
/* Orden del hero: H1 → subtítulo → BOTONES → rubros (CTA arriba del pliegue). */
.hero-sub{{grid-column:1 / -1;font-size:clamp(17px,2vw,20px);color:var(--body);margin:10px 0 0;max-width:62ch;}}
.hero .hcta{{grid-column:1 / -1;}}
.hero .dl-alt{{grid-column:1 / -1;}}
/* Logo al 49% del ancho de su sección (dos reducciones del 30% pedidas por
   Bruno) para que logo+texto ocupen el mismo alto que las cards del carrusel. */
.hero-cube{{width:49%;max-width:206px;height:auto;display:block;margin:8px 0 10px;filter:drop-shadow(0 22px 38px rgba(43,111,214,.30));image-rendering:auto;}}
@media(max-width:960px){{.hero-cube{{max-width:147px;}}}}
/* El bloque del título va DEBAJO del carrusel: aire arriba para separarlo. */
.hero-title-low{{margin-top:0;}}
/* Sección del logo: logo y texto ALINEADOS en un mismo bloque (captura de
   referencia de Bruno): en desktop el texto se reparte hasta el final de la
   sección; en móvil (1 columna) queda compacto — ahí el reparto quedaba mal. */
.hero-left .trust{{margin-top:22px;font-size:15.5px;}}
.hero-left .hprice{{margin-top:14px;font-size:16px;}}
@media(min-width:961px){{
 .hero-left{{align-self:stretch;display:flex;flex-direction:column;}}
 .hero-left .trust{{margin-top:auto;padding-top:20px;}}
 .hero-left .hprice{{margin-top:auto;padding-top:16px;margin-bottom:6px;}}
}}
/* Bajo el título: botones apilados a la IZQUIERDA (ocupan el recuadro) y
   "Características principales" en PARALELO a la derecha. */
/* Botón centrado, en UNA línea, arrancando a la altura del título
   "Características principales". El margin negativo compensa el row-gap de
   50px del grid: separación título→fila de abajo reducida un 50% (38px). */
.hero-acciones{{display:flex;flex-direction:column;gap:16px;margin-top:-12px;}}
.hero-acciones .btn{{font-size:18px;padding:18px 32px;justify-content:center;width:auto;max-width:100%;white-space:nowrap;align-self:center;}}
.hero-acciones .dl-alt{{text-align:center;margin-top:2px;}}
.hero-feats{{margin-top:-12px;min-width:0;}}
.hero-feats h2{{font-family:var(--disp);font-size:25px;letter-spacing:-.015em;margin:0;text-align:center;}}
.hero-feats h2 b{{color:var(--blue);}}
.hero-feats .feats{{gap:2px 26px;margin-top:12px;}}
.hero-feats .feats li{{font-size:15.5px;padding:4.5px 0 4.5px 22px;}}
/* En pantallas anchas el bloque invade el margen derecho del wrap para que
   las columnas respiren y quiebren menos líneas (pedido de Bruno). */
@media(min-width:1360px){{.hero-feats{{margin-right:-56px;}}}}
/* Rubros en el hero: solo ícono + label, estilo Lucide (como el sistema) */
.rubros-hero{{grid-column:1 / -1;display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;
 gap:12px 14px;margin:7px 0 4px;position:relative;z-index:120;}}
.rh{{display:inline-flex;align-items:center;gap:9px;white-space:nowrap;
 font-family:var(--disp);font-weight:700;font-size:15px;color:var(--ink);transition:color .15s;}}
.rh:hover{{color:var(--blue);}}
.rh i{{color:var(--blue);display:inline-flex;flex:none;}}
.rh i svg{{width:31px;height:31px;stroke-width:2;}}
@media(max-width:900px){{.rubros-hero{{justify-content:flex-start;gap:12px 22px;margin-top:12px;}} .rh{{font-size:14.5px;}} .rh i svg{{width:28px;height:28px;}}}}
@media(max-width:480px){{.rubros-hero{{margin-top:6px;}} .rh{{font-size:14px;}}}}
.sr-only{{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}}
.lead b{{color:var(--ink);font-weight:800;}}
.hero .lead{{font-size:19px;margin-top:20px;max-width:40ch;}}
.hcta{{display:flex;gap:16px;margin-top:22px;flex-wrap:wrap;align-items:center;}}
.hcta .btn{{padding:11px 15px;font-size:14.5px;flex-shrink:0;}}
.hcta .trust{{margin-top:0;flex:1;min-width:260px;}}
.dl-alt{{margin-top:10px;font-size:13.5px;color:var(--body);}}
.dl-alt a{{color:var(--blue);font-weight:700;text-decoration:underline;}}
.pills{{display:flex;gap:12px;margin-top:22px;flex-wrap:wrap;}}
.pill{{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--line);background:#fff;border-radius:999px;
 padding:5px 9px;font-weight:600;font-size:11.5px;color:var(--ink);white-space:nowrap;}}
.pill svg{{width:14px;height:14px;color:var(--blue);}}
.trust{{display:flex;align-items:center;gap:12px;margin-top:24px;font-size:14px;color:var(--body);}}
.hprice{{margin-top:12px;font-size:14.5px;color:var(--body);}}
.proof{{background:var(--ink);color:#eaf1ff;}}
/* max-width:none + 14px: el texto entra en UNA sola fila en desktop. */
.proof .wrap{{display:flex;align-items:center;justify-content:center;gap:10px;padding:14px 24px;font-size:14px;text-align:center;flex-wrap:wrap;max-width:none;}}
.proof b{{color:#fff;}}
/* El pdot va INLINE dentro del texto (con 2 líneas, como flex item quedaba
   huérfano en una línea propia). */
/* UNA sola fila (nowrap): tamaños calibrados para la columna de ~394px.
   BNA más grande (era ilegible); MP es el logo oficial completo. */
.hero-logos{{display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:nowrap;margin-top:16px;}}
.hero-logos svg{{width:22px;height:22px;display:block;}}
.hero-logos .hl-wa{{color:var(--wa);display:block;}}
.hero-logos img{{width:auto;display:block;}}
.hero-logos .hl-mp{{height:21px;}} .hero-logos .hl-arca{{height:17px;}}
.hero-logos .hl-bna{{height:30px;}} .hero-logos .hl-uala{{height:19px;}}
.proof .pdot{{display:inline-block;width:9px;height:9px;border-radius:50%;background:#41d18b;box-shadow:0 0 0 4px rgba(65,209,139,.22);margin-right:12px;vertical-align:1px;}}
.trust .wa-c{{width:34px;height:34px;border-radius:50%;background:var(--wa);color:#053d1c;display:grid;place-items:center;}}
.trust .wa-c svg{{width:19px;height:19px;}}
.shot{{border-radius:14px;overflow:hidden;border:1px solid var(--line);box-shadow:0 30px 60px rgba(20,40,80,.18);background:#fff;}}
.hero .shotwrap{{position:relative;margin-top:0;}}
.hero .ftag{{position:absolute;left:-14px;bottom:-16px;background:#fff;border:1px solid var(--line);border-radius:12px;
 box-shadow:0 14px 30px rgba(20,40,80,.16);padding:12px 16px;display:flex;align-items:center;gap:11px;}}
.hero .ftag .ic{{width:38px;height:38px;border-radius:10px;background:var(--green);color:#fff;display:grid;place-items:center;}}
.hero .ftag .ic svg{{width:20px;height:20px;}}
.hero .ftag .k{{font-size:12px;color:var(--body);}} .hero .ftag .v{{font-weight:800;color:var(--ink);font-size:15px;}}
/* Cubo 3D (CSS 3D real, 6 caras) */
.cube3d{{position:absolute;top:-54px;right:-30px;width:150px;height:150px;z-index:7;pointer-events:none;}}
.c-halo{{position:absolute;inset:-26%;background:radial-gradient(circle,rgba(43,111,214,.5),rgba(43,111,214,0) 62%);filter:blur(3px);}}
.c-scene{{position:absolute;inset:0;perspective:820px;animation:cfloat 5.2s ease-in-out infinite;}}
.c-cube{{position:relative;width:150px;height:150px;transform-style:preserve-3d;animation:cspin 16s linear infinite;}}
.c-face{{position:absolute;width:150px;height:150px;border-radius:16px;overflow:hidden;
 display:grid;place-items:center;backface-visibility:hidden;
 background:linear-gradient(140deg,#4f92f2,#173a72);
 border:1.5px solid rgba(150,192,255,.55);box-shadow:inset 0 0 46px rgba(10,22,48,.55);}}
.c-face::after{{content:"";position:absolute;inset:0;background:linear-gradient(125deg,rgba(255,255,255,.34),rgba(255,255,255,0) 44%);}}
.c-lg{{width:62%;height:auto;position:relative;z-index:1;filter:brightness(0) invert(1) drop-shadow(0 2px 5px rgba(0,0,0,.28));opacity:.95;}}
.cf-fr{{transform:translateZ(75px);}} .cf-bk{{transform:rotateY(180deg) translateZ(75px);}}
.cf-ri{{transform:rotateY(90deg) translateZ(75px);filter:brightness(.86);}} .cf-le{{transform:rotateY(-90deg) translateZ(75px);filter:brightness(.86);}}
.cf-tp{{transform:rotateX(90deg) translateZ(75px);filter:brightness(1.16);}} .cf-bo{{transform:rotateX(-90deg) translateZ(75px);filter:brightness(.72);}}
.c-sh{{position:absolute;left:50%;bottom:-12px;width:112px;height:22px;transform:translateX(-50%);
 background:radial-gradient(ellipse at center,rgba(20,33,61,.32),rgba(20,33,61,0) 70%);filter:blur(3px);animation:csh 5.2s ease-in-out infinite;}}
@keyframes cfloat{{0%,100%{{transform:translateY(0);}}50%{{transform:translateY(-12px);}}}}
@keyframes cspin{{from{{transform:rotateX(-24deg) rotateY(0);}}to{{transform:rotateX(-24deg) rotateY(360deg);}}}}
@keyframes csh{{0%,100%{{transform:translateX(-50%) scale(1);opacity:.75;}}50%{{transform:translateX(-50%) scale(.85);opacity:.5;}}}}
@media(max-width:960px){{.hero .wrap{{grid-template-columns:1fr;gap:40px;padding:44px 24px 60px;}} .cube3d{{transform:scale(.76);top:-38px;right:-6px;}} .hero .shotwrap{{margin-top:0;}}}}
@media(prefers-reduced-motion:reduce){{.c-scene,.c-cube,.c-sh{{animation:none!important;}} .c-cube{{transform:rotateX(-24deg) rotateY(-34deg);}}}}

/* STATS */
.stats{{border-top:1px solid var(--line);border-bottom:1px solid var(--line);}}
.stats .wrap{{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:34px 24px;}}
.stat{{text-align:center;border-left:1px solid var(--line);}} .stat:first-child{{border-left:0;}}
.stat .n{{font-weight:800;color:var(--blue);font-size:34px;letter-spacing:-.02em;}}
.stat .l{{font-size:14px;color:var(--body);margin-top:2px;}}
@media(max-width:700px){{.stats .wrap{{grid-template-columns:1fr 1fr;gap:24px 12px;}} .stat:nth-child(3){{border-left:0;}}}}

/* SECTION */
.sec{{padding:52px 0;}}
.sec-h{{text-align:center;max-width:660px;margin:0 auto 30px;}}
.sec-h h2{{font-size:clamp(28px,3.5vw,40px);margin-top:12px;}}
.sec-h p{{margin-top:14px;font-size:18px;}}

/* WHY cards */
.whys{{display:grid;grid-template-columns:repeat(4,1fr);gap:22px;}}
@media(max-width:900px){{.whys{{grid-template-columns:1fr 1fr;}}}} @media(max-width:520px){{.whys{{grid-template-columns:1fr;}}}}
.why{{background:#fff;border:1px solid var(--line);border-radius:16px;padding:26px;transition:transform .18s,box-shadow .18s;}}
.why:hover{{transform:translateY(-4px);box-shadow:0 18px 40px rgba(20,40,80,.10);}}
.why .ic{{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;color:#fff;margin-bottom:16px;}}
.why .ic svg{{width:24px;height:24px;}}
.why h3{{font-size:18px;}} .why p{{margin-top:8px;font-size:15px;}}

/* FUNCIONALIDADES grid */
.func{{background:var(--soft);}}
.fgrid{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}}
@media(max-width:860px){{.fgrid{{grid-template-columns:1fr 1fr;}}}} @media(max-width:560px){{.fgrid{{grid-template-columns:1fr;}}}}
.fitem{{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:flex;gap:13px;align-items:flex-start;
 transition:border-color .15s,transform .15s;}}
.fitem:hover{{border-color:var(--blue);transform:translateY(-2px);}}
.fitem .ic{{width:34px;height:34px;border-radius:9px;background:var(--blue-t);color:var(--blue);display:grid;place-items:center;flex:none;}}
.fitem .ic svg{{width:19px;height:19px;}}
.fitem h4{{font-size:15.5px;font-weight:700;}} .fitem p{{font-size:13.5px;margin-top:2px;line-height:1.45;}}

/* SHOWCASE */
.show{{display:grid;grid-template-columns:1fr 1fr;gap:26px 44px;align-items:center;}}
.show+.show{{margin-top:44px;}} .show.rev .st{{order:2;}} .show.rev .si{{order:1;}}
.show h3{{font-size:clamp(23px,2.6vw,30px);}} .show .k{{color:var(--blue);font-weight:700;font-size:14px;}}
.show p{{margin-top:12px;font-size:16.5px;max-width:44ch;}}
.show ul{{list-style:none;padding:0;margin:16px 0 0;display:flex;flex-direction:column;gap:10px;}}
.show li{{display:flex;gap:10px;font-size:15.5px;color:var(--ink);}} .show li svg{{width:20px;height:20px;color:var(--green);flex:none;}}
/* La captura SIEMPRE entra completa en su columna (nada de desbordes cortados). */
.show .st,.show .si{{min-width:0;}}
.show .si .cwin{{max-width:100%;}}
.show .si .cwin img{{width:100%;height:auto;display:block;}}
@media(max-width:840px){{.show{{grid-template-columns:1fr;gap:22px;}} .show.rev .st{{order:1;}} .show.rev .si{{order:2;}}}}

/* COMPARATIVA */
.cmp{{overflow-x:auto;}} .cmp table{{width:100%;border-collapse:collapse;min-width:560px;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;}}
.cmp th,.cmp td{{padding:15px 18px;text-align:left;border-bottom:1px solid var(--line);font-size:15px;}}
.cmp thead th{{font-size:13px;text-transform:uppercase;letter-spacing:.04em;background:var(--soft);color:var(--ink);}}
.cmp thead th.us{{background:var(--blue);color:#fff;}}
.cmp td.f{{font-weight:600;color:var(--ink);}} .cmp td.us{{background:var(--blue-t2);font-weight:700;color:var(--ink);}}
.cmp .y{{color:var(--green);font-weight:700;}} .cmp .n{{color:#c2453b;}} .cmp tr:last-child td{{border-bottom:0;}}

/* PRECIO */
.price{{background:var(--ink);color:#fff;border-radius:22px;padding:38px;display:grid;grid-template-columns:1fr 1fr;gap:36px;align-items:center;}}
.price h2{{color:#fff;font-size:32px;}}
.price .amt{{font-weight:800;font-size:60px;letter-spacing:-.02em;margin:14px 0 2px;}}
.price .amt small{{font-size:20px;font-weight:600;color:#a9b6d6;}}
.price .demo{{color:#c3cee6;font-size:15.5px;border-top:1px solid rgba(255,255,255,.14);padding-top:16px;margin-top:8px;}}
.price ul{{list-style:none;padding:0;margin:0 0 22px;display:flex;flex-direction:column;gap:12px;}}
.price li{{display:flex;gap:11px;font-size:16px;color:#e7ecf7;}} .price li svg{{width:22px;height:22px;color:#5fe08f;flex:none;}}
.price .anchor{{color:#a9b6d6;font-size:14px;border-left:3px solid var(--blue);padding-left:13px;margin-bottom:22px;}}
@media(max-width:820px){{.price{{grid-template-columns:1fr;gap:28px;padding:32px;}} .price .amt{{font-size:48px;}}}}

/* FAQ */
.faq{{max-width:820px;margin:0 auto;}}
.faq details{{background:#fff;border:1px solid var(--line);border-radius:12px;margin-bottom:12px;}}
.faq summary{{cursor:pointer;padding:20px 22px;font-weight:700;color:var(--ink);font-size:17px;list-style:none;display:flex;justify-content:space-between;gap:14px;}}
.faq summary::-webkit-details-marker{{display:none;}} .faq summary::after{{content:'+';color:var(--blue);font-size:22px;}}
.faq details[open] summary::after{{content:'–';}} .faq .a{{padding:0 22px 20px;font-size:15.5px;}}

/* CTA + FOOTER */
.final{{background:radial-gradient(120% 120% at 100% 0%,var(--blue-d),var(--blue));color:#fff;text-align:center;}}
.sec.final{{padding:20px 0 26px;}}
.final h2{{color:#fff;font-size:clamp(28px,3.6vw,42px);}} .final p{{color:#dbe6fb;font-size:18px;margin:8px auto 0;max-width:48ch;}}
.final .row{{display:flex;gap:13px;justify-content:center;margin-top:14px;flex-wrap:wrap;align-items:center;}}
.final .num{{font-weight:800;font-size:18px;}}
.foot{{background:var(--ink);color:#9fb0d0;}} .foot .wrap{{display:flex;flex-wrap:wrap;gap:16px 26px;justify-content:space-between;align-items:center;padding:32px 24px;}}
.foot .brand{{color:#fff;}} .foot .brand b{{color:#7fb0ff;}} .foot a{{color:#cdd8ee;font-weight:600;}}
.foot small{{font-size:13px;}}
.mbar{{display:none;position:fixed;left:0;right:0;bottom:0;z-index:70;background:#fff;border-top:1px solid var(--line);padding:10px 14px;gap:10px;}}
.mbar .btn{{flex:1;justify-content:center;padding:12px;font-size:15px;}}
@media(max-width:600px){{.mbar{{display:flex;}} body{{padding-bottom:64px;}}}}
/* Carrusel */
.gal{{max-width:940px;margin:0 auto;}}
.gwrap{{position:relative;}}
.gvp{{overflow:hidden;border-radius:14px;border:1px solid var(--line);box-shadow:0 22px 48px rgba(20,40,80,.16);background:#fff;}}
.gtrack{{display:flex;transition:transform .5s cubic-bezier(.4,0,.2,1);}}
.gsl{{min-width:100%;margin:0;}}
.gbar{{display:flex;align-items:center;gap:10px;background:var(--ink);color:#c6d2ea;height:38px;padding:0 14px;font-size:13px;font-weight:600;}}
.gdz{{display:flex;gap:6px;}} .gdz i{{width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.28);}}
.gbt{{flex:1;}} .gzoom{{font-size:12px;color:#9fb3d8;font-weight:600;}}
.gsl img{{width:100%;display:block;cursor:zoom-in;}}
.gnav{{position:absolute;top:50%;transform:translateY(-50%);width:46px;height:46px;border-radius:50%;background:#fff;
 border:1px solid var(--line);box-shadow:0 8px 20px rgba(20,40,80,.18);color:var(--ink);font-size:26px;line-height:1;
 display:grid;place-items:center;cursor:pointer;z-index:3;transition:transform .15s,color .15s;}}
.gnav:hover{{color:var(--blue);transform:translateY(-50%) scale(1.06);}}
.gnav.prev{{left:-16px;}} .gnav.next{{right:-16px;}}
.hero-gal{{max-width:none;}}
.hero-gal .gnav{{width:38px;height:38px;font-size:20px;}}
.hero-gal .gnav.prev{{left:8px;}} .hero-gal .gnav.next{{right:8px;}}
.hero-gal .gbar{{height:34px;font-size:12px;}} .hero-gal .gdots{{margin-top:14px;}}
/* Coverflow 3D */
/* clip horizontal: las cards laterales del 3D no invaden la sección del logo
   (overflow-y visible para que respiren las sombras). */
.cfbox{{width:100%;overflow:clip visible;}}
/* 367px = alto natural de la card MÁS ALTA sin gbar (medido con CDP): la fila
   del logo+texto y el carrusel terminan juntos, sin aire fantasma abajo. */
.cfrow{{position:relative;height:367px;margin-top:8px;}}
.cf{{position:relative;width:100%;height:100%;perspective:1700px;}}
/* margin:0 mata el margin UA de <figure> (40px) que corría la card del centro. */
.cf-card{{position:absolute;top:50%;left:50%;width:min(90%,560px);margin:0;
 transform:translate(-50%,-50%);transform-origin:center center;backface-visibility:hidden;cursor:pointer;}}
/* Desktop (modo 3D): cards ALINEADAS ARRIBA con el tope del logo (pedido de
   Bruno) — top 0 + origin/fuga arriba para que scale y perspectiva no las
   bajen; el translateY(0) correspondiente vive en el JS (rama no-flat). */
@media(min-width:901px){{
 .cf-card{{top:0;transform-origin:50% 0;}}
 .cf{{perspective-origin:50% 0;}}
}}
.cf-card{{
 transition:none;will-change:transform,opacity;}}
.cwin{{border-radius:12px;overflow:hidden;border:1px solid var(--line);box-shadow:0 24px 50px rgba(20,40,80,.30);background:#fff;}}
.cf-card img{{width:100%;display:block;}}
.cfrow .gnav{{position:absolute;top:50%;transform:translateY(-50%);z-index:130;}}
.cfrow .gnav.prev{{left:-6px;}} .cfrow .gnav.next{{right:-6px;}}
.gzoom{{font-size:14px;color:#9fb3d8;}}
@media(max-width:960px){{.cfrow{{height:380px;}} .cf-card{{width:min(88%,500px);}}}}
/* ≤900px el JS pasa el carrusel a modo plano: UNA captura por vez, completa, sin superposición. */
@media(max-width:900px){{.cfrow{{height:400px;}} .cf-card{{width:min(94%,520px);}}}}
@media(max-width:560px){{.cfrow{{height:300px;}} .cf-card{{width:min(92%,380px);}} .cfrow .gnav{{width:38px;height:38px;font-size:20px;}}}}
.gdots{{display:flex;gap:9px;justify-content:center;margin-top:18px;flex-wrap:wrap;}}
.gdot{{width:9px;height:9px;border-radius:50%;border:0;background:#c8d3e6;cursor:pointer;padding:0;transition:background .2s,transform .2s;}}
.gdot.on{{background:var(--blue);transform:scale(1.3);}}
@media(max-width:600px){{.gnav.prev{{left:4px;}} .gnav.next{{right:4px;}} .gzoom{{display:none;}}}}
/* Lightbox */
.lb{{position:fixed;inset:0;z-index:200;background:rgba(9,17,34,.9);display:none;align-items:center;justify-content:center;padding:24px;}}
.lb.open{{display:flex;}}
.lb img{{max-width:94vw;max-height:88vh;border-radius:10px;box-shadow:0 30px 80px rgba(0,0,0,.55);}}
.lb-x{{position:absolute;top:16px;right:20px;background:none;border:0;color:#fff;font-size:30px;cursor:pointer;line-height:1;}}
.lb-nav{{position:absolute;top:50%;transform:translateY(-50%);background:rgba(255,255,255,.12);border:0;color:#fff;
 font-size:32px;width:52px;height:52px;border-radius:50%;cursor:pointer;display:grid;place-items:center;}}
.lb-nav:hover{{background:rgba(255,255,255,.22);}} .lb-nav.prev{{left:18px;}} .lb-nav.next{{right:18px;}}
@media(max-width:600px){{.lb-nav{{width:44px;height:44px;font-size:24px;}}}}
/* ===== Rediseño debajo del hero ===== */
.rubros2{{background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line);}}
.rubros2 .wrap{{display:grid;grid-template-columns:auto 1fr;gap:8px 28px;align-items:center;padding:20px 24px;}}
.ru-t{{font-family:var(--disp);font-weight:800;font-size:19px;color:var(--ink);margin:0;}} .ru-t b{{color:var(--blue);}}
.ru-chips{{display:flex;flex-wrap:wrap;gap:9px;justify-self:end;}} .ru-chips .pill{{font-size:14px;padding:8px 15px;font-weight:700;}}
.ru-foot{{grid-column:1 / -1;color:var(--body);font-size:14px;margin:0;}}
@media(max-width:860px){{.rubros2 .wrap{{grid-template-columns:1fr;}} .ru-chips{{justify-self:start;}}}}
.pain-2col{{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:0.82fr 1.3fr;gap:44px;align-items:center;}}
.pain-head h2{{font-size:clamp(25px,3vw,36px);}} .pain-head p{{color:var(--body);margin-top:12px;font-size:16.5px;}}
.pain-sheet{{border-radius:12px;overflow:hidden;border:1px solid var(--line);box-shadow:0 24px 50px rgba(20,40,80,.18);background:#fff;text-align:left;}}
@media(max-width:820px){{.pain-2col{{grid-template-columns:1fr;gap:26px;}} .pain-head p{{max-width:none;}}}}
.pain-body{{padding:4px 26px 16px;}}
/* CARACTERÍSTICAS PRINCIPALES — 2 columnas compactas */
.feats{{display:grid;grid-template-columns:1fr 1fr;gap:4px 44px;margin-top:12px;}}
.feats ul{{list-style:none;margin:0;padding:0;}}
.feats li{{position:relative;padding:6px 0 6px 24px;border-bottom:1px solid var(--line);font-size:14.5px;color:var(--ink);line-height:1.3;}}
.feats li::before{{content:'✓';position:absolute;left:2px;top:5px;color:var(--blue);font-weight:800;}}
@media(max-width:700px){{.feats{{grid-template-columns:1fr;gap:0 0;}}}}
.pain-row{{display:flex;justify-content:space-between;gap:18px;align-items:baseline;padding:12px 0;border-bottom:1px solid var(--line);font-size:15.5px;color:var(--ink);}}
.pain-row>span:first-child{{flex:1;padding-right:14px;}}
.pain-row .mny{{color:var(--coral);font-weight:600;font-size:19px;white-space:nowrap;}}
.pain-total{{display:flex;justify-content:space-between;gap:18px;align-items:baseline;padding:14px 0 2px;border-top:3px solid var(--coral);margin-top:2px;}}
.pain-total>span:first-child{{font-family:var(--disp);font-weight:800;font-size:18px;color:var(--ink);line-height:1.2;}}
.pain-total .mny{{font-family:var(--disp);font-weight:800;font-size:clamp(26px,3.6vw,34px);color:var(--coral);}}
.pain-stamp{{display:inline-block;margin-top:20px;background:var(--blue-t);color:var(--blue-d);font-weight:700;padding:11px 18px;font-size:15px;}}
.sc-intro{{max-width:680px;margin:0 auto 32px;text-align:center;}}
.sc-intro h2{{font-size:clamp(26px,3.4vw,38px);}} .sc-intro h2 b{{color:var(--blue);}}
.sc-intro p{{color:var(--body);font-size:17px;margin-top:10px;}}
.anchors{{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:18px;}}
.anchors a{{font-family:var(--disp);font-weight:700;font-size:14px;color:var(--blue-d);background:var(--blue-t);padding:9px 17px;border-radius:999px;transition:background .15s,color .15s;}}
.anchors a:hover{{background:var(--blue);color:#fff;}}
.sc-wrap{{display:flex;flex-direction:column;gap:40px;}}
.sc{{align-items:center;gap:40px;}}
.sc-k{{display:inline-block;font-family:var(--disp);font-weight:700;font-size:12.5px;color:var(--blue);letter-spacing:.03em;margin-bottom:6px;text-transform:uppercase;}}
.sc .st h3{{font-size:clamp(22px,2.6vw,29px);}} .sc .st>p{{color:var(--body);margin-top:10px;font-size:16px;max-width:46ch;}}
.sc-solve{{display:inline-flex;align-items:center;gap:8px;margin-top:13px;background:#fdece0;color:#b4531a;font-weight:700;font-size:14px;padding:8px 14px;border-radius:10px;}}
.sc-solve::before{{content:"✕";font-weight:800;font-size:12px;}}
.sc-notes{{list-style:none;padding:0;margin:14px 0 0;display:flex;flex-direction:column;gap:7px;}}
.sc-notes li{{font-size:15px;color:var(--body);padding-left:20px;position:relative;line-height:1.45;}}
.sc-notes li::before{{content:"";position:absolute;left:0;top:8px;width:9px;height:9px;border-radius:50%;background:var(--blue);}}
.sc-notes b{{color:var(--ink);font-weight:700;}}
.sc .cwin{{box-shadow:0 24px 50px rgba(20,40,80,.20);}}
.a4sheet{{background:#fff;border:1px solid var(--line);box-shadow:0 30px 60px rgba(20,40,80,.22);border-radius:4px;overflow:hidden;max-width:430px;margin:0;}}
.a4sheet img{{width:100%;display:block;}}
/* Presupuestos: la hoja A4 es más alta que el texto → alinear ambos ARRIBA
   para que el título arranque a la altura de la imagen (como pidió Bruno). */
#sc-presu{{align-items:start;}}
#sc-presu .st{{padding-top:4px;}}
.mini3{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px;}}
.mini3 .cwin{{box-shadow:0 14px 32px rgba(20,40,80,.14);border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;}}
.mini3 img{{cursor:zoom-in;display:block;width:100%;}}
.incl2col{{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:13px 34px;max-width:780px;}}
.incl2col li{{display:flex;gap:11px;align-items:center;font-size:16px;color:var(--ink);font-weight:500;}}
.incl2col li svg{{width:20px;height:20px;color:var(--green);flex:none;}}
@media(max-width:700px){{.mini3{{grid-template-columns:1fr;}} .incl2col{{grid-template-columns:1fr;}}}}
/* #comp compactada (pedido de Bruno, sep-2026): título y subtítulo JUNTOS en
   la MISMA fila (baseline, tamaños por vw calibrados para caber en 1280-1920;
   en angosto el flex-wrap los apila sin desbordar), texto arriba, sin aire. */
#comp{{padding-top:16px;}}
#comp .sec-h{{max-width:none;margin-bottom:14px;display:flex;align-items:baseline;justify-content:center;gap:14px;flex-wrap:wrap;}}
#comp .sec-h h2{{font-size:18px;margin:0;white-space:nowrap;}}
#comp .sec-h p{{margin:0;font-size:13px;white-space:nowrap;}}
@media(max-width:700px){{#comp .sec-h h2,#comp .sec-h p{{white-space:normal;text-align:center;}}}}
/* stretch: las 3 cards siempre del MISMO alto (pedido de Bruno, sep-2026). */
.facturas{{display:grid;grid-template-columns:1fr 1fr 1.1fr;gap:20px;max-width:1120px;margin:0 auto;align-items:stretch;}}
.fac{{border-radius:16px;padding:26px;}}
.fac-bad{{background:#fff;border:1.5px dashed #cdd6e6;}}
.fac-good{{background:var(--blue);color:#fff;box-shadow:0 22px 46px rgba(43,111,214,.30);}}
.fac-h{{font-family:var(--disp);font-weight:800;font-size:18px;margin-bottom:12px;}}
.fac-bad .fac-h{{color:var(--body);}}
.fr{{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line);color:var(--ink);font-size:15px;font-weight:600;}}
.fr:last-child{{border-bottom:0;}}
.fac-qs{{list-style:none;margin:0;padding:0;}}
.fac-qs li{{padding:12px 0;border-bottom:1px solid var(--line);color:var(--ink);font-size:15px;font-weight:600;line-height:1.45;}}
.fac-qs li:last-child{{border-bottom:0;}}
.fr span{{color:var(--coral);font-weight:700;font-size:13px;text-align:right;}}
.fr2{{display:flex;gap:10px;align-items:center;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.18);font-size:15.5px;font-weight:600;}}
.fr2 svg{{width:20px;height:20px;color:#9df0bb;flex:none;}}
.fac-total{{display:flex;justify-content:space-between;align-items:baseline;margin-top:18px;padding-top:14px;border-top:1.5px solid rgba(255,255,255,.25);}}
.fac-total>span:first-child{{font-weight:600;}} .fac-total .z{{font-family:var(--disp);font-weight:800;font-size:42px;line-height:1;}}
.fac-foot{{text-align:center;color:var(--body);margin-top:24px;font-weight:600;font-size:16px;}}
@media(max-width:940px){{.facturas{{grid-template-columns:1fr;max-width:560px;}}}}
.faq-grid{{display:grid;grid-template-columns:2fr 1fr;gap:30px;align-items:start;}}
.faq-rail .rail-card{{position:sticky;top:88px;background:var(--blue-t2);border:1px solid var(--line);border-radius:16px;padding:24px;}}
.rail-card h4{{font-family:var(--disp);font-size:18px;color:var(--ink);margin:0;}} .rail-card p{{color:var(--body);font-size:15px;margin:8px 0 16px;}}
.faq-badge{{display:inline-block;background:var(--blue-t);color:var(--blue-d);font-size:11px;font-weight:700;padding:3px 9px;border-radius:6px;margin-left:10px;vertical-align:middle;}}
@media(max-width:820px){{.faq-grid{{grid-template-columns:1fr;}} .faq-rail .rail-card{{position:static;}}}}
.rv{{opacity:0;transform:translateY(16px);transition:opacity .5s,transform .5s;}} .rv.in{{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){{.rv{{opacity:1;transform:none;}} html{{scroll-behavior:auto;}}}}
/* ===== Bordes rectos en todo (cards, botones, menús, pills, ventanas) ===== */
.btn,.pill,.badge,.faq-badge,.why,.why .ic,.fitem,.fitem .ic,
.shot,.cwin,.gvp,.mini3 .cwin,.a4sheet,.hero .ftag,.hero .ftag .ic,
.price,.fac,.faq details,.faq-rail .rail-card,.cmp table,
.pain-sheet,.pain-stamp,.anchors a,.sc-solve,.stat,
.lb img{{border-radius:0 !important;}}
"""

def chk(): return "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l4.5 4.5L19 7'/></svg>"
def shot(t,s,a): return (f"<figure class='shot'><img loading='lazy' src='{s}' alt='{a}'/></figure>")
def sc(sid,rev,klabel,title,body,solve,wtitle,src,notes,alt=None):
    n="".join(f"<li><b>{a}</b>{b}</li>" for a,b in notes)
    r=" rev" if rev else ""
    alt=alt or f"StockFlow {wtitle}"
    return (f"<div class='show sc{r} rv' id='{sid}'>"
            f"<div class='st'><span class='sc-k'>{klabel}</span><h3>{title}</h3><p>{body}</p>"
            f"<span class='sc-solve'>{solve}</span>"
            f"<ul class='sc-notes'>{n}</ul></div>"
            f"<div class='si'><figure class='cwin'><div class='gbar'><span class='gdz'><i></i><i></i><i></i></span>"
            f"<span class='gbt'>StockFlow — {wtitle}</span></div><img loading='lazy' src='{src}' {wh(src)} alt='{alt}'/></figure></div></div>")

FEATURES=[('box','Gestión de artículos','Alta, baja y modificación completa.'),
 ('truck','Proveedores','Administrá compras y proveedores.'),
 ('users','Clientes','Base con cuentas corrientes.'),
 ('cart','Compras y ventas','Circuito completo de compra-venta.'),
 ('cash','Caja diaria','Apertura, cierre y movimientos.'),
 ('ledger','Cuentas corrientes','Saldos de clientes y proveedores.'),
 ('tag','Actualización masiva','Cambiá precios por % en un clic.'),
 ('list','Listas de precios','Distintos precios por tipo de venta.'),
 ('alert','Stock mínimo','Alertas y listados de reposición.'),
 ('barcode','Códigos de barras','Generá e imprimí tus códigos.'),
 ('a4','Presupuestos A4','PDF formal que se convierte en venta.'),
 ('receipt','Ticket térmico o A4','Impresión 58/80 mm o A4 formal.'),
 ('chart','Estadísticas','Ventas por producto, fecha y vendedor.'),
 ('calc','Contabilidad + IVA','Resumen contable y Libro IVA.'),
 ('excel','Importar desde Excel','Cargá tu catálogo en masa.'),
 ('save','Backups','Copias de seguridad de tus datos.'),
 ('lock','Usuarios y permisos','Vendedor con accesos restringidos.'),
 ('qr','MercadoPago QR','Cobrá con QR desde el sistema.'),
]

BODY=f"""
<nav class="nav"><div class="wrap">
 <a href="#top" aria-label="StockFlow"><img class="brand-img" src="{LOGO}" {wh(LOGO)} alt="StockFlow"/></a>
 <div class="nlinks"><a href="#why">Beneficios</a><a href="#func">Funciones</a><a href="#comp">Comparación</a><a href="#precio">Precio</a><a href="#faq">Preguntas</a></div>
 <div class="cta"><a class="nav-txt" data-sf-cta="whatsapp" href="{WA}" target="_blank" rel="noopener">Consultar por WhatsApp</a><a class="btn btn-wa nav-wa" data-sf-cta="whatsapp" aria-label="Consultar por WhatsApp" href="{WA}" target="_blank" rel="noopener">{WA_SVG}</a></div>
</div></nav>

<header class="hero" id="top"><div class="wrap">
 <!-- ORDEN DEL HERO (pedido de Bruno, sep-2026): rubros + cubo + carrusel
      arriba, y el bloque del título con los botones DEBAJO (sin duplicados). -->
 <div class="rubros-hero">
  <span class="rh"><i>{G['lu_wrench']}</i>Ferreterías</span>
  <span class="rh"><i>{G['lu_forklift']}</i>Corralones</span>
  <span class="rh"><i>{G['lu_store']}</i>Autoservicios</span>
  <span class="rh"><i>{G['lu_shirt']}</i>Indumentaria</span>
  <span class="rh"><i>{G['lu_boxes']}</i>Mayoristas</span>
  <span class="rh"><i>{G['lu_truck']}</i>Distribuidoras</span>
  <span class="rh"><i>{G['lu_gear']}</i>Repuestos</span>
 </div>
 <div class="hero-left">
  <img class="hero-cube" src="{CUBE}" {wh(CUBE)} fetchpriority="high" alt="StockFlow — Sistema de Gestión Comercial"/>
  <div class="trust"><span class="wa-c">{WA_SVG}</span><span>Instalación asistida y <b>soporte real</b> por WhatsApp. Probalo 30 días gratis en tu comercio.</span></div>
  <div class="hprice">Prueba gratis por <b>30 días, sin costo</b> — se activa sola al instalar, sin tarjeta · después <b>{money("70.000")}/mes</b> todo incluido, sin costos ocultos.</div>
 </div>
 <div class="shotwrap">
  <div class="cfbox">
   <div class="cfrow">
    <div class="cf" id="cf">{GAL_SLIDES}</div>
   </div>
  </div>
 </div>
 <!-- Los puntitos del carrusel se eliminaron (pedido de Bruno): el título
      ocupa esa franja. El JS tolera la ausencia de #gdots y el carrusel
      sigue rotando solo (y con swipe en el teléfono). -->
 <h1 class="hero-title hero-title-low">Todo tu comercio en <b>un solo sistema integral</b>.</h1>
 <!-- Bajo el título, DOS columnas (pedido de Bruno, sep-2026): botones a la
      izquierda ocupando el recuadro, y "Características principales" en
      PARALELO a la derecha con las 22 completas (antes vivían repartidas en
      dos secciones más abajo — se movieron acá, no duplicar). -->
 <div class="hero-acciones">
  <a class="btn btn-blue" data-sf-cta="download-win" href="/dl/StockFlow-Setup.exe">Descargar directo para Windows</a>
  <div class="dl-alt"><a data-sf-cta="download-mac" href="/dl/StockFlow.dmg">Descargar para Mac</a> · En Mac, la primera vez: clic derecho sobre StockFlow → Abrir.</div>
  <div class="hero-logos">
   <img class="hl-mp" src="{L_MP}" {wh(L_MP)} alt="Mercado Pago" loading="lazy"/>
   <span title="WhatsApp" class="hl-wa">{WA_SVG}</span>
   <img class="hl-arca" src="{L_ARCA}" {wh(L_ARCA)} alt="ARCA" loading="lazy"/>
   <img class="hl-bna" src="{L_BNA}" {wh(L_BNA)} alt="Banco de la Nación Argentina" loading="lazy"/>
   <img class="hl-uala" src="{L_UALA}" {wh(L_UALA)} alt="Ualá" loading="lazy"/>
  </div>
 </div>
 <div class="hero-feats" id="func">
  <h2>Características <b>principales</b></h2>
  <div class="feats">
   <ul>
    <li>Funciona sin internet — seguís vendiendo aunque se corte</li>
    <li>Facturación electrónica ARCA (CAE)</li>
    <li>Punto de venta rápido con ticket térmico</li>
    <li>Control de stock con alertas de reposición</li>
    <li>Cuentas corrientes de clientes y proveedores</li>
    <li>Caja diaria con apertura, cierre y arqueo</li>
    <li>Asistente virtual Flowy: ayuda 24/7 dentro del sistema</li>
    <li>Soporte técnico directo por WhatsApp</li>
    <li>Integración con Mercado Pago (QR) y WhatsApp</li>
    <li>Compras, ventas y presupuestos</li>
    <li>3 listas de precios + precio mayorista</li>
   </ul>
   <ul>
    <li>Actualización masiva de precios con vista previa</li>
    <li>Descuentos por producto y sobre el total</li>
    <li>Estadísticas, contabilidad y Libro IVA</li>
    <li>Importación de productos desde Excel</li>
    <li>Buscador total: código, marca, familia o proveedor</li>
    <li>Multiusuario con roles y permisos</li>
    <li>Varias cajas conectadas en red local</li>
    <li>Escáner, balanza electrónica y cajón de dinero</li>
    <li>Reportes exportables a Excel y PDF</li>
    <li>Backups automáticos: tus datos en tu PC</li>
    <li>Actualizaciones automáticas incluidas</li>
    <li>Catálogo web incorporado, conectado con tu sistema</li>
   </ul>
  </div>
 </div>
</div></header>

<!-- DECISIÓN DEFINITIVA (Bruno, sep-2026): SIN bloque de prueba social.
     Primero se anonimizó y después se eliminó entero por decisión de Bruno:
     no se publican clientes (ni con nombre ni anónimos). No reintroducir. -->
<!-- Las "Características principales" (las 22) viven ahora en el HERO, en
     paralelo a los botones (pedido de Bruno, sep-2026). Acá había dos
     secciones (6 principales + 16 "incluido") — NO reintroducirlas. -->
<!-- Sin logos en la franja (pedido de Bruno, sep-2026): las marcas van solo
     como texto en negrita. -->
<section class="proof"><div class="wrap">
 <span><span class="pdot"></span>En producción desde 2022: integración con <b>Mercado Pago</b> · <b>ARCA</b> · <b>WhatsApp</b> y <b>tu catálogo web</b>. <b>Todo en un mismo lugar</b> — asistente virtual incorporado y soporte directo de quien lo desarrolla.</span>
</div></section>

<section class="sec"><div class="wrap">
 <div class="sc-intro">
  <h2>No lo contamos. <b>Lo mostramos.</b></h2>
  <p>Cada captura es del sistema real, con datos reales. Mirá qué resuelve cada módulo.</p>
  <nav class="anchors"><a href="#sc-ventas">Ventas</a><a href="#sc-precios">Precios</a><a href="#sc-cuentas">Cuentas</a><a href="#sc-caja">Caja</a><a href="#sc-presu">Presupuestos</a><a href="#sc-ganas">Rentabilidad</a></nav>
 </div>
 <div class="sc-wrap">
 {sc('sc-ventas',False,'Punto de venta','Cobrá en segundos, con el IVA ya calculado.','Escaneás el código o escribís el nombre y el producto entra con su precio. Confirmás con F2 y el comprobante queda listo. Si se corta internet, seguís cobrando sin interrupciones.','Sin demoras en el mostrador','Ventas',PDV,[('Código y marca a la vista',' — tres artículos cargados escaneando o por nombre'),('IVA contenido discriminado',' — $&#8202;14.151,22 ya calculado, sin cuentas manuales'),('F2 y listo',' — confirmás con el total exacto: $&#8202;81.538,00')],alt='Punto de venta de StockFlow con tres artículos cargados, IVA discriminado y el total listo para confirmar con F2')}
 {sc('sc-precios',False,'Actualización de precios','Actualizá toda la lista en un clic.','Seleccionás la lista, ingresás el porcentaje y ves cada cambio antes de confirmarlo: precio actual, nuevo y diferencia, artículo por artículo.','Sin repreciar artículo por artículo','Actualización de precios',PRECIOS,[('+18% con vista previa',' — actual, nuevo y diferencia de cada artículo'),('44 cambios en un clic',' — revisás y confirmás antes de aplicar'),('Hasta 3 listas',' — mostrador, mayorista y especial')],alt='Vista previa de actualización de precios en StockFlow: precio actual, nuevo y diferencia por artículo')}
 {sc('sc-cuentas',False,'Cuentas corrientes','Sabés quién te debe, cuánto y desde cuándo.','Cada cliente con su saldo actualizado. Registrás la cobranza y la cuenta se ajusta automáticamente, sin deudas anotadas en papeles sueltos.','Sin cuadernos de deuda','Cuentas Corrientes',CTA_,[('$&#8202;13.400',' — el saldo de cada cliente, siempre a la vista'),('Último pago y comprobantes',' — cada cuenta con su historia completa'),('5 con saldo',' — sabés a quién cobrarle de un vistazo')],alt='Cuentas corrientes de StockFlow con cinco clientes con saldo y su último pago')}
 {sc('sc-caja',False,'Caja y arqueo','Al cierre sabés exactamente cuánto debe haber en caja.','Cada medio de pago discriminado, con la comisión de tarjeta ya descontada y el efectivo esperado calculado. Cerrás la caja con el monto exacto, sin estimaciones.','Sin descuadres al cierre','Caja diaria',CAJA2,[('$&#8202;170.000 esperados en el cajón',' — el monto exacto para el arqueo'),('Comisión descontada',' — el neto real de cada medio de pago'),('Cada movimiento con su hora',' — ventas, señas y retiros del día')],alt='Caja diaria de StockFlow con efectivo esperado, desglose por medio de pago y comisión descontada')}
 <div class="show sc rv" id="sc-presu">
  <div class="st"><span class="sc-k">Presupuestos</span><h3>Presupuestás formal y lo convertís en venta con un clic.</h3>
   <p>PDF A4 con tu encabezado, tu CUIT y la vigencia. El cliente lo aprueba y lo convertís en venta sin volver a cargar los productos.</p>
   <span class="sc-solve">Sin presupuestos armados en Word</span>
   <ul class="sc-notes"><li><b>Membrete y CUIT</b> — impresos automáticamente en el PDF</li><li><b>Vigencia 30 días</b> — quedás cubierto ante un reprecio</li><li><b>Un clic</b> — presupuesto aprobado → venta registrada</li></ul></div>
  <div class="si"><figure class="a4sheet"><img loading="lazy" src="{PRES}" {wh(PRES)} alt="Presupuesto A4 de StockFlow"/></figure></div>
 </div>
 {sc('sc-ganas',False,'Rentabilidad','No es cuánto vendés. Es cuánto te queda.','Margen bruto, ticket promedio y tendencia, filtrados por fecha y medio de pago. Identificás qué productos son rentables y cuáles no.','Sin vender a ciegas','Estadísticas',EST,[('Margen bruto',' — cuánto te queda, no solo cuánto vendés'),('Ticket promedio',' — cuánto compra cada cliente, en promedio'),('Por período y medio de pago',' — el análisis que necesites')],alt='Estadísticas de StockFlow con ventas del mes, ticket promedio y margen bruto')}
 </div>
</div></section>

<section class="sec" id="comp"><div class="wrap">
 <div class="sec-h"><h2>El pago único parece más económico… <span style="color:var(--coral)">hasta el próximo cambio de ARCA</span>.</h2><p>Se paga una vez, pero cada mejora, soporte o adecuación normativa se cobra por separado.</p></div>
 <div class="facturas rv">
  <div class="fac fac-bad">
   <div class="fac-h">Sistema de pago único</div>
   <div class="fr">Versión nueva por ARCA<span>se cobra aparte</span></div>
   <div class="fr">Soporte<span>limitado o con costo</span></div>
   <div class="fr">Actualizaciones y mejoras<span>no incluidas</span></div>
   <div class="fr">Entre versiones<span>seguís con la anterior</span></div>
  </div>
  <!-- Sin afirmaciones sobre competidores: solo preguntas que el visitante
       puede hacerle a CUALQUIER sistema, y las respuestas de StockFlow. -->
  <div class="fac fac-bad">
   <div class="fac-h">Un mensual más económico</div>
   <ul class="fac-qs">
    <li>¿Quién te atiende cuando el sistema falla un sábado a la tarde?</li>
    <li>¿La adecuación a los cambios de ARCA viene incluida o se cobra aparte?</li>
    <li>¿Cuentas corrientes, 3 listas de precios y presupuestos están en el plan que te cotizaron, o son módulos extra?</li>
    <li>¿Podés probarlo 30 días completos sin dejar la tarjeta?</li>
   </ul>
  </div>
  <div class="fac fac-good">
   <div class="fac-h">StockFlow · cuota fija</div>
   <div class="fr2">{chk()}Te atiende quien programó el sistema, por WhatsApp.</div>
   <div class="fr2">{chk()}Incluida. Costos extra: $0.</div>
   <div class="fr2">{chk()}Todo incluido en los {money("70.000")}.</div>
   <div class="fr2">{chk()}Sí. 30 días, sin tarjeta, sin vendedor.</div>
  </div>
 </div>
 <div class="price rv" id="precio" style="margin-top:40px">
  <div><h2>Suscripción · todo incluido</h2>
   <div class="amt mny"><small>$</small>&#8202;70.000<small>/mes</small></div>
   <div class="demo">Probalo <b>gratis por 30 días</b> — descargás, instalás y la prueba se activa sola, sin tarjeta.</div></div>
  <div><ul>
    <li>{chk()}Todo lo de arriba: ventas y actualización masiva de precios</li>
    <li>{chk()}Cuentas corrientes, caja y presupuestos A4</li>
    <li>{chk()}Estadísticas, actualizaciones nuevas y ARCA al día</li>
    <li>{chk()}Soporte por WhatsApp, de una persona</li></ul>
   <a class="btn btn-blue" data-sf-cta="whatsapp" href="{WA}" target="_blank" rel="noopener" style="width:100%;justify-content:center">{WA_SVG}Consultar por WhatsApp</a>
   <a data-sf-cta="download-win" href="/dl/StockFlow-Setup.exe" style="display:block;text-align:center;margin-top:10px;font-size:14px">O descargá directo para Windows</a></div>
 </div>
</div></section>

<section class="sec func" id="faq"><div class="wrap">
 <div class="sec-h" style="text-align:left;max-width:none;margin:0 0 40px"><div class="eyebrow">Preguntas</div><h2>Preguntas frecuentes antes de empezar.</h2></div>
 <div class="faq-grid">
  <div class="faq rv">
   <details open><summary>¿Qué me ahorra concretamente?</summary><div class="a">Repreciar una lista completa pasa de una tarde a un minuto. El fiado deja de estar en papeles sueltos. La caja cierra con el monto exacto. Cuánto vale eso en tu comercio lo sabés vos mejor que yo.</div></details>
   {"".join(f'<details><summary>{q}</summary><div class="a">{a}</div></details>' for q,a in [
    ("¿Necesito internet para usarlo?","No. StockFlow funciona en tu PC de forma 100% offline. La conexión solo se usa para actualizaciones o ARCA. Si se corta, seguís operando con normalidad."),
    ("Ya lo llevo en Excel, ¿tengo que cargar todo de nuevo?","No. StockFlow importa tus productos desde Excel: códigos, descripciones, precios y stock. Traés tu planilla y el sistema arranca con tu catálogo cargado."),
    ("¿Cuánto tardo en cargar mis productos?","Si los tenés en Excel, la importación los deja cargados en minutos. Si no, podés cargarlos a medida que vendés — y la instalación asistida incluye dejarte el sistema funcionando con tus productos."),
    ("¿Puedo pasar los datos del sistema que tengo hoy?","En muchos casos, sí: ya migramos comercios que venían de otros sistemas con sus artículos, clientes y cuentas corrientes. Escribinos por WhatsApp contándonos qué sistema usás y lo vemos con tus datos."),
    ("¿Mis datos quedan en mi PC?","Sí. Tus datos son tuyos y residen en tu computadora. El sistema genera copias de seguridad que guardás donde prefieras."),
    ("¿Por qué suscripción y no pago único?","Porque incluye todo: actualizaciones, soporte y adecuación permanente a ARCA. El pago único deja el sistema en una versión fija y, ante cada cambio normativo, se vuelve a pagar."),
    ("¿Cómo funciona la prueba gratis?","Descargás el instalador, lo instalás y al abrir StockFlow completás tu nombre, comercio y WhatsApp: la prueba de 30 días se activa sola, sin tarjeta. Es el sistema completo. Al finalizar, tus datos quedan intactos y activás tu licencia por WhatsApp."),
    ("¿Incluye la instalación?","Sí. Si la necesitás, lo dejamos instalado y en funcionamiento con tus productos cargados. La prueba gratuita de 30 días incluye la instalación asistida."),
    ("¿Qué pasa si dejo de pagar?","El sistema pasa a modo solo lectura: seguís consultando tu información, pero no cargás nuevas operaciones. No se pierde ningún dato y, al renovar, vuelve a funcionar de forma completa."),
    ("¿Para qué comercios es?","Para comercios con volumen de operación: ferreterías, corralones, autoservicios, indumentaria, mayoristas, distribuidoras y casas de repuestos."),
   ])}
  </div>
  <aside class="faq-rail rv"><div class="rail-card"><h4>¿Tenés otra consulta?</h4><p>Escribinos y te responde una persona, no un bot. Contestamos el mismo día.</p><a class="btn btn-wa" data-sf-cta="whatsapp" href="{WA}" target="_blank" rel="noopener" style="width:100%;justify-content:center">{WA_SVG}Consultar por WhatsApp</a></div></aside>
 </div>
</div></section>

<section class="sec final"><div class="wrap">
 <h2>Probalo en tu comercio esta semana.</h2>
 <p>Instalación asistida, 30 días de prueba gratis y soporte personal —atendido por una persona—. Contestamos el mismo día.</p>
 <div class="row"><a class="btn btn-wa" data-sf-cta="whatsapp" href="{WA}" target="_blank" rel="noopener" style="font-size:17px;padding:16px 30px">{WA_SVG}Escribinos por WhatsApp</a><span class="num">+54 342 584 7340</span></div>
</div></section>



<div class="mbar"><a class="btn btn-ghost" href="#precio">Precio</a><a class="btn btn-wa" data-sf-cta="whatsapp" href="{WA}" target="_blank" rel="noopener">{WA_SVG}WhatsApp</a></div>

<div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Vista ampliada">
 <button class="lb-x" id="lbx" aria-label="Cerrar">✕</button>
 <button class="lb-nav prev" id="lbp" aria-label="Anterior">‹</button>
 <img id="lbimg" src="" alt="Pantalla de StockFlow"/>
 <button class="lb-nav next" id="lbn" aria-label="Siguiente">›</button>
</div>

<script>
(function(){{var io=new IntersectionObserver(function(es){{es.forEach(function(e){{if(e.isIntersecting){{e.target.classList.add('in');io.unobserve(e.target);}}}});}},{{threshold:.12}});document.querySelectorAll('.rv').forEach(function(e){{io.observe(e);}});}})();
(function(){{
 var cf=document.getElementById('cf'); if(!cf) return;
 var cards=[].slice.call(cf.querySelectorAll('.cf-card')), n=cards.length;
 var dots=[].slice.call(document.querySelectorAll('#gdots .gdot'));
 var lb=document.getElementById('lb'), lbimg=document.getElementById('lbimg');
 var rm=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
 var pos=0, target=0, speed=0.0062, li=0, raf;
 var mq=window.matchMedia('(max-width:900px)');
 function wrap(d){{while(d>n/2)d-=n; while(d<-n/2)d+=n; return d;}}
 function place(){{
  var flat=mq.matches;
  cards.forEach(function(c,k){{
   var d=wrap(k-pos), ad=Math.abs(d), x, z, ry, s, op;
   if(flat){{
    /* Modo plano (angosto): una captura entera por vez, deslizando de costado. */
    x=d*106; z=0; ry=0; s=1; op=Math.max(0,1-ad*1.5);
   }} else {{
    x=d*45; z=-ad*205; ry=-d*32; s=Math.max(.4,1-ad*0.17); op=Math.max(0,1-ad*0.42);
   }}
   c.style.opacity=''+op; c.style.pointerEvents=(ad<(flat?0.5:2)?'auto':'none'); c.style.zIndex=''+Math.round(100-ad*10);
   /* 3D (desktop): translateY 0 — las cards se alinean al TOPE del row (a la
      altura del logo). Plano (angosto): centradas como siempre. */
   c.style.transform='translate(-50%,'+(flat?'-50%':'0')+') translateX('+x+'%) translateZ('+z+'px) rotateY('+ry+'deg) scale('+s+')';
  }});
  var ci=((Math.round(pos)%n)+n)%n;
  dots.forEach(function(dt,k){{dt.classList.toggle('on',k===ci);}});
 }}
 var lastStep=0;
 function frame(ts){{
  if(!lb.classList.contains('open')){{
   if(mq.matches){{
    /* Plano: avance por pasos (captura quieta y completa entre paso y paso). */
    if(!lastStep)lastStep=ts;
    if(ts-lastStep>3800){{target=Math.round(target)+1;lastStep=ts;}}
   }} else {{ target+=speed; }}
  }}
  pos+=(target-pos)*0.09; place(); raf=requestAnimationFrame(frame); }}
 function glideTo(k){{target=pos+wrap(k-pos);}}
 cards.forEach(function(c,k){{c.onclick=function(){{ if(Math.abs(wrap(k-pos))<0.6){{ li=((Math.round(pos)%n)+n)%n; lbimg.src=cards[li].querySelector('img').src; lb.classList.add('open'); }} else {{ glideTo(k); }} }};}});
 dots.forEach(function(dt,k){{dt.onclick=function(){{glideTo(k);}};}});
 function closeLb(){{lb.classList.remove('open');}}
 function lbGo(s){{li=((li+s)%n+n)%n; lbimg.src=cards[li].querySelector('img').src;}}
 document.getElementById('lbx').onclick=closeLb;
 document.getElementById('lbn').onclick=function(){{lbGo(1);}};
 document.getElementById('lbp').onclick=function(){{lbGo(-1);}};
 lb.onclick=function(e){{if(e.target===lb)closeLb();}};
 document.addEventListener('keydown',function(e){{if(!lb.classList.contains('open'))return;if(e.key==='Escape')closeLb();else if(e.key==='ArrowRight')lbGo(1);else if(e.key==='ArrowLeft')lbGo(-1);}});
 var x0=null;
 function ts(e){{x0=e.touches[0].clientX;}}
 function te(e){{if(x0===null)return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>40){{ if(lb.classList.contains('open'))lbGo(dx<0?1:-1); else glideTo(Math.round(pos)+(dx<0?1:-1)); }}x0=null;}}
 cf.addEventListener('touchstart',ts,{{passive:true}}); cf.addEventListener('touchend',te);
 lb.addEventListener('touchstart',ts,{{passive:true}}); lb.addEventListener('touchend',te);
 if(rm){{ place(); }} else {{ raf=requestAnimationFrame(frame); }}
}})();
(function(){{
 var els=[].slice.call(document.querySelectorAll('.pc[data-count]'));
 if(!els.length||window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
 var io=new IntersectionObserver(function(es){{es.forEach(function(e){{
  if(!e.isIntersecting)return; io.unobserve(e.target);
  var el=e.target, to=+el.getAttribute('data-count'), pre=el.getAttribute('data-pre')||'', t0=null;
  function step(ts){{if(!t0)t0=ts; var p=Math.min((ts-t0)/900,1); el.textContent=pre+Math.round(to*p).toLocaleString('es-AR'); if(p<1)requestAnimationFrame(step);}}
  requestAnimationFrame(step);
 }});}},{{threshold:.6}});
 els.forEach(function(el){{io.observe(el);}});
}})();
(function(){{
 var lb=document.getElementById('lb'), lbimg=document.getElementById('lbimg'); if(!lb)return;
 [].slice.call(document.querySelectorAll('.lbz')).forEach(function(im){{im.onclick=function(){{lbimg.src=im.src;lb.classList.add('open');}};}});
}})();
</script>
"""
TITLE="StockFlow — Sistema de gestión comercial simple y completo (funciona sin internet)"
DESC='StockFlow: sistema de gestión comercial para ferreterías, autoservicios y mayoristas. Stock, ventas, caja, cuentas corrientes y precios al día. Funciona sin internet. Probalo gratis 30 días.'
URL='https://bpsgsistemas.com/'
HEAD=("<meta name='viewport' content='width=device-width,initial-scale=1'>"
 f"<meta name='description' content='{DESC}'>"
 f"<link rel='canonical' href='{URL}'>"
 "<link rel='icon' type='image/png' href='/favicon.png'>"
 # Open Graph: la tarjetita con imagen cuando comparten el link por WhatsApp/redes.
 f"<meta property='og:type' content='website'><meta property='og:url' content='{URL}'>"
 f"<meta property='og:title' content='{TITLE}'>"
 f"<meta property='og:description' content='{DESC}'>"
 f"<meta property='og:image' content='{URL}og.jpg'>"
 "<meta property='og:image:width' content='1200'><meta property='og:image:height' content='630'>"
 "<meta property='og:locale' content='es_AR'>"
 "<meta name='twitter:card' content='summary_large_image'>"
 # Módulo único de tracking (Meta Pixel + GA4 + atribución + eventos). Va en el
 # <head> con defer: no bloquea el parser y ejecuta antes de DOMContentLoaded,
 # así los stubs fbq/gtag y el listener de clics existen antes de que el
 # visitante pueda interactuar.
 "<script src='js/tracking.js' defer></script>")

# Medición mínima sin servicios externos: cada clic a WhatsApp manda un beacon a

# ── Módulo de tracking (único; se sirve como js/tracking.js junto al HTML).
#    Los IDs y el número de WhatsApp bajan de la config de arriba.
TRACKING_JS = """/* StockFlow landing — tracking (generado por build_landing.py; completar IDs ahí). */
var SF_CONFIG = {
  META_PIXEL_ID: "__META__",
  GA4_MEASUREMENT_ID: "__GA4__",
  WA_NUMBER: "__WANUM__",
  WA_TEXT: "__WATEXT__"
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
"""
TRACKING_JS = (TRACKING_JS
  .replace("__META__", META_PIXEL_ID)
  .replace("__GA4__", GA4_MEASUREMENT_ID)
  .replace("__WANUM__", WA_NUM)
  .replace("__WATEXT__", WA_TEXT))
os.makedirs(os.path.join(W, 'js'), exist_ok=True)
open(os.path.join(W, 'js', 'tracking.js'), 'w').write(TRACKING_JS)

# /ev (no existe la ruta: nginx lo registra igual en el access.log del VPS).
# Contar conversiones = grep "GET /ev" /var/log/nginx/access.log
TRACK=("<script>(function(){"
 "document.querySelectorAll(\"a[href^='/dl/']\").forEach(function(el){el.addEventListener('click',function(){"
 "try{navigator.sendBeacon('/ev?e=dl&f='+encodeURIComponent((el.getAttribute('href')||'').split('/').pop()))}catch(e){}})});})();"
 "document.querySelectorAll(\"a[href^='https://wa.me']\").forEach(function(a){"
 "a.addEventListener('click',function(){try{var s=a.closest('section');"
 "navigator.sendBeacon('/ev?e=wa&s='+encodeURIComponent((s&&s.id)||'top'))}catch(e){}})});</script>")

# OG image (1200x630) + favicon, generados desde los assets reales.
def make_og():
    Wd, Hd = 1200, 630
    cv = Image.new('RGB', (Wd, Hd), '#f6f9ff')
    logo = Image.open(os.path.join(W, 'img', 'logo-full.png')).convert('RGBA')
    lw = 520
    logo2 = logo.resize((lw, round(logo.height * lw / logo.width)), Image.LANCZOS)
    cv.paste(logo2, ((Wd - lw) // 2, 44), logo2)
    shot = Image.open(os.path.join(W, 'img', 'pdv.png')).convert('RGB')
    sw = 1020
    shot2 = shot.resize((sw, round(shot.height * sw / shot.width)), Image.LANCZOS)
    top = 44 + logo2.height + 34
    cv.paste(shot2.crop((0, 0, sw, min(shot2.height, Hd - top))), ((Wd - sw) // 2, top))
    cv.save(os.path.join(W, 'og.jpg'), 'JPEG', quality=86)
    fav = Image.open(os.path.join(W, 'img', 'cube-hd.png')).convert('RGBA')
    fav.resize((64, 64), Image.LANCZOS).save(os.path.join(W, 'favicon.png'))
make_og()

# Fallback del píxel de Meta para navegadores sin JS (spec de Meta). Con el ID
# vacío el <img> no se emite: un request a /tr?id= no mide nada.
NOSCRIPT_PIXEL = (f"<noscript><img height='1' width='1' style='display:none' "
 f"src='https://www.facebook.com/tr?id={META_PIXEL_ID}&ev=PageView&noscript=1'/></noscript>" if META_PIXEL_ID else "")
open(os.path.join(W,'index3.html'),'w').write(f"<!doctype html><html lang='es'><head><meta charset='utf-8'>{HEAD}<title>{TITLE}</title><style>{CSS}</style></head><body>{NOSCRIPT_PIXEL}{BODY}</body></html>")
open(os.path.join(W,'artifact3.html'),'w').write(f"<title>{TITLE}</title><style>{CSS}</style>{BODY}")
print("index3.html:", os.path.getsize(os.path.join(W,'index3.html'))//1024,"KB")
