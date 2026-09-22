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

    // El secreto del túnel sólo se conoce al crearlo: si el túnel ya existía
    // pero el comercio perdió su credencial (reinstalación, PC nueva), se
    // borra y se recrea. Es la única forma de volver a entregarla.
    let tunnelId: string;
    let secreto: string;
    let reusado = false;
    if (existente) {
      await this.cf(`/accounts/${this.cfg.accountId}/cfd_tunnel/${existente.id}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
      reusado = true;
    }
    secreto = randomBytes(32).toString('base64');
    const creado = await this.cf<{ id: string }>(`/accounts/${this.cfg.accountId}/cfd_tunnel`, {
      method: 'POST',
      body: JSON.stringify({ name: nombreTunel, tunnel_secret: secreto, config_src: 'local' }),
    });
    tunnelId = creado.id;

    const hostname = `${slugDeComercio(nombreComercio, tenantId)}.${this.cfg.dominio}`;
    await this.apuntarDns(hostname, tunnelId);

    const credencial = JSON.stringify({
      AccountTag: this.cfg.accountId,
      TunnelID: tunnelId,
      TunnelSecret: secreto,
    });
    return { hostname, tunnelId, credencial, reusado };
  }

  /** Crea o actualiza el CNAME que lleva la dirección del comercio al túnel. */
  private async apuntarDns(hostname: string, tunnelId: string): Promise<void> {
    const destino = `${tunnelId}.cfargotunnel.com`;
    const existentes = await this.cf<{ id: string; name: string }[]>(
      `/zones/${this.cfg.zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
    );
    const ya = (existentes ?? [])[0];
    const cuerpo = JSON.stringify({ type: 'CNAME', name: hostname, content: destino, proxied: true });
    if (ya) {
      await this.cf(`/zones/${this.cfg.zoneId}/dns_records/${ya.id}`, { method: 'PUT', body: cuerpo });
    } else {
      await this.cf(`/zones/${this.cfg.zoneId}/dns_records`, { method: 'POST', body: cuerpo });
    }
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
