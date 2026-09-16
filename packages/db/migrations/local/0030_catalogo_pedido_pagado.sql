-- Si el pedido web ya se cobró en el catálogo (Mercado Pago). Mientras esa
-- integración no exista, el catálogo siempre manda `pagado: false` (o ni lo
-- manda) y el comerciante elige la forma de pago al confirmar, como hasta
-- ahora. Cuando llegue pagado=true, se registra la venta sola.
ALTER TABLE `catalogo_pedidos` ADD `pagado` integer DEFAULT 0 NOT NULL;
