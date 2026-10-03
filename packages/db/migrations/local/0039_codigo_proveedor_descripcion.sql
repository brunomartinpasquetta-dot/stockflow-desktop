-- FACTURAS DE COMPRA POR TELÉFONO (ver docs/PLAN_FACTURAS_TELEFONO.md).
--
-- Sólo AGREGA una columna a `article_supplier_codes`: la descripción con que
-- el proveedor imprimió ese código la vez que el usuario lo vinculó. Los
-- códigos de proveedor no tienen dígito verificador: un dígito mal leído por
-- el OCR cae fácil en el código REAL de otro producto. Antes de confiar en un
-- código aprendido, la próxima factura compara su descripción con ésta; si no
-- se parecen, el artículo se ofrece pero no se vincula solo.
-- NULL = vínculo aprendido antes de esta columna (se confía como hasta ahora).
ALTER TABLE `article_supplier_codes` ADD COLUMN `description` text;
