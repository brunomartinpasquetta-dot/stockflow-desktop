#!/usr/bin/env python3
# Portadas estilo StockFacil (monitor con marca en pantalla), una por rubro, 1200x1200.
import base64, os
WORK = os.path.dirname(os.path.abspath(__file__))
LOGO = base64.b64encode(open(os.path.join(WORK,'logo.png'),'rb').read()).decode()

RUBROS = {
  'ferreteria':   ('Ferretería y Corralón', '🔧'),
  'autoservicio': ('Autoservicio y Minimarket', '🛒'),
  'mayorista':    ('Mayorista y Distribuidora', '📦'),
  'repuestos':    ('Repuestos y Autopartes', '⚙️'),
  'indumentaria': ('Indumentaria y Calzado', '👕'),
  'punto-venta':  ('Punto de Venta', '🧾'),
}

HTML = """<!doctype html><html><head><meta charset='utf-8'><style>
*{{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;}}
html,body{{width:1200px;height:1200px;}}
.card{{width:1200px;height:1200px;background:#ffffff;display:flex;flex-direction:column;
  align-items:center;justify-content:center;position:relative;padding:60px;}}
.ribbon{{position:absolute;top:38px;left:-58px;transform:rotate(-45deg);background:#e8590c;color:#fff;
  font-weight:900;font-size:26px;letter-spacing:2px;padding:14px 80px;box-shadow:0 6px 14px rgba(0,0,0,.18);}}
/* iMac */
.imac{{display:flex;flex-direction:column;align-items:center;}}
.bezel{{background:linear-gradient(#3a3f47,#23262c);padding:20px 20px 0;border-radius:26px 26px 0 0;
  box-shadow:0 30px 70px rgba(20,40,80,.30);}}
.screen{{width:812px;height:512px;border-radius:8px;overflow:hidden;
  background:radial-gradient(120% 120% at 30% 10%,#3f86ff 0%,#2b6fd6 42%,#12439e 100%);
  display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0;position:relative;}}
.screen::after{{content:'';position:absolute;inset:0;background:linear-gradient(115deg,rgba(255,255,255,.18),rgba(255,255,255,0) 40%);}}
.logo{{height:120px;filter:brightness(0) invert(1);z-index:1;}}
.tag{{color:rgba(255,255,255,.9);font-size:24px;font-weight:800;letter-spacing:5px;margin-top:14px;z-index:1;}}
.rubropill{{margin-top:30px;background:rgba(255,255,255,.16);border:2px solid rgba(255,255,255,.55);
  color:#fff;font-size:30px;font-weight:800;padding:14px 34px;border-radius:999px;z-index:1;
  display:flex;gap:12px;align-items:center;}}
.chin{{width:852px;height:66px;background:linear-gradient(#e3e6ea,#c3c8d0);border-radius:0 0 22px 22px;
  display:flex;align-items:center;justify-content:center;box-shadow:0 20px 40px rgba(20,40,80,.16);}}
.chin .apple{{width:16px;height:16px;border-radius:50%;background:#9aa2ad;}}
.neck{{width:150px;height:90px;background:linear-gradient(#d7dbe1,#b7bcc6);clip-path:polygon(20% 0,80% 0,100% 100%,0 100%);}}
.foot{{width:340px;height:20px;background:linear-gradient(#c3c8d0,#aeb4be);border-radius:0 0 40px 40px;}}
.title{{margin-top:54px;color:#12203b;font-size:56px;font-weight:900;text-align:center;letter-spacing:-1px;}}
.title b{{color:#2b6fd6;}}
.subline{{margin-top:16px;color:#5a6678;font-size:30px;font-weight:700;text-align:center;}}
.foot2{{position:absolute;bottom:40px;color:#8a95a6;font-size:24px;font-weight:800;letter-spacing:.5px;}}
</style></head><body><div class='card'>
  <div class='ribbon'>PROBALO</div>
  <div class='imac'>
    <div class='bezel'><div class='screen'>
      <img class='logo' src='data:image/png;base64,{logo}'/>
      <div class='tag'>SISTEMA DE GESTIÓN COMERCIAL</div>
      <div class='rubropill'><span>{emoji}</span> {rubro}</div>
    </div></div>
    <div class='chin'><div class='apple'></div></div>
    <div class='neck'></div><div class='foot'></div>
  </div>
  <div class='title'>Software de gestión<br>para <b>{rubro_short}</b></div>
  <div class='subline'>Stock · Ventas · Caja · Fiado · Precios al día</div>
  <div class='foot2'>FUNCIONA SIN INTERNET · WINDOWS</div>
</div></body></html>"""

for slug,(rubro,emoji) in RUBROS.items():
    short = rubro.split(' y ')[0].split(' / ')[0]
    html = HTML.format(logo=LOGO, emoji=emoji, rubro=rubro, rubro_short=short)
    open(os.path.join(WORK, f'rubro-{slug}.html'),'w').write(html)
    print('wrote', slug)
