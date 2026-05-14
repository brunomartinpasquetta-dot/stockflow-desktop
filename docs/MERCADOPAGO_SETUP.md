# MercadoPago QR Atendido — Setup

StockFlow integra MercadoPago QR Atendido para cobrar ventas escaneando un único QR
por caja. El cliente paga desde la app de MercadoPago y la venta se cierra
automáticamente cuando MP confirma el pago.

## 1) Pre-requisitos

- Cuenta empresarial de MercadoPago (no personal).
- Permisos de administrador en StockFlow.

## 2) Generar credenciales de producción

1. Ingresá a https://www.mercadopago.com.ar/developers/panel
2. "Tus integraciones" → crear o seleccionar una aplicación.
3. Solapa "Credenciales de producción".
4. Copiá:
   - **User ID** (numérico, ej: `123456789`).
   - **Access Token** de producción (empieza con `APP_USR-…`).

> El access token se guarda CIFRADO en la base local. Nunca viaja en claro al renderer.

## 3) Configurar en StockFlow

1. Iniciá StockFlow como administrador.
2. Menú → **MercadoPago QR**.
3. Pegá el User ID y el Access Token y presioná **Conectar**.
4. StockFlow valida el token, crea una "Sucursal StockFlow" en MercadoPago y
   guarda la configuración.

## 4) Configurar el webhook (cobro automático)

Para que el pago se detecte sin polling constante:

1. En el panel MP: "Tus integraciones" → "Notificaciones" / "Webhooks".
2. Pegá la URL que muestra la pantalla de configuración de StockFlow:
   `https://api.stockflow.com.ar/api/mp/webhook/{tenantId}`
3. Eventos a notificar: **Pagos** (`payment`).
4. Guardá.

> Si no podés configurar el webhook (firewall, NAT), no pasa nada: el modal de
> cobro hace polling cada 2-3 s y detecta el pago igual.

## 5) Asignar QR a cada caja

1. Abrí la caja desde la pantalla de Caja.
2. Volvé a **MercadoPago QR** → tabla "QR por caja".
3. Presioná **Generar QR**.
4. StockFlow crea el POS en MercadoPago, descarga el QR e imprime/guarda la imagen.
5. Imprimí el QR y pegalo en la caja (1 por caja, se reutiliza para todas las ventas).

## 6) Cobrar con QR

1. En Ventas, cargá los artículos.
2. Presioná **Cobrar con QR MP** (sólo se habilita si la caja tiene QR asignado).
3. Aparece el modal con el QR y un countdown de 5 min.
4. El cliente escanea, paga.
5. Cuando MP confirma el pago, la venta se cierra automáticamente con el medio
   de pago "MercadoPago QR".

## Troubleshooting

- **Pago no detectado**: revisá que la app del cliente confirmó el pago.
  Tocá "Verificar pago" en el modal — fuerza un chequeo manual.
- **Webhook no llega**: chequeá firewall, NAT y que la URL pública sea
  accesible desde Internet. El polling cubre este caso.
- **QR no escanea**: re-generalo desde la pantalla de configuración
  (borrar el device + crear de nuevo).
- **"Access token inválido"**: el token expiró o es de sandbox. Generá uno de
  producción.

## Limitaciones conocidas (versión actual)

- El SSE cloud → desktop NO está implementado: la detección de pago se hace
  100% por polling cada 2.5-3 s, lo cual es suficiente para el operador.
- El endpoint cloud `/api/mp/webhook/:tenantId` está como diseño pero todavía
  no recibe webhooks reales en producción. Cuando se despliegue, el handler
  `MpQrService.handleWebhook` ya está listo para procesar payloads.
