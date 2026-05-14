/**
 * Cliente HTTP de la API REST de MercadoPago (mínimo, fetch nativo, sin libs).
 *
 *  - Headers obligatorios: Authorization: Bearer {accessToken}.
 *  - Soporta header opcional X-Idempotency-Key.
 *  - Timeout 10s con AbortController.
 *  - Retry exponencial (250/500/1000 ms) hasta 3 intentos en 429/500/502/503/504.
 *  - Logs NO incluyen el access token.
 *  - `baseUrl` puede sobrescribirse para tests (stub de fetch global).
 */

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [250, 500, 1000];

export type MpHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface MpRequestOptions {
  method: MpHttpMethod;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  /** Override del fetch global (para tests). */
  fetchImpl?: typeof fetch;
}

export class MpApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly mpCode: string | null,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'MpApiError';
  }
}

export interface MpUserMe {
  id: number | string;
  nickname?: string;
  email?: string;
  [k: string]: unknown;
}

export interface MpStore {
  id: string;
  name?: string;
  [k: string]: unknown;
}

export interface MpPos {
  id: string | number;
  external_id: string;
  name?: string;
  store_id?: string;
  [k: string]: unknown;
}

export interface MpQrInfo {
  qr_template_url?: string;
  qr_template_image?: string;
  [k: string]: unknown;
}

export interface MpPaymentSearchResult {
  results?: Array<{
    id: number | string;
    status: string;
    external_reference?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export class MpApiClient {
  constructor(
    private readonly accessToken: string,
    private readonly baseUrl: string = 'https://api.mercadopago.com',
    private readonly defaultFetch: typeof fetch = (globalThis.fetch as typeof fetch),
  ) {}

  async request<T = unknown>(opts: MpRequestOptions): Promise<T> {
    const fetchImpl = opts.fetchImpl ?? this.defaultFetch;
    const url = this.baseUrl.replace(/\/$/, '') + opts.path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

    let lastErr: unknown;
    for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetchImpl(url, {
          method: opts.method,
          headers,
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        let parsed: unknown = null;
        if (text) {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = text;
          }
        }

        if (res.ok) return parsed as T;

        if (RETRYABLE_STATUSES.has(res.status) && attempt < BACKOFF_MS.length - 1) {
          console.warn(`[mp] ${opts.method} ${opts.path} -> ${res.status} (retry ${attempt + 1})`);
          await sleep(BACKOFF_MS[attempt] ?? 250);
          continue;
        }

        const mpCode =
          parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
            ? String((parsed as Record<string, unknown>).error ?? '')
            : null;
        const mpMsg =
          parsed && typeof parsed === 'object' && parsed !== null && 'message' in parsed
            ? String((parsed as Record<string, unknown>).message ?? '')
            : `MP ${opts.method} ${opts.path} -> ${res.status}`;
        throw new MpApiError(res.status, mpCode, mpMsg, parsed);
      } catch (err) {
        lastErr = err;
        if (err instanceof MpApiError) throw err;
        // Network/abort error: retry.
        if (attempt < BACKOFF_MS.length - 1) {
          await sleep(BACKOFF_MS[attempt] ?? 250);
          continue;
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new MpApiError(0, 'NETWORK', `MP request falló: ${msg}`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error('MpApiClient: error desconocido');
  }

  /* --------------------- Métodos de alto nivel --------------------- */

  validateToken(): Promise<MpUserMe> {
    return this.request<MpUserMe>({ method: 'GET', path: '/users/me' });
  }

  createStore(userId: string, store: { name: string; business_hours?: unknown; location?: unknown }): Promise<MpStore> {
    return this.request<MpStore>({
      method: 'POST',
      path: `/users/${userId}/stores`,
      body: store,
    });
  }

  createPos(pos: { name: string; external_id: string; store_id: string; category?: number }): Promise<MpPos> {
    return this.request<MpPos>({
      method: 'POST',
      path: `/pos`,
      body: { category: 5411, ...pos },
    });
  }

  getQr(userId: string, externalPosId: string): Promise<MpQrInfo> {
    return this.request<MpQrInfo>({
      method: 'GET',
      path: `/instore/qr/seller/collectors/${userId}/pos/${externalPosId}/qrs`,
    });
  }

  putOrder(userId: string, externalPosId: string, order: Record<string, unknown>): Promise<unknown> {
    return this.request({
      method: 'PUT',
      path: `/instore/orders/qr/seller/collectors/${userId}/pos/${externalPosId}/orders`,
      body: order,
    });
  }

  deleteOrder(userId: string, externalPosId: string): Promise<unknown> {
    return this.request({
      method: 'DELETE',
      path: `/instore/orders/qr/seller/collectors/${userId}/pos/${externalPosId}/orders`,
    });
  }

  getPayment(paymentId: string | number): Promise<{ id: number | string; status: string; external_reference?: string; [k: string]: unknown }> {
    return this.request({ method: 'GET', path: `/v1/payments/${paymentId}` });
  }

  searchPayments(externalReference: string): Promise<MpPaymentSearchResult> {
    return this.request<MpPaymentSearchResult>({
      method: 'GET',
      path: `/v1/payments/search?external_reference=${encodeURIComponent(externalReference)}`,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
