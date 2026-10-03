#!/usr/bin/env python3
"""Reemplazo CONSISTENTE de datos personales en fixtures/tests/tools de facturas.
Texto plano: no reformatea JSON, no toca coordenadas. Informa cuentas por archivo."""
import glob, os, re, sys

RAIZ = '/Users/brunopasquetta/dev/stockflow'
MAPA = [
    # personas (orden: las cadenas más largas primero)
    ('MARQUEZ NICOLAS - RESTOBAR', 'PEREZ JUAN - RESTOBAR'),
    ('MARQUEZ NICOLAS MARTIN', 'PEREZ JUAN CARLOS'),
    ('NICOLAS MARTIN', 'JUAN CARLOS'),
    ('AVALO JOSE IGNACIO', 'GOMEZ LUIS ALBERTO'),
    ('Rocio Belén Tabisi', 'Maria Laura Fernandez'),
    ('Tabisi Rocio', 'Fernandez Maria'),
    ('Rocio Tabisi', 'Maria Fernandez'),
    ('Razon Social: Rocio', 'Razon Social: Maria'),   # caja partida del lector de Windows
    # domicilios
    ('25 DE MAYO 1092', 'SAN MARTIN 456'),
    ('JUAN DE GARAY 1847', 'BELGRANO 1234'),
    ('AV.H.LOPEZ 1900 (COSTANERA)', 'AV. RIVADAVIA 2500'),
    # CUIT / DNI (dígito verificador correcto, módulo 11)
    ('20-36052029-4', '20-24681357-5'), ('20360520294', '20246813575'),
    ('20-38289686-7', '20-25836941-7'), ('20382896867', '20258369417'),
    ('27-40959864-7', '27-24815936-2'), ('27409598648', '27248159363'), ('27409598647', '27248159362'),
    ('22665231', '23178456'),
]

archivos = sorted(
    glob.glob(f'{RAIZ}/apps/desktop/electron/__tests__/fixtures/facturas/**/*.txt', recursive=True)
    + glob.glob(f'{RAIZ}/apps/desktop/electron/__tests__/fixtures/facturas/**/*.json', recursive=True)
    + glob.glob(f'{RAIZ}/apps/desktop/electron/__tests__/facturas*.smoke.ts')
    + [f'{RAIZ}/tools/ocr-facturas/{n}' for n in ('hallazgos-r2.json', 'RESULTADOS.md', 'verdad.py')]
)

total = {}
for ruta in archivos:
    with open(ruta, encoding='utf-8', newline='') as f:
        orig = f.read()
    txt = orig
    cuentas = []
    for de, a in MAPA:
        n = txt.count(de)
        if n:
            txt = txt.replace(de, a)
            cuentas.append(f'{de!r}×{n}')
    if ruta.endswith('facturas.smoke.ts'):
        n = len(re.findall(r'\btabisi\b', txt))
        if n:
            txt = re.sub(r'\btabisi\b', 'fernandez', txt)
            cuentas.append(f'identificador tabisi×{n}')
    if txt != orig:
        with open(ruta, 'w', encoding='utf-8', newline='') as f:
            f.write(txt)
        rel = os.path.relpath(ruta, RAIZ)
        total[rel] = cuentas
        print(f'{rel}\n    ' + '\n    '.join(cuentas))

print(f'\n{len(total)} archivos modificados')
