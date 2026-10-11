#!/usr/bin/env python3
"""
Vuelve a pintar el isotipo de StockFlow (el cubo SF) sobre su misma silueta,
sin los defectos del render 3D original: filetes claros irregulares en los
bordes, sombra negra pegada al contorno y halo semitransparente alrededor.
Sólo se toca el recuadro del isotipo; el texto de cada PNG queda igual.

Variantes:
  A  «relieve»: conserva el sombreado de las caras; la franja de B px pegada
     al borde se rellena con el color de más adentro (se van filetes y sombra).
  B  «plano»: azul con degradé diagonal suave, como el ícono del escritorio.

Uso:
  logo-limpio.py variantes <in.png> <dir>          → A.png, B.png y láminas
  logo-limpio.py aplicar <A|B> <in.png> <out.png> [--caja auto|todo|x0,y0,x1,y1]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# Degradé de la variante B: alrededor del azul dominante del original (#1750CA).
C1 = np.array([0x2A, 0x66, 0xF0], dtype=np.float32)  # arriba-izquierda
C2 = np.array([0x12, 0x3E, 0xB0], dtype=np.float32)  # abajo-derecha
FONDO_OSCURO = (11, 16, 32)


def _corridas(ocupado: np.ndarray) -> list[tuple[int, int]]:
    """Tramos [inicio, fin) consecutivos con algo pintado."""
    out, i, n = [], 0, len(ocupado)
    while i < n:
        if ocupado[i]:
            j = i
            while j < n and ocupado[j]:
                j += 1
            out.append((i, j)); i = j
        else:
            i += 1
    return out


def caja_del_isotipo(al: np.ndarray, modo: str) -> tuple[int, int, int, int]:
    """El isotipo es el primer bloque grande; el texto, el siguiente bloque
    grande (abajo si el PNG es vertical, a la derecha si es horizontal). Las
    motas sueltas que haya entre medio quedan DENTRO de la caja, para quitarlas."""
    h, w = al.shape
    if modo == 'todo':
        return 0, 0, w, h
    if modo != 'auto':
        x0, y0, x1, y1 = (int(v) for v in modo.split(','))
        return x0, y0, x1, y1
    vertical = h > w
    ocupado = (al > 0).any(axis=1 if vertical else 0)
    largo = h if vertical else w
    corridas = _corridas(ocupado)
    fin = largo
    vistos_el_isotipo = False
    for ini, f in corridas:
        if f - ini > largo * 0.03:
            if vistos_el_isotipo:
                fin = ini; break
            vistos_el_isotipo = True
    return (0, 0, w, fin) if vertical else (0, 0, fin, h)


def img_l(m: np.ndarray) -> Image.Image:
    return Image.fromarray(m.astype(np.uint8))


def quitar_motas(mascara: np.ndarray, area_min: int) -> np.ndarray:
    """Saca los pedacitos sueltos de menos de `area_min` píxeles (polvo del recorte)."""
    from collections import deque
    h, w = mascara.shape
    visto = np.zeros_like(mascara, dtype=bool)
    out = mascara.copy()
    for y0, x0 in zip(*np.nonzero(mascara)):
        if visto[y0, x0]:
            continue
        cola, comp = deque([(y0, x0)]), []
        visto[y0, x0] = True
        while cola:
            y, x = cola.popleft(); comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mascara[ny, nx] and not visto[ny, nx]:
                    visto[ny, nx] = True; cola.append((ny, nx))
        if len(comp) < area_min:
            for y, x in comp:
                out[y, x] = False
            print(f'   mota quitada: {len(comp)} px cerca de x={x0}, y={y0}')
    return out


def silueta(alpha: np.ndarray) -> np.ndarray:
    """Silueta del dibujo, con el contorno suavizado (se van los dientes de
    1–2 px del recorte original) y sin motas."""
    ancho = alpha.shape[1]
    base = (alpha >= 128).astype(np.uint8) * 255
    r = max(1.0, ancho * 0.003)  # 512 px → 1.5; 825 → 2.5; 348 → 1.0
    lisa = np.array(img_l(base).filter(ImageFilter.GaussianBlur(radius=r))) >= 128
    return quitar_motas(lisa, area_min=max(20, int((ancho * 0.015) ** 2)))


def alpha_limpio(mascara: np.ndarray) -> np.ndarray:
    """Borde antialias parejo a partir de la silueta; nada fuera de 2 px."""
    m255 = mascara.astype(np.uint8) * 255
    suave = np.array(img_l(m255).filter(ImageFilter.GaussianBlur(radius=0.7)))
    lejos = np.array(img_l(m255).filter(ImageFilter.MaxFilter(5))) == 0
    suave[lejos] = 0
    return suave


def propagar(rgb: np.ndarray, fuente: np.ndarray, pasos: int) -> np.ndarray:
    """Extiende hacia afuera el color de los píxeles «fuente» (promedio de 8 vecinos)."""
    col = rgb.astype(np.float32).copy()
    tiene = fuente.copy()
    for _ in range(pasos):
        suma = np.zeros_like(col)
        n = np.zeros(tiene.shape, dtype=np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dy == 0 and dx == 0:
                    continue
                v = np.roll(np.roll(tiene, dy, axis=0), dx, axis=1)
                c = np.roll(np.roll(col, dy, axis=0), dx, axis=1)
                suma += c * v[..., None]
                n += v
        nuevo = (~tiene) & (n > 0)
        col[nuevo] = suma[nuevo] / n[nuevo][:, None]
        tiene |= nuevo
        if tiene.all():
            break
    return np.clip(col, 0, 255).astype(np.uint8)


def variante_a(zona: np.ndarray, mascara: np.ndarray) -> np.ndarray:
    ancho = mascara.shape[1]
    banda = max(3, round(ancho * 0.011))  # 512 px → 6; 348 → 4; 825 → 9
    interior = np.array(img_l(mascara.astype(np.uint8) * 255).filter(ImageFilter.MinFilter(2 * banda + 1))) > 0
    # Dentro del interior, además, descartar píxeles claros sueltos (reflejos).
    lum = zona[..., :3].astype(int).mean(axis=-1)
    fuente = interior & (lum < 150) & (zona[..., 3] >= 250)
    rgb = propagar(zona[..., :3], fuente, pasos=banda + 6)
    # Suavizar apenas la pintura (no el alpha) para que no queden escalones de color.
    return np.array(Image.fromarray(rgb, 'RGB').filter(ImageFilter.GaussianBlur(radius=1.2)))


def variante_b(zona: np.ndarray, mascara: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(mascara)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    h, w = mascara.shape
    yy, xx = np.mgrid[0:h, 0:w]
    t = ((xx - x0) / max(1, x1 - x0) + (yy - y0) / max(1, y1 - y0)) / 2
    t = np.clip(t, 0, 1)[..., None].astype(np.float32)
    return np.clip(C1 * (1 - t) + C2 * t, 0, 255).astype(np.uint8)


def variante_c(zona: np.ndarray, mascara: np.ndarray) -> np.ndarray:
    """«bordes» (la que pidió Bruno: no cambiar el diseño): el dibujo queda tal
    cual, relieve incluido; sólo la franja antialias del contorno toma el color
    del píxel opaco más cercano, para que no quede el halo oscuro del recorte."""
    # Las costuras casi negras del relieve (1–2 px, lum < 70) tampoco son
    # fuente: se rellenan desde el vecino y en fondo oscuro ya no se leen
    # como rayas negras. Los filetes claros quedan.
    lum = zona[..., :3].astype(int).mean(axis=-1)
    fuente = mascara & (zona[..., 3] >= 200) & (lum >= 70)
    return propagar(zona[..., :3], fuente, pasos=8)


VARIANTES = {'A': variante_a, 'B': variante_b, 'C': variante_c}


def repintar(a: np.ndarray, variante: str, modo_caja: str) -> np.ndarray:
    a = a.copy()
    x0, y0, x1, y1 = caja_del_isotipo(a[..., 3], modo_caja)
    zona = a[y0:y1, x0:x1].copy()
    mascara = silueta(zona[..., 3])
    zona[..., :3] = VARIANTES[variante](zona, mascara)
    zona[..., 3] = alpha_limpio(mascara)
    a[y0:y1, x0:x1] = zona
    return a


def sobre(im: Image.Image, fondo) -> Image.Image:
    base = Image.new('RGBA', im.size, fondo + (255,))
    base.alpha_composite(im)
    return base.convert('RGB')


def lamina(imgs: list[Image.Image], salida: Path, zoom: int = 1, recorte=None) -> None:
    celdas = []
    for im in imgs:
        if recorte:
            im = im.crop(recorte)
        if zoom > 1:
            im = im.resize((im.width * zoom, im.height * zoom), Image.NEAREST)
        celdas.append(im)
    w, h = celdas[0].size
    out = Image.new('RGB', (w * len(celdas) + 8 * (len(celdas) - 1), h * 2 + 8), (128, 128, 128))
    for i, c in enumerate(celdas):
        out.paste(sobre(c, (255, 255, 255)), (i * (w + 8), 0))
        out.paste(sobre(c, FONDO_OSCURO), (i * (w + 8), h + 8))
    out.save(salida)
    print('lámina', salida, out.size)


def main() -> None:
    args = sys.argv[1:]
    modo = 'auto'
    if '--caja' in args:
        i = args.index('--caja')
        modo = args[i + 1]
        del args[i:i + 2]
    if args[0] == 'variantes':
        src = Path(args[1]); out = Path(args[2]); out.mkdir(parents=True, exist_ok=True)
        orig = np.array(Image.open(src).convert('RGBA'))
        imgs = [Image.fromarray(orig, 'RGBA')]
        for v in ('A', 'B'):
            r = repintar(orig, v, modo)
            Image.fromarray(r, 'RGBA').save(out / f'{v}.png', optimize=True)
            imgs.append(Image.fromarray(r, 'RGBA'))
            lum = r[r[..., 3] > 0][:, :3].mean(axis=1)
            print(f'variante {v}: píxeles claros (>170) que quedan: {int((lum > 170).sum())}')
        lamina(imgs, out / 'lamina-1x.png')
        lamina(imgs, out / 'lamina-zoom-arriba.png', zoom=3, recorte=(120, 80, 330, 220))
        lamina(imgs, out / 'lamina-zoom-abajo.png', zoom=3, recorte=(100, 280, 330, 440))
    elif args[0] == 'aplicar':
        v, src, dst = args[1], args[2], args[3]
        orig = np.array(Image.open(src).convert('RGBA'))
        r = repintar(orig, v, modo)
        Image.fromarray(r, 'RGBA').save(dst, optimize=True)
        print(f'{src} → {dst} (variante {v})')
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
