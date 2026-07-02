#!/usr/bin/env python3
# Landing StockFlow v3 — modelo StockFacil, colores del sistema (azul). Self-contained.
import base64, os
W = os.path.dirname(os.path.abspath(__file__))
def b64(p): return base64.b64encode(open(p,'rb').read()).decode()
def img(n): return f"data:image/png;base64,{b64(os.path.join(W,'img',n))}"
def font(f): return base64.b64encode(open(os.path.join(W,'fonts',f),'rb').read()).decode()
PDV=img('pdv.png'); ART=img('articulos.png'); CTA_=img('ctacte.png'); PRES=img('presupuesto.png'); EST=img('estadisticas.png')
LOGO=img('logo-full.png'); CUBE=img('cube-hd.png')
WA="https://wa.me/543425847340?text=Hola!%20Quiero%20probar%20StockFlow%20en%20mi%20comercio"
CUBE_HTML=("<div class='cube3d' aria-hidden='true'><div class='c-halo'></div>"
 "<div class='c-scene'><div class='c-cube'>"
 + "".join(f"<div class='c-face {c}'><img class='c-lg' src='{CUBE}' alt=''/></div>" for c in ['cf-fr','cf-bk','cf-ri','cf-le','cf-tp','cf-bo'])
 + "</div></div><div class='c-sh'></div></div>")

GAL=[('pdv.png','Ventas — Punto de venta'),('articulos.png','Artículos y precios'),
 ('ctacte.png','Cuentas corrientes'),('presupuestos-crear.png','Presupuestos'),
 ('estadisticas.png','Estadísticas'),('caja-abierta-resumen.png','Caja diaria'),
 ('contabilidad-resumen.png','Contabilidad y Libro IVA'),('compras-principal.png','Compras'),
 ('clientes-listado.png','Clientes')]
GAL_I=[(img(f),c) for f,c in GAL]
GAL_SLIDES="".join(f"<figure class='cf-card' data-i='{k}'><div class='cwin'><div class='gbar'><span class='gdz'><i></i><i></i><i></i></span><span class='gbt'>StockFlow — {c}</span><span class='gzoom'>⤢</span></div><img loading='lazy' src='{s}' alt='{c}'/></div></figure>" for k,(s,c) in enumerate(GAL_I))
GAL_DOTS="".join(f"<button class='gdot' data-i='{k}' aria-label='Pantalla {k+1}'></button>" for k in range(len(GAL_I)))

def face(w): return (f"@font-face{{font-family:'Jak';font-style:normal;font-weight:{w};font-display:swap;"
                     f"src:url(data:font/woff2;base64,{font(f'jakarta-{w}.woff2')}) format('woff2');}}")
def face2(fam,fn,w): return (f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;"
                     f"src:url(data:font/woff2;base64,{font(fn)}) format('woff2');}}")
FONTS="".join(face(w) for w in (400,500,600,700,800))+face2('Mont','montserrat-700.woff2',700)+face2('Mont','montserrat-800.woff2',800)

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
 --jak:'Jak',system-ui,sans-serif; --disp:'Mont','Jak',system-ui,sans-serif; --wrap:1180px;
}}
*{{box-sizing:border-box;}}
html{{scroll-behavior:smooth;}}
body{{margin:0;font-family:var(--jak);color:var(--body);background:var(--paper);font-size:17px;line-height:1.6;
 -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}}
img{{max-width:100%;display:block;}} a{{color:inherit;text-decoration:none;}}
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
.nav{{position:sticky;top:0;z-index:60;background:rgba(255,255,255,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line);}}
.nav .wrap{{display:flex;align-items:center;justify-content:space-between;height:70px;gap:20px;}}
.brand-img{{height:60px;width:auto;display:block;transform:translateX(-2cm);}}
.foot-logo{{height:26px;width:auto;filter:brightness(0) invert(1);opacity:.94;}}
.nlinks{{display:flex;gap:26px;align-items:center;}}
.nlinks a{{font-weight:600;font-size:15px;color:var(--body);}} .nlinks a:hover{{color:var(--blue);}}
.nav .cta{{display:flex;gap:10px;align-items:center;}}
@media(max-width:960px){{.nlinks{{display:none;}} .nav .cta .btn-ghost{{display:none;}} .brand-img{{transform:translateX(0);height:46px;}}}}

/* HERO */
.hero{{background:radial-gradient(120% 120% at 85% 0%,var(--blue-t) 0%,#fff 55%);overflow:hidden;}}
.hero .wrap{{display:grid;grid-template-columns:1.05fr 1fr;gap:50px;align-items:start;padding:56px 24px 68px;}}
.hero .wrap>div{{min-width:0;}}
.badge{{display:inline-flex;align-items:center;gap:8px;background:var(--blue-t);color:var(--blue-d);font-weight:700;
 font-size:13.5px;padding:7px 14px;border-radius:999px;}}
.badge .st{{color:#f5a623;}}
h1.big{{font-size:clamp(36px,4.6vw,54px);margin:20px 0 0;}} h1.big .hl{{color:var(--blue);}}
.hero-title{{grid-column:1 / -1;font-family:var(--disp);font-weight:800;color:var(--ink);
 font-size:clamp(40px,6.2vw,74px);line-height:1.0;letter-spacing:-.025em;margin:0 0 2px;text-wrap:balance;}}
.hero-title b{{color:var(--blue);}}
.hero-cube{{height:clamp(240px,30vw,360px);width:auto;display:block;margin:16px 0 10px;filter:drop-shadow(0 22px 38px rgba(43,111,214,.30));image-rendering:auto;}}
.sr-only{{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}}
.lead b{{color:var(--ink);font-weight:800;}}
.hero .lead{{font-size:19px;margin-top:20px;max-width:40ch;}}
.hcta{{display:flex;gap:13px;margin-top:30px;flex-wrap:wrap;}}
.pills{{display:flex;gap:12px;margin-top:22px;flex-wrap:wrap;}}
.pill{{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--line);background:#fff;border-radius:999px;
 padding:9px 16px;font-weight:600;font-size:14px;color:var(--ink);}}
.pill svg{{width:16px;height:16px;color:var(--blue);}}
.trust{{display:flex;align-items:center;gap:12px;margin-top:24px;font-size:14px;color:var(--body);}}
.trust .wa-c{{width:34px;height:34px;border-radius:50%;background:var(--wa);color:#053d1c;display:grid;place-items:center;}}
.trust .wa-c svg{{width:19px;height:19px;}}
.shot{{border-radius:14px;overflow:hidden;border:1px solid var(--line);box-shadow:0 30px 60px rgba(20,40,80,.18);background:#fff;}}
.hero .shotwrap{{position:relative;}}
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
@media(max-width:960px){{.hero .wrap{{grid-template-columns:1fr;gap:40px;padding:44px 24px 60px;}} .cube3d{{transform:scale(.76);top:-38px;right:-6px;}}}}
@media(prefers-reduced-motion:reduce){{.c-scene,.c-cube,.c-sh{{animation:none!important;}} .c-cube{{transform:rotateX(-24deg) rotateY(-34deg);}}}}

/* STATS */
.stats{{border-top:1px solid var(--line);border-bottom:1px solid var(--line);}}
.stats .wrap{{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;padding:34px 24px;}}
.stat{{text-align:center;border-left:1px solid var(--line);}} .stat:first-child{{border-left:0;}}
.stat .n{{font-weight:800;color:var(--blue);font-size:34px;letter-spacing:-.02em;}}
.stat .l{{font-size:14px;color:var(--body);margin-top:2px;}}
@media(max-width:700px){{.stats .wrap{{grid-template-columns:1fr 1fr;gap:24px 12px;}} .stat:nth-child(3){{border-left:0;}}}}

/* SECTION */
.sec{{padding:88px 0;}}
.sec-h{{text-align:center;max-width:660px;margin:0 auto 52px;}}
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
.show{{display:grid;grid-template-columns:1fr 1fr;gap:34px 50px;align-items:center;}}
.show+.show{{margin-top:60px;}} .show.rev .st{{order:2;}} .show.rev .si{{order:1;}}
.show h3{{font-size:clamp(23px,2.6vw,30px);}} .show .k{{color:var(--blue);font-weight:700;font-size:14px;}}
.show p{{margin-top:12px;font-size:16.5px;max-width:44ch;}}
.show ul{{list-style:none;padding:0;margin:16px 0 0;display:flex;flex-direction:column;gap:10px;}}
.show li{{display:flex;gap:10px;font-size:15.5px;color:var(--ink);}} .show li svg{{width:20px;height:20px;color:var(--green);flex:none;}}
@media(max-width:840px){{.show{{grid-template-columns:1fr;gap:22px;}} .show.rev .st{{order:1;}} .show.rev .si{{order:2;}}}}

/* COMPARATIVA */
.cmp{{overflow-x:auto;}} .cmp table{{width:100%;border-collapse:collapse;min-width:560px;background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;}}
.cmp th,.cmp td{{padding:15px 18px;text-align:left;border-bottom:1px solid var(--line);font-size:15px;}}
.cmp thead th{{font-size:13px;text-transform:uppercase;letter-spacing:.04em;background:var(--soft);color:var(--ink);}}
.cmp thead th.us{{background:var(--blue);color:#fff;}}
.cmp td.f{{font-weight:600;color:var(--ink);}} .cmp td.us{{background:var(--blue-t2);font-weight:700;color:var(--ink);}}
.cmp .y{{color:var(--green);font-weight:700;}} .cmp .n{{color:#c2453b;}} .cmp tr:last-child td{{border-bottom:0;}}

/* PRECIO */
.price{{background:var(--ink);color:#fff;border-radius:22px;padding:46px;display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center;}}
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
.final{{background:linear-gradient(120% 120% at 100% 0%,var(--blue-d),var(--blue));color:#fff;text-align:center;}}
.final h2{{color:#fff;font-size:clamp(28px,3.6vw,42px);}} .final p{{color:#dbe6fb;font-size:18px;margin:14px auto 0;max-width:48ch;}}
.final .row{{display:flex;gap:13px;justify-content:center;margin-top:28px;flex-wrap:wrap;align-items:center;}}
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
.cfbox{{width:100%;}}
.cfrow{{position:relative;height:480px;margin-top:14px;}}
.cf{{position:relative;width:100%;height:100%;perspective:1700px;}}
.cf-card{{position:absolute;top:50%;left:50%;width:min(90%,560px);
 transform:translate(-50%,-50%);transform-origin:center center;backface-visibility:hidden;cursor:pointer;
 transition:none;will-change:transform,opacity;}}
.cwin{{border-radius:12px;overflow:hidden;border:1px solid var(--line);box-shadow:0 24px 50px rgba(20,40,80,.30);background:#fff;}}
.cf-card img{{width:100%;display:block;}}
.cfrow .gnav{{position:absolute;top:50%;transform:translateY(-50%);z-index:130;}}
.cfrow .gnav.prev{{left:-6px;}} .cfrow .gnav.next{{right:-6px;}}
.gzoom{{font-size:14px;color:#9fb3d8;}}
@media(max-width:960px){{.cfrow{{height:380px;}} .cf-card{{width:min(88%,500px);}}}}
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
.rv{{opacity:0;transform:translateY(16px);transition:opacity .5s,transform .5s;}} .rv.in{{opacity:1;transform:none;}}
@media(prefers-reduced-motion:reduce){{.rv{{opacity:1;transform:none;}} html{{scroll-behavior:auto;}}}}
"""

def chk(): return "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'><path d='M5 12l4.5 4.5L19 7'/></svg>"
def shot(t,s,a): return (f"<figure class='shot'><img loading='lazy' src='{s}' alt='{a}'/></figure>")

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
 <a href="#top" aria-label="StockFlow"><img class="brand-img" src="{LOGO}" alt="StockFlow"/></a>
 <div class="nlinks"><a href="#why">Beneficios</a><a href="#func">Funciones</a><a href="#comp">Comparación</a><a href="#precio">Precio</a><a href="#faq">Preguntas</a></div>
 <div class="cta"><a class="btn btn-ghost" href="#precio">Probar</a><a class="btn btn-wa" href="{WA}" target="_blank" rel="noopener">{WA_SVG}WhatsApp</a></div>
</div></nav>

<header class="hero" id="top"><div class="wrap">
 <h1 class="hero-title">Sistema de Gestión <b>Comercial</b></h1>
 <div>
  <img class="hero-cube" src="{CUBE}" alt="StockFlow — Sistema de Gestión Comercial"/>
  <p class="lead"><b>Controlá tu comercio de punta a punta.</b> Ventas, stock, caja, clientes y precios siempre al día, en una sola PC. Comprobantes en regla y todo funcionando aunque se corte internet.</p>
  <div class="hcta"><a class="btn btn-blue" href="#precio">Probar por {money("5.000")}</a><a class="btn btn-ghost" href="#func">Ver funciones</a></div>
  <div class="pills"><span class="pill">{G['wifi']} Funciona sin internet</span><span class="pill">{G['refresh']} Se actualiza solo</span><span class="pill">{G['shield']} Al día con AFIP</span></div>
  <div class="trust"><span class="wa-c">{WA_SVG}</span><span>Instalación asistida y <b>soporte real</b> por WhatsApp. Probalo 15 días en tu comercio.</span></div>
 </div>
 <div class="shotwrap rv">
  <div class="cfbox">
   <div class="cfrow">
    <div class="cf" id="cf">{GAL_SLIDES}</div>
   </div>
   <div class="gdots" id="gdots">{GAL_DOTS}</div>
  </div>
 </div>
</div></header>

<div class="stats"><div class="wrap">
 <div class="stat"><div class="n">100%</div><div class="l">Funciona sin internet</div></div>
 <div class="stat"><div class="n">1 clic</div><div class="l">Actualizás todos los precios</div></div>
 <div class="stat"><div class="n">A4</div><div class="l">Presupuestos y comprobantes</div></div>
 <div class="stat"><div class="n">$&#8202;5.000</div><div class="l">Probalo 15 días</div></div>
</div></div>

<section class="sec" id="why"><div class="wrap">
 <div class="sec-h"><div class="eyebrow">Beneficios</div><h2>Diseñado para que vendas, no para pelearte con un sistema.</h2></div>
 <div class="whys">
  <div class="why rv"><div class="ic" style="background:var(--blue)">{G['bolt']}</div><h3>Simple e intuitivo</h3><p>En minutos ya estás cargando productos y vendiendo. Pensado para el mostrador.</p></div>
  <div class="why rv"><div class="ic" style="background:var(--green)">{G['wifi']}</div><h3>Funciona sin internet</h3><p>Vive en tu PC. Se corta la red y seguís vendiendo igual, sin frenar la caja.</p></div>
  <div class="why rv"><div class="ic" style="background:var(--coral)">{G['tag']}</div><h3>Precios al día con la inflación</h3><p>Actualizás toda tu lista con un porcentaje, en un solo clic. Nunca más a mano.</p></div>
  <div class="why rv"><div class="ic" style="background:var(--indigo)">{G['shield']}</div><h3>Todo incluido</h3><p>Actualizaciones, soporte y AFIP al día, siempre. Sin pagar extra por cada mejora.</p></div>
 </div>
</div></section>

<section class="sec func" id="func"><div class="wrap">
 <div class="sec-h"><div class="eyebrow">Funcionalidades</div><h2>Todo tu negocio en un solo lugar.</h2><p>Un sistema completo para gestionar artículos, ventas, caja, clientes y estadísticas — sin complicarte.</p></div>
 <div class="fgrid">
  {"".join(f'<div class="fitem rv"><span class="ic">{G[i]}</span><div><h4>{t}</h4><p>{d}</p></div></div>' for i,t,d in FEATURES)}
 </div>
</div></section>

<section class="sec func" id="comp"><div class="wrap">
 <div class="sec-h"><div class="eyebrow">La diferencia</div><h2>Pagás una vez… ¿y después quién lo mantiene?</h2><p>El “pago único” parece más barato hasta que queda viejo y AFIP cambia. Nosotros lo mantenemos siempre.</p></div>
 <div class="cmp rv"><table><thead><tr><th>Lo que necesitás</th><th class="us">StockFlow</th><th>Sistema pago único</th></tr></thead><tbody>
  {"".join(f'<tr><td class="f">{f}</td><td class="us"><span class="y">{u}</span></td><td><span class="{c}">{t}</span></td></tr>' for f,u,t,c in [
    ("Actualizaciones nuevas","Gratis, siempre","Se pagan aparte","n"),
    ("Al día con AFIP cuando cambia","Incluido","Comprás la versión nueva","n"),
    ("Soporte cuando lo necesitás","Incluido","Limitado o pago","n"),
    ("Funciona sin internet","Sí","A veces","f"),
    ("Actualización masiva de precios","Sí","Depende","f"),
    ("Para arrancar","Probás por $ 5.000","Desembolso grande","n"),
    ("Riesgo de quedar obsoleto","Ninguno","Alto","n"),
  ])}
 </tbody></table></div>
</div></section>

<section class="sec" id="precio"><div class="wrap">
 <div class="sec-h"><div class="eyebrow">Precio claro</div><h2>Un precio, todo adentro.</h2></div>
 <div class="price rv">
  <div><h2>Suscripción · todo incluido</h2>
   <div class="amt mny"><small>$</small>&#8202;70.000<small>/mes</small></div>
   <div class="demo">Demo <b>$ 5.000</b> — prueba 15 días + instalación (se descuenta del primer mes).</div></div>
  <div><ul>
    <li>{chk()}Actualizaciones y mejoras nuevas, gratis</li>
    <li>{chk()}Soporte incluido por WhatsApp</li>
    <li>{chk()}Siempre al día con AFIP</li>
    <li>{chk()}Todos los módulos: ventas, stock, caja, cuentas corrientes, presupuestos</li></ul>
   <div class="anchor">Un solo faltante de stock o una cuenta sin cobrar por mes ya cuesta más de $ 70.000.</div>
   <a class="btn btn-blue" href="{WA}" target="_blank" rel="noopener" style="width:100%;justify-content:center">{WA_SVG}Empezar por {money("5.000")}</a></div>
 </div>
</div></section>

<section class="sec func" id="faq"><div class="wrap">
 <div class="sec-h"><div class="eyebrow">Preguntas frecuentes</div><h2>Lo que todos preguntan.</h2></div>
 <div class="faq rv">
  {"".join(f'<details><summary>{q}</summary><div class="a">{a}</div></details>' for q,a in [
   ("¿Necesito internet para usarlo?","No. StockFlow vive en tu PC y funciona 100% offline. Internet solo se usa para actualizaciones o AFIP. Si se corta, seguís vendiendo."),
   ("¿Mis datos quedan en mi PC?","Sí. Tus datos son tuyos y viven en tu computadora. El sistema hace backups que guardás donde quieras."),
   ("¿Por qué suscripción y no pago único?","Porque incluye todo: actualizaciones, soporte y estar al día con AFIP. El pago único te deja clavado en una versión vieja y, cuando cambian las reglas, pagás de nuevo."),
   ("¿Incluye la instalación?","Sí. Te lo dejamos instalado y andando con tus productos. La prueba de $ 5.000 incluye la instalación asistida."),
   ("¿Qué pasa si dejo de pagar?","El sistema pasa a solo lectura: ves tu información pero no cargás nuevas ventas. No perdés nada; al renovar vuelve a funcionar completo."),
   ("¿Para qué comercios es?","Para comercios que facturan en serio: ferreterías, corralones, autoservicios, mayoristas, distribuidoras y repuestos."),
  ])}
 </div>
</div></section>

<section class="sec final"><div class="wrap">
 <h2>Probá StockFlow en tu comercio.</h2>
 <p>Instalación asistida, prueba completa por 15 días y soporte de verdad.</p>
 <div class="row"><a class="btn btn-wa" href="{WA}" target="_blank" rel="noopener" style="font-size:17px;padding:16px 30px">{WA_SVG}Escribinos por WhatsApp</a><span class="num">+54 342 584 7340</span></div>
</div></section>

<footer class="foot"><div class="wrap">
 <a href="#top" aria-label="StockFlow"><img class="brand-img foot-logo" src="{LOGO}" alt="StockFlow"/></a>
 <small>Un producto de BPSG Sistemas · Santa Fe, Argentina · Windows · funciona sin internet</small>
 <div style="display:flex;gap:20px"><a href="{WA}" target="_blank" rel="noopener">WhatsApp</a><a href="mailto:bruno.martin.pasquetta@gmail.com">Email</a></div>
</div></footer>

<div class="mbar"><a class="btn btn-ghost" href="#precio">Precio</a><a class="btn btn-wa" href="{WA}" target="_blank" rel="noopener">{WA_SVG}WhatsApp</a></div>

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
 function wrap(d){{while(d>n/2)d-=n; while(d<-n/2)d+=n; return d;}}
 function place(){{
  cards.forEach(function(c,k){{
   var d=wrap(k-pos), ad=Math.abs(d);
   var x=d*45, z=-ad*205, ry=-d*32, s=Math.max(.4,1-ad*0.17), op=Math.max(0,1-ad*0.42);
   c.style.opacity=''+op; c.style.pointerEvents=(ad<2?'auto':'none'); c.style.zIndex=''+Math.round(100-ad*10);
   c.style.transform='translate(-50%,-50%) translateX('+x+'%) translateZ('+z+'px) rotateY('+ry+'deg) scale('+s+')';
  }});
  var ci=((Math.round(pos)%n)+n)%n;
  dots.forEach(function(dt,k){{dt.classList.toggle('on',k===ci);}});
 }}
 function frame(){{ if(!lb.classList.contains('open')) target+=speed; pos+=(target-pos)*0.09; place(); raf=requestAnimationFrame(frame); }}
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
</script>
"""
TITLE="StockFlow — Sistema de gestión comercial simple y completo (funciona sin internet)"
HEAD=("<meta name='viewport' content='width=device-width,initial-scale=1'>"
 "<meta name='description' content='StockFlow: sistema de gestión comercial para ferreterías, autoservicios y mayoristas. Stock, ventas, caja, cuentas corrientes y precios al día. Funciona sin internet. Probalo 15 días.'>")
open(os.path.join(W,'index3.html'),'w').write(f"<!doctype html><html lang='es'><head><meta charset='utf-8'>{HEAD}<title>{TITLE}</title><style>{CSS}</style></head><body>{BODY}</body></html>")
open(os.path.join(W,'artifact3.html'),'w').write(f"<title>{TITLE}</title><style>{CSS}</style>{BODY}")
print("index3.html:", os.path.getsize(os.path.join(W,'index3.html'))//1024,"KB")
