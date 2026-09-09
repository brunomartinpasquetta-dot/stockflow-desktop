-- RG 5616: condición frente al IVA del receptor informada a ARCA en cada
-- comprobante (código de FEParamGetCondicionIvaReceptor: 1 RI, 4 Exento,
-- 5 Consumidor Final, 6 Monotributo). Se congela al emitir, igual que el
-- documento del receptor, y las notas de crédito/débito la repiten.
-- NULL = comprobante emitido antes de esta versión.
ALTER TABLE `fiscal_vouchers` ADD COLUMN `customer_vat_condition_id` integer;
