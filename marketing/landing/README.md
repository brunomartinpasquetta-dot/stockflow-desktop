# Landing StockFlow — bpsgsistemas.com

**TODA la landing se genera con `build_landing.py`.** Los cambios van ahí, nunca
editando `index3.html` a mano (el build lo pisa). El build emite:

- `index3.html` (en el VPS se llama `index.html`)
- `js/tracking.js` (Meta Pixel + GA4 + atribución por ref; IDs se completan arriba de `build_landing.py`)
- `assets/` (imágenes optimizadas a WebP desde `img/`), `og.jpg`, `favicon.png`

`index.html` del repo es una salida VIEJA de julio, self-contained y SIN
tracking. **No tocarla ni desplegarla.**

## Deploy

```bash
./scripts/deploy-landing.sh
```

Regenera, respalda el index remoto, sube todo al docroot `/var/www/stockflow-landing`
del VPS (root@187.127.20.131) y verifica contra el sitio publicado. No toca `/dl/`
(instaladores) ni nada fuera del docroot.

## ⚠️ Estado del DNS (ago-2026) — PENDIENTE DE ARREGLAR

- `bpsgsistemas.com` (apex) devuelve **dos IPs**: `46.202.145.28` (Hostinger,
  NO sirve la landing: el puerto 80 da 403 y el 443 no tiene este sitio) y
  `187.127.20.131` (el VPS con la landing).
- `www.bpsgsistemas.com` devuelve solo `187.127.20.131` (correcto).

Con el apex a dos IPs, cada visita al apex tiene ~50% de probabilidad de caer
en Hostinger y fallar (en pruebas: 3 de 5 navegaciones fallidas). **Hay que
sacar del apex el registro A `46.202.145.28`** en el panel DNS y dejar solo
`187.127.20.131`. Mientras tanto, la verificación del deploy usa
`curl --resolve` para fijar la IP del VPS y no dar falsos negativos.

El redirect http→https ya existe en el nginx del VPS; el "403 en http" que se
ve a veces también es la IP de Hostinger, no el VPS.

## nginx del VPS

Vhost: `/etc/nginx/sites-enabled/bpsg` (symlink a `sites-available/bpsg`).
Sirve apex + www con SSL de certbot. Ahí viven http/2, `gzip_types` para JS,
y los `Cache-Control` (HTML: `no-cache, must-revalidate`; `js/`: `max-age=3600`).
Antes de tocarlo: respaldar con fecha, `nginx -t`, y si falla restaurar.

## Prueba social (TODO-PERMISO)

El bloque "Ya están facturando con StockFlow" nombra a Coronda Express
(Guillermo Peverelli) y Leo Citzia, clientes reales. Está marcado con
`TODO-PERMISO` en `build_landing.py`: **confirmar con ambos antes de mandar
tráfico pago** (y antes de pasar contactos a interesados).
