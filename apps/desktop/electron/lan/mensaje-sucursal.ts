/**
 * MENSAJE PARA LA SUCURSAL — los datos para conectar una PC de otro local, en
 * un solo texto que el administrador copia en la casa central y manda (por
 * WhatsApp, por ejemplo), y que la PC de la sucursal entiende si se pega
 * entero en cualquiera de los dos campos de «Conectar a la casa central».
 *
 * Puro (sin Node ni DOM): lo usan la pantalla de la central, la de la PC
 * nueva y las pruebas.
 */

/** Texto del enlace de la primera pantalla (Activación) que lleva a conectar la PC. */
export const ENLACE_CONECTAR_PC = 'Conectar esta PC a la casa central';

/** Mismo alfabeto que los códigos (sin I, O, 0 ni 1), en dos grupos de cinco. */
const CODIGO = '[A-HJ-NP-Z2-9]{5}-?[A-HJ-NP-Z2-9]{5}';

function horaCorta(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** Lo que copia el botón «Copiar mensaje para la sucursal». */
export function armarMensajeSucursal(direccion: string, codigo: string, venceEn: number): string {
  return (
    'Para conectar la PC de la sucursal: ' +
    `1) En la primera pantalla de StockFlow haga clic en «${ENLACE_CONECTAR_PC}». ` +
    `2) Dirección: ${direccion} ` +
    `3) Código: ${codigo} (vence a las ${horaCorta(venceEn)}). ` +
    'Después ingrese con su usuario y contraseña.'
  );
}

/**
 * Saca la dirección y el código de un texto pegado (el mensaje de arriba u
 * otro parecido). Devuelve sólo lo que encuentra. El código se busca primero
 * después de «Código:» (en cualquier caja) y si no, como dos grupos de cinco
 * en mayúsculas fuera de la dirección (así no se confunde con palabras).
 */
export function extraerDatosDeConexion(texto: string): { direccion?: string; codigo?: string } {
  const t = (texto ?? '').slice(0, 2000);
  const out: { direccion?: string; codigo?: string } = {};
  const url = /https?:\/\/[^\s«»"'<>]+/i.exec(t);
  if (url) out.direccion = url[0].replace(/[.,;:)\]]+$/, '');
  const conRotulo = new RegExp(`c[óo]digo\\s*:\\s*(${CODIGO})(?![A-Za-z0-9])`, 'i').exec(t);
  const resto = url ? t.replace(url[0], ' ') : t;
  const suelto = new RegExp(`(?:^|[^A-Za-z0-9])(${CODIGO})(?![A-Za-z0-9])`).exec(resto);
  const codigo = (conRotulo?.[1] ?? suelto?.[1])?.toUpperCase();
  if (codigo) out.codigo = codigo.includes('-') ? codigo : `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
  return out;
}
