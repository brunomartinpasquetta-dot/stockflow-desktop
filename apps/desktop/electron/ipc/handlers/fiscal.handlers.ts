/**
 * Handlers IPC de FACTURACIÓN ELECTRÓNICA ARCA.
 *
 * La configuración (CUIT, certificado, entorno) es de administrador. La emisión
 * la puede hacer quien vende, porque facturar es parte de la venta.
 */
import { FiscalService, type ArcaGateway } from '@stockflow/core';
import { PermissionDeniedError, ValidationError } from '@stockflow/core';

import { ArcaGatewayImpl } from '../../fiscal/ArcaGatewayImpl';
import { archivarFacturaPdf, carpetaFacturas, type DatosFactura } from '../../fiscal/archivoFacturas';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  FiscalConfigDTO,
  FiscalVoucherDTO,
  IssuedVoucherDTO,
  SalePointDTO,
  SaveFiscalConfigDTO,
} from '../types';

/** Arma el gateway con la config guardada. Lanza si falta algo. */
function buildGateway(deps: HandlerDeps): ArcaGateway & ArcaGatewayImpl {
  const cfg = deps.repos.fiscal.getConfig();
  if (!cfg) {
    throw new ValidationError('fiscal', 'Falta configurar la facturación electrónica');
  }
  if (!cfg.certPath) {
    throw new ValidationError('certPath', 'Falta cargar el certificado de ARCA');
  }
  // La clave privada se guarda junto al certificado con extensión .key.
  const keyPath = cfg.certPath.replace(/\.(crt|pem|cer)$/i, '') + '.key';
  return new ArcaGatewayImpl({
    environment: cfg.environment,
    cuit: cfg.cuit,
    certPath: cfg.certPath,
    keyPath,
    cacheDir: ArcaGatewayImpl.defaultCacheDir(deps.userDataDir),
  });
}

function requireAdmin(role: string | undefined): void {
  if (role !== 'admin') {
    throw new PermissionDeniedError(
      'manage_fiscal',
      'Solo un administrador puede configurar la facturación electrónica',
    );
  }
}

/**
 * Arma los datos del comprobante y lo guarda en PDF. Best-effort: si algo falla
 * se registra y sigue — el CAE ya está y una factura no se pierde por un
 * problema de archivo.
 */
async function archivar(
  deps: HandlerDeps,
  saleId: string,
  v: IssuedVoucherDTO,
): Promise<void> {
  try {
    const sale = await deps.repos.sales.findById(saleId);
    if (!sale) return;
    const lines = await deps.repos.saleLines.findBySale(saleId);
    const empresa = await deps.repos.company.getOrCreate();
    const cfg = deps.repos.fiscal.getConfig();
    const cliente = sale.customerId ? await deps.repos.customers.findById(sale.customerId) : null;

    const articulos = new Map<string, string>();
    for (const l of lines) {
      const a = await deps.repos.articles.findById(l.articleId);
      if (a) articulos.set(l.articleId, a.description);
    }

    const datos: DatosFactura = {
      comercio: {
        nombre: cfg?.businessName || empresa?.name || 'StockFlow',
        domicilio: cfg?.address ?? empresa?.address ?? null,
        cuit: cfg?.cuit ?? empresa?.cuit ?? null,
        ingBrutos: cfg?.grossIncome ?? null,
        condicionIva: cfg?.vatCondition === 'RI' ? 'IVA Responsable Inscripto' : 'Monotributo',
        inicioActividad: null,
      },
      cliente: cliente
        ? {
            nombre: `${cliente.lastName}${cliente.firstName ? ' ' + cliente.firstName : ''}`.trim(),
            documento:
              cliente.docNumber ? `${cliente.docType ?? 'Doc'}: ${cliente.docNumber}` : null,
            condicionIva: null,
          }
        : null,
      comprobante: {
        etiqueta: v.label,
        letra: v.letter,
        puntoVenta: v.salePoint,
        numero: v.number,
        fecha: sale.date,
        cae: v.cae,
        vencimientoCae: v.caeExpiry,
      },
      lineas: lines.map((l: (typeof lines)[number]) => ({
        descripcion: articulos.get(l.articleId) ?? 'Artículo',
        cantidad: String(Number(l.quantity)),
        precioUnitario: l.unitPrice,
        total: l.lineTotal,
      })),
      totales: {
        neto: sale.subtotal,
        iva: sale.vatAmount,
        total: sale.total,
      },
    };

    const ruta = archivarFacturaPdf(deps.userDataDir, datos);
    if (ruta) console.log('[facturas] archivada:', ruta);
  } catch (err) {
    console.error('[facturas] no se pudo archivar el comprobante:', err);
  }
}

export function buildFiscalHandlers(deps: HandlerDeps): HandlerMap {
  return {
    /* ---------------------------- Configuración ---------------------------- */

    'fiscal:getConfig': withSession(deps, async (_p, ctx): Promise<FiscalConfigDTO | null> => {
      requireAdmin(ctx.currentUser?.role);
      const cfg = deps.repos.fiscal.getConfig();
      return cfg as FiscalConfigDTO | null;
    }),

    /**
     * Config PÚBLICA: lo mínimo que necesita la pantalla de Ventas para saber si
     * puede facturar. Sin certificado ni datos sensibles → no requiere ser admin.
     */
    'fiscal:getConfigPublic': withSession(
      deps,
      async (): Promise<{ enabled: boolean; environment: 'homologacion' | 'produccion'; vatCondition: 'RI' | 'MT' } | null> => {
        const cfg = deps.repos.fiscal.getConfig();
        if (!cfg) return null;
        return {
          enabled: cfg.enabled,
          environment: cfg.environment,
          vatCondition: cfg.vatCondition,
        };
      },
    ),

    'fiscal:saveConfig': withSession(
      deps,
      async (payload: SaveFiscalConfigDTO, ctx): Promise<FiscalConfigDTO> => {
        requireAdmin(ctx.currentUser?.role);
        return deps.repos.fiscal.saveConfig(payload) as FiscalConfigDTO;
      },
    ),

    /** Prueba de conexión: autentica con el certificado y consulta ARCA. */
    'fiscal:testConnection': withSession(
      deps,
      async (_p, ctx): Promise<{ ok: boolean; message: string; servers?: string }> => {
        requireAdmin(ctx.currentUser?.role);
        try {
          const gw = buildGateway(deps);
          const st = await gw.ping();
          const allOk = st.app === 'OK' && st.db === 'OK' && st.auth === 'OK';
          return {
            ok: allOk,
            message: allOk
              ? 'Conexión con ARCA establecida correctamente'
              : 'ARCA respondió, pero algún servicio no está operativo',
            servers: `app: ${st.app} · base: ${st.db} · auth: ${st.auth}`,
          };
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
      },
    ),

    /* --------------------------- Puntos de venta --------------------------- */

    'fiscal:listSalePoints': withSession(deps, async (): Promise<SalePointDTO[]> => {
      return deps.repos.fiscal.listSalePoints() as SalePointDTO[];
    }),

    /** Trae de ARCA los puntos de venta habilitados para este CUIT. */
    'fiscal:fetchSalePointsFromArca': withSession(
      deps,
      async (_p, ctx): Promise<{ number: number; type: string; blocked: boolean }[]> => {
        requireAdmin(ctx.currentUser?.role);
        const gw = buildGateway(deps);
        return gw.listSalePoints();
      },
    ),

    'fiscal:saveSalePoint': withSession(
      deps,
      async (
        payload: { number: number; description: string; terminalId?: string | null; active?: boolean },
        ctx,
      ): Promise<SalePointDTO> => {
        requireAdmin(ctx.currentUser?.role);
        return deps.repos.fiscal.upsertSalePoint(payload) as SalePointDTO;
      },
    ),

    'fiscal:deleteSalePoint': withSession(
      deps,
      async (payload: { id: string }, ctx): Promise<{ ok: true }> => {
        requireAdmin(ctx.currentUser?.role);
        deps.repos.fiscal.deleteSalePoint(payload.id);
        return { ok: true };
      },
    ),

    /* ------------------------------- Emisión ------------------------------- */

    /** Dónde quedan los PDF, y abrir esa carpeta. */
    'fiscal:getPdfFolder': withSession(deps, async (): Promise<{ folder: string }> => ({
      folder: carpetaFacturas(deps.userDataDir),
    })),
    'fiscal:openPdfFolder': withSession(deps, async (): Promise<{ ok: true }> => {
      const { shell } = await import('electron');
      const { mkdirSync } = await import('node:fs');
      const carpeta = carpetaFacturas(deps.userDataDir);
      // Se crea si todavía no hay facturas: abrir una carpeta inexistente no
      // hace nada y parece que el botón está roto.
      mkdirSync(carpeta, { recursive: true });
      await shell.openPath(carpeta);
      return { ok: true };
    }),

    'fiscal:issueInvoice': withSession(
      deps,
      async (
        payload: { saleId: string; salePoint: number; letter?: 'A' | 'B' | 'C' },
        ctx,
      ): Promise<IssuedVoucherDTO> => {
        const svc = new FiscalService(ctx, buildGateway(deps));
        const v = (await svc.issueInvoiceForSale(payload)) as IssuedVoucherDTO;
        // El PDF se archiva ACÁ, donde llega el CAE: así queda guardado aunque
        // la factura la haya emitido una terminal por navegador y aunque el
        // cajero cierre la ventana enseguida. Nunca frena la respuesta.
        void archivar(deps, payload.saleId, v);
        return v;
      },
    ),

    'fiscal:issueNote': withSession(
      deps,
      async (
        payload: {
          relatedVoucherId: string;
          kind: 'credit_note' | 'debit_note';
          total?: string;
          reason?: string;
        },
        ctx,
      ): Promise<IssuedVoucherDTO> => {
        const svc = new FiscalService(ctx, buildGateway(deps));
        return (await svc.issueNote(payload)) as IssuedVoucherDTO;
      },
    ),

    /* ------------------------------ Consultas ------------------------------ */

    'fiscal:getVoucherForSale': withSession(
      deps,
      async (payload: { saleId: string }): Promise<FiscalVoucherDTO | null> => {
        return deps.repos.fiscal.findVoucherBySale(payload.saleId) as FiscalVoucherDTO | null;
      },
    ),

    'fiscal:listVouchers': withSession(
      deps,
      async (payload: { from?: number; to?: number; limit?: number }): Promise<FiscalVoucherDTO[]> => {
        // Consulta local: no arma el gateway (no requiere certificado ni red).
        return deps.repos.fiscal.listVouchers(payload ?? {}) as FiscalVoucherDTO[];
      },
    ),
  };
}
