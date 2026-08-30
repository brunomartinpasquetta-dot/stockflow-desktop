# Marketing — StockFlow

Materiales comerciales de StockFlow. Ver [[proyectos/stockflow-plan-comercial]] en el cerebro para la estrategia.

## `landing/` — Landing web
Landing de una sola página, **self-contained** (HTML/CSS/JS inline, imágenes y fuentes en base64, sin CDNs).
**LIVE en https://bpsgsistemas.com/** (deploy additive en el VPS, ver más abajo).

- `build_landing.py` — generador. Lee `img/` + `fonts/` y emite `index.html`.
- `index.html` — el deployable (generado; 4 MB por los assets embebidos).
- `img/` — capturas reales del sistema, logo (`logo-full.png`) y cubo HD (`cube-hd.png`, 1024px).
- `fonts/` — woff2 (Plus Jakarta Sans + Montserrat; usadas por el diseño actual).

**Regenerar:** `cd marketing/landing && python3 build_landing.py` → `index.html`.

**Deploy (additive, VPS Hostinger 187.127.20.131):**
```bash
./scripts/deploy-landing.sh
# (regenera con build_landing.py y sube index3.html→index.html + js/ + assets/
#  + og.jpg + favicon.png, con backup fechado del index anterior. OJO: el scp
#  de index.html suelto que documentaba este README subía la versión VIEJA
#  self-contained sin tracking — no volver a ese método.)
```
La raíz de `bpsgsistemas.com` apunta a `/var/www/stockflow-landing/` (vhost `bpsg`; el sitio de agencia quedó preservado en `/var/www/bpsg`). NO toca la API `stockflow.bpsgsistemas.com`.

Diseño actual: modelo tipo StockFácil pero con el azul del sistema; título grande "Sistema de Gestión Comercial", cubo del logo, y un **coverflow 3D** de pantallas (flujo continuo por requestAnimationFrame, tocar para ampliar).

## `mercadolibre/` — Imágenes para publicaciones de ML
Generadores de las imágenes 1200×1200 (render con Chrome headless).
- `gen.py` — 5 placas comunes (portada de ventas, precios, sin internet, cuentas corrientes, todo incluido).
- `gen_rubros.py` — portadas por rubro (ferretería, autoservicio, mayorista, repuestos, indumentaria, punto de venta), estilo StockFácil pero mid-market.
- `a4doc.html` — mock del documento A4 formal.

**Regenerar:** correr los `.py` y renderizar con Chrome headless (ver comandos en el cerebro). Las imágenes finales se arman en `~/Desktop/StockFlow-MercadoLibre/`.

## Precios (definido 2026-07)
Suscripción **$70.000/mes** + demo **$5.000** (prueba 15 días + instalación). Target: comercios que facturan (ferreterías, autoservicios, mayoristas), NO kioscos. CTA = WhatsApp +54 342 584 7340.
