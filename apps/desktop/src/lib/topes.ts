/**
 * Los topes de cantidades e importes, para la pantalla.
 *
 * NO se repiten acá: se leen del MISMO archivo que usa el servidor
 * (`packages/shared/src/limites.ts`), de modo que ajustar un tope es cambiar un
 * solo lugar. Se importa por ruta relativa y no por `@stockflow/shared` porque
 * el renderer no puede arrastrar el resto del paquete (ver `format.ts`);
 * `limites.ts` no importa nada, así que no arrastra nada.
 */
export {
  MENSAJE_CANTIDAD_ALTA,
  MENSAJE_IMPORTE_ALTO,
  TOPES,
  mensajeDeTope,
  superaElTope,
  type ClaveDeTope,
} from '../../../../packages/shared/src/limites'
