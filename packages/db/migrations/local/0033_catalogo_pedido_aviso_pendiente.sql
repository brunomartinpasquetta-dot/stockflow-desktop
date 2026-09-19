-- Auditoría sep-2026 (B4): el aviso "confirmado"/"cancelado" al catálogo era
-- un disparo único; si el catálogo estaba caído en ese momento, el pedido
-- quedaba pendiente allá para siempre. Ahora el pedido recuerda qué aviso
-- debe y el barrido periódico lo reintenta hasta que el catálogo acuse.
ALTER TABLE `catalogo_pedidos` ADD `aviso_pendiente` text;
