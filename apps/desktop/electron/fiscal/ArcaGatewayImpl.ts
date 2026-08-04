/**
 * Implementación del `ArcaGateway` que usa el servicio fiscal.
 *
 * Vive en la capa Electron porque es la única que puede firmar con el
 * certificado (openssl del sistema) y hacer las llamadas SOAP.
 *
 * Reutiliza el ticket de acceso mientras siga vigente: WSAA rechaza pedir uno
 * nuevo si el anterior no venció.
 */
import path from 'node:path';

import { ARCA_ENDPOINTS, buildQrUrl } from '@stockflow/shared';
import type { ArcaGateway } from '@stockflow/core';

import { WsaaClient } from './WsaaClient';
import { WsfeClient } from './WsfeClient';

export interface ArcaGatewayConfig {
  environment: 'homologacion' | 'produccion';
  cuit: string;
  certPath: string;
  keyPath: string;
  /** Carpeta donde cachear el ticket de acceso. */
  cacheDir: string;
}

export class ArcaGatewayImpl implements ArcaGateway {
  constructor(private readonly cfg: ArcaGatewayConfig) {}

  private endpoints() {
    return ARCA_ENDPOINTS[this.cfg.environment];
  }

  /** Cliente WSFE autenticado y listo para operar. */
  private async client(): Promise<WsfeClient> {
    const wsaa = new WsaaClient({
      certPath: this.cfg.certPath,
      keyPath: this.cfg.keyPath,
      wsaaUrl: this.endpoints().wsaa,
      service: 'wsfe',
      cacheDir: this.cfg.cacheDir,
      cuit: this.cfg.cuit,
    });
    const ta = await wsaa.getAccessTicket();
    return WsfeClient.fromTicket(this.endpoints().wsfe, ta, this.cfg.cuit);
  }

  async lastAuthorized(salePoint: number, voucherCode: number): Promise<number> {
    const c = await this.client();
    return c.lastAuthorized(salePoint, voucherCode);
  }

  async requestCae(
    req: Parameters<ArcaGateway['requestCae']>[0],
  ): ReturnType<ArcaGateway['requestCae']> {
    const c = await this.client();
    return c.requestCae({
      salePoint: req.salePoint,
      voucherCode: req.voucherCode,
      number: req.number,
      date: req.date,
      docType: req.docType,
      docNumber: req.docNumber,
      netAmount: req.netAmount,
      vatAmount: req.vatAmount,
      exemptAmount: req.exemptAmount,
      untaxedAmount: req.untaxedAmount,
      total: req.total,
      vatDetails: req.vatDetails,
      associated: req.associated,
    });
  }

  buildQrUrl(data: Parameters<ArcaGateway['buildQrUrl']>[0]): string {
    return buildQrUrl(data);
  }

  /* --------- Operaciones de diagnóstico (para la pantalla de config) -------- */

  /** Estado de los servidores de ARCA. */
  async ping(): Promise<{ app: string; db: string; auth: string }> {
    const c = await this.client();
    return c.dummy();
  }

  /** Puntos de venta habilitados en ARCA para este CUIT. */
  async listSalePoints(): Promise<{ number: number; type: string; blocked: boolean }[]> {
    const c = await this.client();
    return c.salePoints();
  }

  /** Ruta por defecto del cache del ticket dentro del userData. */
  static defaultCacheDir(userDataDir: string): string {
    return path.join(userDataDir, 'arca');
  }
}
