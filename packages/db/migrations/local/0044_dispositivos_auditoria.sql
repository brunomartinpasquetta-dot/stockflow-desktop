-- PC DE SUCURSAL: datos para auditar y distinguir las PC emparejadas
-- (revisión de seguridad de la etapa 1, docs/PLAN_MULTISUCURSAL.md §10).
--
-- `creado_desde`: red o IP del visitante y por dónde entró al canjear el código
-- ("200.1.2.0/24 por internet", "192.168.1.30 en la red local").
-- `ultima_ip`: la última red/IP desde la que operó (se graba junto con
-- `ultimo_uso_en`). Con eso dos PC con el mismo nombre se distinguen en
-- Configuración y se ve desde dónde se emparejó un intruso.
--
-- Sólo AGREGA columnas que aceptan NULL (las filas existentes quedan con NULL).
ALTER TABLE `dispositivos_sucursal` ADD `creado_desde` text;
--> statement-breakpoint
ALTER TABLE `dispositivos_sucursal` ADD `ultima_ip` text;
