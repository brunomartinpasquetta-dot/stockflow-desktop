-- FACTURACIÓN ELECTRÓNICA ARCA (ex AFIP)
--
-- Modelo:
--  * `fiscal_config`   : singleton con el modo (homologación/producción), el CUIT
--                        emisor y dónde está el certificado. La clave privada NO
--                        se guarda acá (va cifrada por el main process).
--  * `sale_points`     : puntos de venta habilitados en ARCA. Cada terminal usa
--                        el suyo (el cliente tiene 2 terminales facturando).
--  * `fiscal_vouchers` : comprobantes fiscales emitidos (facturas, notas de
--                        crédito y débito) con su CAE. Es el libro IVA Ventas.
--
-- Las ventas siguen viviendo en `sales`; un comprobante fiscal la referencia.
-- Una venta puede no tener comprobante (remito X interno) y una nota de crédito
-- puede existir sin venta nueva (anula/ajusta una factura previa).

CREATE TABLE `fiscal_config` (
  `id` text PRIMARY KEY NOT NULL,
  -- 'homologacion' (testing de ARCA) | 'produccion'
  `environment` text NOT NULL DEFAULT 'homologacion',
  `cuit` text NOT NULL,
  -- Razón social y domicilio como los tiene registrados ARCA (van en el PDF).
  `business_name` text,
  `address` text,
  -- Condición frente al IVA del EMISOR: RI (responsable inscripto) | MT (monotributo)
  `vat_condition` text NOT NULL DEFAULT 'RI',
  `gross_income` text,
  `activity_start_date` integer,
  -- Ruta al certificado (.crt) y alias de la clave en el almacén seguro.
  `cert_path` text,
  `key_alias` text,
  `enabled` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sale_points` (
  `id` text PRIMARY KEY NOT NULL,
  -- Número de punto de venta en ARCA (ej: 1, 2, 4...). Único.
  `number` integer NOT NULL,
  `description` text NOT NULL,
  -- Terminal que lo usa (hostname/identificador). Null = disponible para todas.
  `terminal_id` text,
  `active` integer NOT NULL DEFAULT 1,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sale_points_number` ON `sale_points` (`number`);
--> statement-breakpoint
CREATE TABLE `fiscal_vouchers` (
  `id` text PRIMARY KEY NOT NULL,
  -- Código de comprobante ARCA: 1=FacturaA 6=FacturaB 11=FacturaC
  -- 3=NC-A 8=NC-B 13=NC-C  2=ND-A 7=ND-B 12=ND-C
  `voucher_code` integer NOT NULL,
  -- Letra para mostrar/imprimir (A/B/C) y clase (invoice|credit_note|debit_note)
  `letter` text NOT NULL,
  `kind` text NOT NULL DEFAULT 'invoice',
  `sale_point` integer NOT NULL,
  `number` integer NOT NULL,
  `date` integer NOT NULL,
  -- Venta que factura (null en notas de crédito/débito sin venta asociada).
  `sale_id` text REFERENCES `sales`(`id`),
  -- Comprobante que se está anulando/ajustando (notas de crédito y débito).
  `related_voucher_id` text REFERENCES `fiscal_vouchers`(`id`),
  `customer_id` text NOT NULL REFERENCES `customers`(`id`),
  -- Datos del receptor CONGELADOS al momento de emitir (ARCA los exige y el
  -- comprobante no puede cambiar si después se edita el cliente).
  `customer_doc_type` integer NOT NULL,
  `customer_doc_number` text NOT NULL,
  `customer_name` text NOT NULL,
  `net_amount` text NOT NULL DEFAULT '0.0000',
  `vat_amount` text NOT NULL DEFAULT '0.0000',
  `exempt_amount` text NOT NULL DEFAULT '0.0000',
  `untaxed_amount` text NOT NULL DEFAULT '0.0000',
  `total` text NOT NULL,
  -- Respuesta de ARCA
  `cae` text,
  `cae_expiry` integer,
  -- 'pending' | 'approved' | 'rejected' | 'error'
  `status` text NOT NULL DEFAULT 'pending',
  `observations` text,
  `errors` text,
  `qr_url` text,
  `user_id` text NOT NULL REFERENCES `users`(`id`),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
-- Un solo comprobante por (tipo, punto de venta, número): la numeración fiscal
-- es correlativa y sin huecos por cada combinación.
CREATE UNIQUE INDEX `idx_fiscal_vouchers_num` ON `fiscal_vouchers` (`voucher_code`, `sale_point`, `number`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_vouchers_date` ON `fiscal_vouchers` (`date`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_vouchers_sale` ON `fiscal_vouchers` (`sale_id`);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_vouchers_customer` ON `fiscal_vouchers` (`customer_id`);
--> statement-breakpoint
-- Detalle de alícuotas de IVA por comprobante (ARCA lo pide desglosado).
CREATE TABLE `fiscal_voucher_vat` (
  `id` text PRIMARY KEY NOT NULL,
  `voucher_id` text NOT NULL REFERENCES `fiscal_vouchers`(`id`) ON DELETE cascade,
  -- Id de alícuota ARCA: 3=0% 4=10.5% 5=21% 6=27%
  `vat_id` integer NOT NULL,
  `base_amount` text NOT NULL,
  `vat_amount` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_fiscal_vat_voucher` ON `fiscal_voucher_vat` (`voucher_id`);
