#!/usr/bin/env python3
# Genera HTMLs 1200x1200 para publicacion MercadoLibre de StockFlow.
import base64, os
WORK = os.path.dirname(os.path.abspath(__file__))
def b64(p):
    with open(os.path.join(WORK, p), 'rb') as f:
        return base64.b64encode(f.read()).decode()
LOGO = b64('logo.png')
SHOTS = {k: b64(f'{k}.png') for k in
         ['pdv-principal','totales-descuento','presupuestos-pdf',
          'cuentas-corrientes-detalle-cliente','contabilidad-resumen','articulos-listado']}

BASE = """<!doctype html><html><head><meta charset='utf-8'><style>
*{{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;font-family:'Segoe UI',system-ui,-apple-system,Helvetica,Arial,sans-serif;}}
html,body{{width:1200px;height:1200px;overflow:hidden;}}
.card{{width:1200px;height:1200px;background:{bg};display:flex;flex-direction:column;
  align-items:center;justify-content:{justify};padding:70px 64px;position:relative;}}
.logo{{height:74px;width:auto;}}
.kicker{{color:{accent};font-size:26px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:22px 0 8px;}}
h1{{color:#12203b;font-size:{h1};font-weight:900;line-height:1.05;text-align:center;letter-spacing:-1px;}}
h1 .hl{{color:{accent};}}
.sub{{color:#4a5568;font-size:30px;font-weight:600;text-align:center;margin-top:20px;line-height:1.35;}}
.frame{{margin-top:44px;border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(20,40,80,.28);
  border:1px solid #d6def0;max-width:1010px;background:#fff;}}
.frame .bar{{height:38px;background:#e9eefb;display:flex;align-items:center;gap:9px;padding:0 16px;}}
.frame .bar i{{width:13px;height:13px;border-radius:50%;display:inline-block;}}
.frame img{{display:block;width:100%;}}
.bullets{{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;margin-top:40px;max-width:1020px;}}
.chip{{background:#fff;border:2px solid {accent};color:#12203b;font-size:27px;font-weight:800;
  padding:14px 26px;border-radius:999px;box-shadow:0 6px 16px rgba(20,40,80,.10);}}
.badge{{position:absolute;top:0;right:0;background:{accent};color:#fff;font-size:23px;font-weight:900;
  padding:16px 30px;border-bottom-left-radius:18px;letter-spacing:1px;}}
.foot{{position:absolute;bottom:46px;color:#7a8699;font-size:24px;font-weight:700;}}
.big-icon{{font-size:150px;line-height:1;margin:10px 0 6px;}}
</style></head><body><div class='card'>{body}</div></body></html>"""

def frame(shot):
    # las capturas ya traen su propia barra de ventana -> no agregamos otra
    return f"<div class='frame'><img src='data:image/png;base64,{SHOTS[shot]}'/></div>"

def logo():
    return f"<img class='logo' src='data:image/png;base64,{LOGO}'/>"

IMAGES = {}

# 1) HERO
IMAGES['01-hero'] = dict(bg='#f4f7fe', accent='#2b6fd6', justify='center', h1='72px', body=(
    logo() +
    "<div class='kicker'>Sistema de Gestión Comercial</div>"
    "<h1>Controlá tu negocio<br><span class='hl'>sin perder plata</span></h1>"
    "<div class='sub'>Stock · Ventas · Caja · Fiado · Precios al día</div>"
    + frame('pdv-principal') +
    "<div class='foot'>Funciona en tu PC · Windows · Prueba 15 días</div>"))

# 2) PRECIOS MASIVOS (killer inflacion)
IMAGES['02-precios'] = dict(bg='#ffffff', accent='#e8590c', justify='center', h1='66px', body=(
    "<div class='badge'>INFLACIÓN</div>" + logo() +
    "<div class='kicker' style='color:#e8590c'>Actualización masiva</div>"
    "<h1>Actualizá <span class='hl' style='color:#e8590c'>TODOS</span><br>tus precios en 1 clic</h1>"
    "<div class='sub'>Subí un % a toda tu lista en segundos.<br>Nunca más precio por precio a mano.</div>"
    + frame('articulos-listado')))

# 3) SIN INTERNET
IMAGES['03-offline'] = dict(bg='#0f2038', accent='#38d39f', justify='center', h1='78px', body=(
    f"<img class='logo' style='filter:brightness(0) invert(1)' src='data:image/png;base64,{LOGO}'/>"
    "<div class='big-icon'>📴</div>"
    "<h1 style='color:#fff'>Funciona <span class='hl' style='color:#38d39f'>SIN internet</span></h1>"
    "<div class='sub' style='color:#b9c6db'>Vive en la PC de tu negocio.<br>Se corta la luz de la red y vos <b style='color:#fff'>seguís vendiendo</b>.<br>Internet solo para actualizar o AFIP.</div>"))

# 4) FIADO / cuentas corrientes
IMAGES['04-fiado'] = dict(bg='#ffffff', accent='#2b6fd6', justify='center', h1='66px', body=(
    logo() +
    "<div class='kicker'>Cuentas corrientes</div>"
    "<h1>El <span class='hl'>fiado</span>,<br>sin el cuaderno</h1>"
    "<div class='sub'>Cargá deudas, cobrá parcial y sabé quién te debe.<br>Cada peso controlado.</div>"
    + frame('cuentas-corrientes-detalle-cliente')))

# 5) TODO INCLUIDO (vs pago unico)
IMAGES['05-incluido'] = dict(bg='#f4f7fe', accent='#2b6fd6', justify='center', h1='60px', body=(
    logo() +
    "<div class='kicker'>Todo incluido</div>"
    "<h1>Se actualiza solo.<br>Siempre <span class='hl'>al día</span>.</h1>"
    "<div class='bullets'>"
    "<div class='chip'>✓ Actualizaciones gratis</div>"
    "<div class='chip'>✓ Soporte incluido</div>"
    "<div class='chip'>✓ Al día con AFIP</div>"
    "<div class='chip'>✓ Presupuestos PDF</div>"
    "<div class='chip'>✓ Backup de tus datos</div>"
    "<div class='chip'>✓ Estadísticas</div>"
    "</div>"
    "<div class='foot'>Prueba 15 días · Instalación asistida</div>"))

for name, cfg in IMAGES.items():
    html = BASE.format(**cfg)
    with open(os.path.join(WORK, f'{name}.html'), 'w') as f:
        f.write(html)
    print('wrote', name)
