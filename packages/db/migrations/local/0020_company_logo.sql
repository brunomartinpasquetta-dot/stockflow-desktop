-- LOGO DEL COMERCIO EN LA FACTURA.
--
-- Se guarda la IMAGEN, no una ruta. Una ruta se rompe sola: si el usuario mueve
-- el archivo, lo borra, o lo eligió desde un pendrive, la factura sale sin
-- logo y el error no dice nada. Guardada en la base, además viaja con el
-- backup y sobrevive a las actualizaciones como el resto de los datos.
--
-- Formato: data URL (`data:image/png;base64,...`), que es lo que consumen
-- directo tanto el <img> de la impresión como jsPDF en el PDF archivado.
ALTER TABLE `companies` ADD COLUMN `logo_data_url` text;
