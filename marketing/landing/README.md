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

## ✅ DNS — RESUELTO (2-sep-2026)

Bruno eliminó del apex el registro A `46.202.145.28` y el AAAA de Hostinger.
Verificado: `bpsgsistemas.com` y `www` resuelven solo a `187.127.20.131`,
AAAA vacío, apex y www responden 200. La verificación del deploy conserva
`curl --resolve` como blindaje determinístico (inmune a caches DNS viejos),
ya no como workaround.

## nginx del VPS

Vhost: `/etc/nginx/sites-enabled/bpsg` (symlink a `sites-available/bpsg`).
Sirve apex + www con SSL de certbot. Ahí viven http/2, `gzip_types` para JS,
y los `Cache-Control` (HTML: `no-cache, must-revalidate`; `js/`: `max-age=3600`).
Antes de tocarlo: respaldar con fecha, `nginx -t`, y si falla restaurar.

## Prueba social — ELIMINADA, decisión definitiva (sep-2026)

Bruno decidió **no publicar clientes en la landing**, ni con nombre ni en
versión anónima: la sección de prueba social se eliminó por completo.
**No reintroducirla** — es una decisión de privacidad, no un hueco de diseño.

## Pendientes

- **Acomodar el encabezado y la primera sección** (pedido de Bruno, sep-2026;
  alcance a definir con él antes de tocar).
