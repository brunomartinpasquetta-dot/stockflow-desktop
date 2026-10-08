/**
 * ¿La dirección que consiguió esta PC sirve para que la vean las demás?
 *
 * Windows se inventa una dirección `169.254.x.x` cuando NO consiguió una del
 * router (cable flojo, Wi-Fi caído, router sin DHCP). El sistema la mostraba
 * igual como «dirección para las terminales» y el comercio la escribía en la
 * otra PC: nunca iba a conectar, y no había forma de darse cuenta.
 */
export function direccionInservible(ip: string | null | undefined): boolean {
  const v = (ip ?? '').trim();
  if (!v) return false;
  return /^169\.254\./.test(v) || v === '127.0.0.1' || v.toLowerCase() === 'localhost';
}

export function motivoDireccionInservible(ip: string | null | undefined): string | null {
  const v = (ip ?? '').trim();
  if (/^169\.254\./.test(v)) {
    return 'Esta PC no obtuvo una dirección del router: revise el cable de red o el Wi-Fi. Mientras diga 169.254, las otras PC no la van a encontrar.';
  }
  if (v === '127.0.0.1' || v.toLowerCase() === 'localhost') {
    return 'Esa dirección sólo vale dentro de esta misma PC: las otras no la pueden usar.';
  }
  return null;
}
