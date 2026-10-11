#!/usr/bin/env python3
"""
Variante para fondo oscuro de los PNG de marca: el isotipo queda igual y el
TEXTO cambia de color para que se lea sobre oscuro:
  «Stock»  azul marino #0B2660 → casi blanco
  «Flow»   azul #1B52CC        → azul más claro
  tagline / © grises           → gris claro
Las letras tienen color pleno y el antialias está en el alpha, así que basta
clasificar cada píxel por su color y reemplazarlo; el alpha no se toca.

Uso: marca-oscura.py <in.png> <out.png>
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np
from PIL import Image

aqui = Path(__file__).parent
spec = importlib.util.spec_from_file_location('ll', aqui / 'repintar-isotipo.py')
ll = importlib.util.module_from_spec(spec); spec.loader.exec_module(ll)

CLARO = np.array([0xE9, 0xEE, 0xFF])      # «Stock»
AZUL_CLARO = np.array([0x6B, 0x97, 0xFF])  # «Flow»
GRIS_CLARO = np.array([0xA8, 0xB2, 0xC8])  # tagline y ©


def oscurecer(src: str, dst: str) -> None:
    a = np.array(Image.open(src).convert('RGBA'))
    x0, y0, x1, y1 = ll.caja_del_isotipo(a[..., 3], 'auto')
    texto = np.ones(a.shape[:2], dtype=bool)
    texto[y0:y1, x0:x1] = False  # el isotipo no se toca
    con_tinta = texto & (a[..., 3] > 0)
    r, g, b = (a[..., i].astype(int) for i in range(3))
    lum = (r + g + b) / 3
    marino = con_tinta & (b < 130) & (r < 60)
    azul = con_tinta & (b >= 130) & (r < 90)
    gris = con_tinta & ~marino & ~azul & (np.abs(r - g) < 25) & (np.abs(g - b) < 45)
    for m, c in ((marino, CLARO), (azul, AZUL_CLARO), (gris, GRIS_CLARO)):
        a[m, :3] = c
    resto = con_tinta & ~marino & ~azul & ~gris
    print(f'{src}: marino {int(marino.sum())}, azul {int(azul.sum())}, gris {int(gris.sum())}, sin clasificar {int(resto.sum())}')
    Image.fromarray(a, 'RGBA').save(dst, optimize=True)


if __name__ == '__main__':
    oscurecer(sys.argv[1], sys.argv[2])
