/**
 * ACCESO REMOTO — alta automática del túnel de un comercio.
 *
 * El objetivo es que el comerciante NO tenga que copiar credenciales a mano:
 * aprieta "Activar acceso remoto" en su sistema y en el momento queda con su
 * dirección propia (`sucomercio.<dominio>`). Todo lo que sigue pasa acá, en el
 * servidor, porque es el único lugar donde puede vivir la llave maestra de
 * Cloudflare: en la PC del comercio sería una llave regalada.
 *
 * Qué hace, en orden:
 *   1. Elige un nombre de dirección a partir del nombre del comercio.
 *   2. Crea el túnel en Cloudflare (o reusa el que ya tenga ese comercio).
 *   3. Apunta la dirección al túnel (registro DNS).
 *   4. Devuelve la credencial que el sistema del comercio guarda en su PC.
 *
 * Es IDEMPOTENTE: si el comercio vuelve a pedirlo (reinstaló, cambió de PC),
 * recibe lo mismo y no se duplica nada.
 *
 * UNA DIRECCIÓN NO SE LE QUITA A OTRO. Antes, si ya existía un registro con
 * ese nombre, se lo reapuntaba sin mirar de quién era: una prueba gratis
 * llamada como un comercio existente se quedaba con su dirección (y sus PC de
 * sucursal le mandaban sus pedidos). Ahora sólo se reusa un registro que
 * apunta a un túnel de ESTE comercio (`stockflow-<tenantId>`); si es de otro
 * (o no es un túnel nuestro), se usa el mismo nombre con un sufijo del
 * comercio (`coronda-1a2b.mistockflow.com`).
 */
import { randomBytes } from 'node:crypto';

export interface RemoteAccessConfig {
  apiToken: string;
  accountId: string;
  zoneId: string;
  /** Dominio bajo el que cuelgan los comercios (ej. `mistockflow.com`). */
  dominio: string;
}

export interface AltaRemota {
  hostname: string;
  tunnelId: string;
  /** JSON que el sistema del comercio guarda como credencial. */
  credencial: string;
  /** true si ya existía (no se creó nada nuevo). */
  reusado: boolean;
}

const API = 'https://api.cloudflare.com/client/v4';

/**
 * Nombres que no se le dan a ningún comercio: son del sistema o se prestan a
 * confusión. Con uno de estos, el comercio recibe el nombre con sufijo.
 */
const RESERVADOS = new Set([
  'www', 'api', 'app', 'admin', 'mail', 'smtp', 'ftp', 'cloud', 'panel', 'status', 'blog',
  'stockflow', 'soporte', 'ayuda', 'licencias', 'remoto', 'descargas', 'dl', 'bpsg',
]);

/** Sufijo estable del comercio para la dirección cuando el nombre ya es de otro. */
function sufijoDeComercio(tenantId: string, largo: number): string {
  return tenantId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, largo);
}

/** Nombre de dirección a partir del nombre del comercio: sin acentos ni espacios. */
export function slugDeComercio(nombre: string, fallback: string): string {
  const base = (nombre || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `comercio-${fallback.slice(0, 8)}`;
}

export class RemoteAccessService {
  constructor(private readonly cfg: RemoteAccessConfig) {}

  private async cf<T>(ruta: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${ruta}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.cfg.apiToken}`,
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

  /** Túnel ya existente con ese nombre, si lo hay. */
  private async buscarTunel(nombre: string): Promise<{ id: string } | null> {
    const lista = await this.cf<{ id: string; name: string; deleted_at: string | null }[]>(
      `/accounts/${this.cfg.accountId}/cfd_tunnel?name=${encodeURIComponent(nombre)}&is_deleted=false`,
    );
    const vivo = (lista ?? []).find((t) => t.name === nombre && !t.deleted_at);
    return vivo ? { id: vivo.id } : null;
  }

  /**
   * Da de alta (o recupera) el acceso remoto de un comercio.
   * `tenantId` identifica al comercio; `nombreComercio` es sólo para la dirección.
   */
  async alta(tenantId: string, nombreComercio: string): Promise<AltaRemota> {
    const nombreTunel = `stockflow-${tenantId}`;
    const existente = await this.buscarTunel(nombreTunel);
    // Túneles de ESTE comercio: una dirección que apunta a uno de ellos es
    // suya y se puede reapuntar (el viejo se borra abajo, pero su id sirve
    // para reconocer la dirección que tenía).
    const propios = new Set<string>(existente ? [existente.id.toLowerCase()] : []);

    // El secreto del túnel sólo se conoce al crearlo: si el túnel ya existía
    // pero el comercio perdió su credencial (reinstalación, PC nueva), se
    // borra y se recrea. Es la única forma de volver a entregarla.
    let reusado = false;
    if (existente) {
      await this.cf(`/accounts/${this.cfg.accountId}/cfd_tunnel/${existente.id}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
      reusado = true;
    }
    const secreto = randomBytes(32).toString('base64');
    const creado = await this.cf<{ id: string }>(`/accounts/${this.cfg.accountId}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name: nombreTunel, tunnel_secret: secreto, config_src: 'local' }),
    });
    const tunnelId = creado.id;
    propios.add(tunnelId.toLowerCase());

    // El nombre del comercio; si ese ya es de otro, el mismo con un sufijo
    // estable del comercio (así, al reinstalar, vuelve a recibir el mismo).
    const slug = slugDeComercio(nombreComercio, tenantId);
    const candidatos = [slug, `${slug}-${sufijoDeComercio(tenantId, 4)}`, `${slug}-${sufijoDeComercio(tenantId, 8)}`];
    for (const nombre of candidatos) {
      if (RESERVADOS.has(nombre)) continue;
      const hostname = `${nombre}.${this.cfg.dominio}`;
      if (await this.apuntarDnsSiEsPropia(hostname, tunnelId, nombreTunel, propios)) {
        const credencial = JSON.stringify({
          AccountTag: this.cfg.accountId,
          TunnelID: tunnelId,
          TunnelSecret: secreto,
        });
        return { hostname, tunnelId, credencial, reusado };
      }
    }
    throw new Error(`No hay una dirección libre para el comercio ${tenantId} (probadas: ${candidatos.join(', ')})`);
  }

  /**
   * ¿A quién pertenece el túnel `tunnelId`? Devuelve su nombre
   * (`stockflow-<tenantId>` para los de los comercios) o null si Cloudflare no
   * lo conoce. Los túneles borrados también se pueden consultar.
   */
  private async nombreDelTunel(tunnelId: string): Promise<string | null> {
    try {
      const t = await this.cf<{ id: string; name?: string }>(`/accounts/${this.cfg.accountId}/cfd_tunnel/${tunnelId}`);
      return typeof t?.name === 'string' ? t.name : null;
    } catch {
      return null;
    }
  }

  /**
   * Apunta `hostname` al túnel del comercio, SÓLO si la dirección está libre o
   * ya es suya (un CNAME a un túnel `stockflow-<tenantId>` de este comercio).
   * Un registro de otro comercio, de otra cosa (www, correo) o que no se puede
   * comprobar NO se toca: devuelve false y se prueba con otro nombre.
   */
  private async apuntarDnsSiEsPropia(
    hostname: string,
    tunnelId: string,
    nombreTunel: string,
    propios: Set<string>,
  ): Promise<boolean> {
    const destino = `${tunnelId}.cfargotunnel.com`;
    const existentes = await this.cf<{ id: string; name: string; type?: string; content?: string }[]>(
      `/zones/${this.cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    );
    const registros = existentes ?? [];
    const cuerpo = JSON.stringify({ type: 'CNAME', name: hostname, content: destino, proxied: true });
    if (registros.length === 0) {
      await this.cf(`/zones/${this.cfg.zoneId}/dns_records`, { method: 'POST', body: cuerpo });
      return true;
    }
    // Más de un registro con ese nombre (A + AAAA, correo…): no es una
    // dirección de comercio.
    if (registros.length > 1) return false;
    const ya = registros[0]!;
    const m = /^([0-9a-f-]{36})\.cfargotunnel\.com$/i.exec(String(ya.content ?? ''));
    if (String(ya.type ?? '').toUpperCase() !== 'CNAME' || !m) return false;
    const destinoActual = m[1]!.toLowerCase();
    const esPropia = propios.has(destinoActual) || (await this.nombreDelTunel(destinoActual)) === nombreTunel;
    if (!esPropia) return false;
    await this.cf(`/zones/${this.cfg.zoneId}/dns_records/${ya.id}`, { method: 'PUT', body: cuerpo });
    return true;
  }

  /**
   * Baja: borra el túnel del comercio. Su acceso deja de funcionar en el acto
   * y no hace falta entrar a su PC. Los demás comercios no se enteran.
   */
  async baja(tenantId: string): Promise<boolean> {
    const t = await this.buscarTunel(`stockflow-${tenantId}`);
    if (!t) return false;
    await this.cf(`/accounts/${this.cfg.accountId}/cfd_tunnel/${t.id}`, { method: 'DELETE' });
    return true;
  }
}
