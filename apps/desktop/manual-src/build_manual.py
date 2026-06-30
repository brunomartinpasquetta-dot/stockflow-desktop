#!/usr/bin/env python3
"""Genera manual.html a partir de sections.json (estructura del workflow) + capturas en shots/.
Uso: python3 build_manual.py <sections.json> <out.html> <version> <logo_b64_path>
"""
import json, sys, os, html, base64

sections_path, out_path, version = sys.argv[1], sys.argv[2], sys.argv[3]
logo_path = sys.argv[4] if len(sys.argv) > 4 else ''
shots_dir = os.path.join(os.path.dirname(out_path), 'shots')

ORDER = ['intro', 'articulos', 'clientes-proveedores', 'ventas', 'presupuestos',
         'compras', 'caja', 'cuentas-corrientes', 'precios-conta-estad',
         'configuracion', 'licencia']

data = json.load(open(sections_path))
secs = data['sections'] if isinstance(data, dict) else data
by_id = {s['id']: s for s in secs if s}
ordered = [by_id[i] for i in ORDER if i in by_id] + [s for s in secs if s and s['id'] not in ORDER]

def esc(t): return html.escape(str(t))

def img_tag(shot_id, caption):
    """Sólo emite la figura si EXISTE la captura; si no, no muestra nada."""
    p = os.path.join(shots_dir, f'{shot_id}.png')
    if not os.path.exists(p):
        return ''
    b64 = base64.b64encode(open(p, 'rb').read()).decode()
    return (f'<figure><img src="data:image/png;base64,{b64}" alt="{esc(caption)}"/>'
            f'<figcaption>{esc(caption)}</figcaption></figure>')

logo_html = ''
if logo_path and os.path.exists(logo_path):
    b64 = base64.b64encode(open(logo_path, 'rb').read()).decode()
    logo_html = f'<img class="cover-logo" src="data:image/png;base64,{b64}"/>'

CSS = """
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, -apple-system, Helvetica, Arial, sans-serif; color: #1f2430; font-size: 10.5pt; line-height: 1.5; margin: 0; }
h1,h2,h3 { color: #1b2a4a; line-height: 1.25; }
.cover { height: 247mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; page-break-after: always; }
.cover-logo { width: 120px; height: auto; margin-bottom: 18px; }
.cover h1 { font-size: 30pt; margin: 6px 0 2px; letter-spacing: .5px; }
.cover .sub { font-size: 13pt; color: #5b6478; }
.cover .ver { margin-top: 26px; font-size: 11pt; color: #2b6fd6; font-weight: 600; }
.cover .foot { position: absolute; bottom: 14mm; font-size: 9pt; color: #8a8a93; }
.toc { page-break-after: always; }
.toc h2 { border-bottom: 2px solid #2b6fd6; padding-bottom: 6px; }
.toc ol { font-size: 11pt; line-height: 2; padding-left: 20px; }
.toc a { color: #1b2a4a; text-decoration: none; }
section.module { page-break-before: always; }
section.module > h2 { font-size: 18pt; border-bottom: 2px solid #2b6fd6; padding-bottom: 6px; margin-bottom: 4px; }
.modnum { color: #2b6fd6; }
.overview { font-size: 11pt; color: #3a4256; background: #f3f6fc; border-left: 4px solid #2b6fd6; padding: 8px 12px; border-radius: 4px; margin: 10px 0 14px; }
h3 { font-size: 12.5pt; margin: 16px 0 6px; }
p { margin: 6px 0; }
ol.steps { margin: 6px 0 6px 0; padding-left: 22px; }
ol.steps li { margin: 4px 0; }
.tips { margin: 10px 0; }
.tip { display: flex; gap: 8px; background: #fff8e6; border: 1px solid #f0d98a; border-radius: 6px; padding: 7px 10px; margin: 5px 0; font-size: 10pt; }
.tip::before { content: "💡"; }
figure { margin: 12px 0; page-break-inside: avoid; text-align: center; }
figure img { max-width: 100%; border: 1px solid #d6dae3; border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
figcaption { font-size: 9pt; color: #6b7280; margin-top: 5px; font-style: italic; }
.shot-missing { border: 1px dashed #c3c8d2; color: #9aa0ab; padding: 30px; border-radius: 6px; font-size: 9pt; }
a { color: inherit; }
"""

parts = [f"<!doctype html><html lang='es'><head><meta charset='utf-8'><title>Manual StockFlow</title><style>{CSS}</style></head><body>"]

# Cover
parts.append(f"""<div class="cover">{logo_html}
<h1>StockFlow</h1>
<div class="sub">Sistema de Gestión Comercial</div>
<div class="sub" style="margin-top:18px;font-size:16pt;color:#1b2a4a;font-weight:600;">Manual de Usuario</div>
<div class="ver">Versión {esc(version)}</div>
<div class="foot">© 2026 · Crafted by BPSG</div>
</div>""")

# TOC
parts.append("<div class='toc'><h2>Índice</h2><ol>")
for i, s in enumerate(ordered, 1):
    parts.append(f"<li><a href='#sec-{esc(s['id'])}'>{esc(s['title'])}</a></li>")
parts.append("</ol></div>")

# Sections
for i, s in enumerate(ordered, 1):
    parts.append(f"<section class='module' id='sec-{esc(s['id'])}'>")
    parts.append(f"<h2><span class='modnum'>{i}.</span> {esc(s['title'])}</h2>")
    if s.get('overview'):
        parts.append(f"<div class='overview'>{esc(s['overview'])}</div>")
    # lead screenshot (first) right after overview.
    # Orden estable: las capturas QUE EXISTEN van primero → el lead siempre es
    # una imagen real cuando hay alguna; las faltantes quedan al final (se omiten).
    shots = list(s.get('screenshots', []))
    shots.sort(key=lambda sh: 0 if os.path.exists(os.path.join(shots_dir, f"{sh['id']}.png")) else 1)
    if shots:
        parts.append(img_tag(shots[0]['id'], shots[0]['caption']))
    for sub in s.get('subsections', []):
        parts.append(f"<h3>{esc(sub['heading'])}</h3>")
        for p in sub.get('paragraphs', []):
            parts.append(f"<p>{esc(p)}</p>")
        if sub.get('steps'):
            parts.append("<ol class='steps'>")
            for st in sub['steps']:
                parts.append(f"<li>{esc(st)}</li>")
            parts.append("</ol>")
        if sub.get('tips'):
            parts.append("<div class='tips'>")
            for tp in sub['tips']:
                parts.append(f"<div class='tip'><span>{esc(tp)}</span></div>")
            parts.append("</div>")
    # remaining screenshots
    for sh in shots[1:]:
        parts.append(img_tag(sh['id'], sh['caption']))
    parts.append("</section>")

parts.append("</body></html>")
open(out_path, 'w').write('\n'.join(parts))
print('wrote', out_path, 'sections:', len(ordered))
print('shots referenced:', sum(len(s.get('screenshots', [])) for s in ordered))
