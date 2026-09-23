/**
 * ALTA DE TÚNEL DIRECTA — sólo para la instalación del DUEÑO del sistema.
 *
 * Un comercio NUNCA pasa por acá: su acceso remoto lo da de alta el servidor
 * (`/api/remoto/alta`), que es el único lugar donde puede vivir la llave
 * maestra de Cloudflare. En la PC de un comercio esa llave sería una llave
 * regalada: con ella se crean túneles y se edita el DNS del dominio.
 *
 * La máquina de desarrollo es la excepción: tiene la licencia maestra, no tiene
 * un comercio asociado en el servidor y por lo tanto no puede pedirle el alta a
 * nadie. Para que no quede afuera de su propia función, si encuentra una llave
 * guardada a mano en `{userData}/remoto/cloudflare.token` la usa para crear su
 * túnel igual que lo haría el servidor.
 *
 * Formato del archivo (una línea por dato, `clave=valor`):
 *   token=...        (API token con permiso de Túnel y DNS)
 *   account=...
 *   zone=...
 *   dominio=mistockflow.com
 *   nombre=bruno     (opcional; por defecto 'duenio')
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';

export interface LlaveCloudflare {
  token: string;
  account: string;
  zone: string;
  dominio: string;
  nombre: string;
}

/** Lee la llave guardada a mano, si esta máquina la tiene. */
export function leerLlaveLocal(userDataDir: string): LlaveCloudflare | null {
  const ruta = path.join(userDataDir, 'remoto', 'cloudflare.token');
  if (!existsSync(ruta)) return null;
  try {
    const campos: Record<string, string> = {};
    for (const linea of readFileSync(ruta, 'utf8').split('\n')) {
      const i = linea.indexOf('=');
      if (i <= 0 || linea.trim().startsWith('#')) continue;
      campos[linea.slice(0, i).trim()] = linea.slice(i + 1).trim();
    }
    if (!campos.token || !campos.account || !campos.zone) return null;
    return {
      token: campos.token,
      account: campos.account,
      zone: campos.zone,
      dominio: campos.dominio ?? 'mistockflow.com',
      nombre: campos.nombre ?? 'duenio',
    };
  } catch {
    return null;
  }
}

async function cf<T>(llave: LlaveCloudflare, ruta: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${ruta}`, {
    ...init,
    headers: {
      authorization: `Bearer ${llave.token}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    result?: T;
    errors?: { message?: string }[];
  };
  if (!res.ok || body.success === false) {
    const detalle = body.errors?.map((e) => e.message).filter(Boolean).join('; ');
    throw new Error(`Cloudflare respondió ${res.status}${detalle ? `: ${detalle}` : ''}`);
  }
  return body.result as T;
}

/**
 * Crea (o recrea) el túnel de esta máquina y le apunta su dirección. Devuelve
 * lo mismo que devolvería el servidor para un comercio.
 */
export async function altaTunelLocal(
  llave: LlaveCloudflare,
): Promise<{ hostname: string; tunnelId: string; credencial: string }> {
  const nombreTunel = `stockflow-${llave.nombre}`;
  const existentes = await cf<{ id: string; name: string; deleted_at: string | null }[]>(
    llave,
    `/accounts/${llave.account}/cfd_tunnel?name=${encodeURIComponent(nombreTunel)}&is_deleted=false`,
  );
  const vivo = (existentes ?? []).find((t) => t.name === nombreTunel && !t.deleted_at);
  // El secreto sólo se conoce al crear: si ya existía, se borra y se rehace
  // (es la única forma de volver a tener su credencial).
  if (vivo) {
    await cf(llave, `/accounts/${llave.account}/cfd_tunnel/${vivo.id}`, { method: 'DELETE' }).catch(() => undefined);
  }
  const secreto = randomBytes(32).toString('base64');
  const creado = await cf<{ id: string }>(llave, `/accounts/${llave.account}/cfd_tunnel`, {
    method: 'POST',
    body: JSON.stringify({ name: nombreTunel, tunnel_secret: secreto, config_src: 'local' }),
  });

  const hostname = `${llave.nombre}.${llave.dominio}`;
  const destino = `${creado.id}.cfargotunnel.com`;
  const dns = await cf<{ id: string }[]>(
    llave,
    `/zones/${llave.zone}/dns_records?name=${encodeURIComponent(hostname)}`,
  );
  const cuerpo = JSON.stringify({ type: 'CNAME', name: hostname, content: destino, proxied: true });
  if ((dns ?? [])[0]) {
    await cf(llave, `/zones/${llave.zone}/dns_records/${dns[0]!.id}`, { method: 'PUT', body: cuerpo });
  } else {
    await cf(llave, `/zones/${llave.zone}/dns_records`, { method: 'POST', body: cuerpo });
  }

  return {
    hostname,
    tunnelId: creado.id,
    credencial: JSON.stringify({ AccountTag: llave.account, TunnelID: creado.id, TunnelSecret: secreto }),
  };
}
