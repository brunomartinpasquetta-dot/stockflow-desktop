/**
 * Handlers IPC de FACTURACIÓN ELECTRÓNICA ARCA.
 *
 * La configuración (CUIT, certificado, entorno) es de administrador. La emisión
 * la puede hacer quien vende, porque facturar es parte de la venta.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { FiscalService, type ArcaGateway } from '@stockflow/core';
import { PermissionDeniedError, ValidationError } from '@stockflow/core';

import { ArcaGatewayImpl } from '../../fiscal/ArcaGatewayImpl';
import {
  archivarFacturaPdf,
  carpetaFacturas,
  yaArchivado,
  type DatosFactura,
} from '../../fiscal/archivoFacturas';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type {
  FiscalConfigDTO,
  FiscalVoucherDTO,
  IssuedVoucherDTO,
  SalePointDTO,
  SaveFiscalConfigDTO,
} from '../types';

/**
 * RESGUARDO DEL CERTIFICADO (regla de Bruno: el certificado NUNCA se pierde en
 * una actualización). El sistema guarda la RUTA, y eso ya falló una vez: en
 * Leo Citzia la ruta apuntaba a Archivos de programa, el update barrió el
 * directorio y la facturación murió con "No se encuentra el certificado".
 *
 * Defensa en dos partes:
 *  1. Al GUARDAR la config se copia cert + clave a {userData}/arca/ — carpeta
 *     que sobrevive a todos los updates y no pide administrador.
 *  2. Al ARMAR el gateway, si la ruta configurada no existe pero el resguardo
 *     sí, se usa el resguardo y se corrige la config sola: la facturación
 *     sigue andando sin que nadie tenga que tocar nada.
 */
function rutaClaveDe(certPath: string): string {
  return certPath.replace(/\.(crt|pem|cer)$/i, '') + '.key';
}

function resguardoDir(userDataDir: string): string {
  return path.join(userDataDir, 'arca');
}

function resguardarCertificado(userDataDir: string, certPath: string): string | null {
  try {
    const keyPath = rutaClaveDe(certPath);
    if (!existsSync(certPath) || !existsSync(keyPath)) return null;
    const dir = resguardoDir(userDataDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const certDest = path.join(dir, 'certificado' + path.extname(certPath).toLowerCase());
    const keyDest = rutaClaveDe(certDest);
    // Si la ruta elegida YA es el resguardo, no copiarse encima de sí mismo.
    if (path.resolve(certPath) === path.resolve(certDest)) return certDest;
    copyFileSync(certPath, certDest);
    copyFileSync(keyPath, keyDest);
    return certDest;
  } catch (err) {
    console.warn('[fiscal] no se pudo resguardar el certificado:', err);
    return null;
  }
}

function certificadoVigente(deps: HandlerDeps, certPath: string): string {
  if (existsSync(certPath) && existsSync(rutaClaveDe(certPath))) return certPath;
  // La ruta configurada murió (update, pendrive desenchufado, carpeta
  // borrada): probar el resguardo y, si está sano, corregir la config.
  for (const ext of ['.crt', '.pem', '.cer']) {
    const candidato = path.join(resguardoDir(deps.userDataDir), 'certificado' + ext);
    if (existsSync(candidato) && existsSync(rutaClaveDe(candidato))) {
      console.warn(`[fiscal] certificado ausente en ${certPath} — usando resguardo ${candidato}`);
      try {
        const cfg = deps.repos.fiscal.getConfig();
        if (cfg) deps.repos.fiscal.saveConfig({ ...cfg, certPath: candidato });
      } catch {
        /* si no se pudo persistir, igual se factura con el resguardo */
      }
      return candidato;
    }
  }
  return certPath;
}

/** Arma el gateway con la config guardada. Lanza si falta algo. */
function buildGateway(deps: HandlerDeps): ArcaGateway & ArcaGatewayImpl {
  const cfg = deps.repos.fiscal.getConfig();
  if (!cfg) {
    throw new ValidationError('fiscal', 'Falta configurar la facturación electrónica');
  }
  if (!cfg.certPath) {
    throw new ValidationError('certPath', 'Falta cargar el certificado de ARCA');
  }
  const certPath = certificadoVigente(deps, cfg.certPath);
  // La clave privada se guarda junto al certificado con extensión .key.
  const keyPath = rutaClaveDe(certPath);
  return new ArcaGatewayImpl({
    environment: cfg.environment,
    cuit: cfg.cuit,
    certPath,
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
/**
 * El QR de ARCA como imagen para meter en el PDF. Se genera LOCALMENTE: el
 * comprobante tiene que poder emitirse e imprimirse sin internet.
 */
async function qrComoImagen(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const QR = await import('qrcode');
    return await QR.toDataURL(url, { margin: 0, width: 220 });
  } catch (err) {
    console.error('[facturas] no se pudo generar el QR:', err);
    return null;
  }
}

/** Condición del receptor frente al IVA, escrita como va en el comprobante. */
const CONDICION_IVA_CLIENTE: Record<string, string> = {
  RI: 'IVA Responsable Inscripto',
  MT: 'Responsable Monotributo',
  CF: 'Consumidor Final',
  EX: 'IVA Exento',
};

async function archivar(
  deps: HandlerDeps,
  saleId: string,
  v: IssuedVoucherDTO,
  soloSiFalta = false,
): Promise<boolean> {
  try {
    const sale = await deps.repos.sales.findById(saleId);
    if (!sale) return false;
    const lines = await deps.repos.saleLines.findBySale(saleId);
    const empresa = await deps.repos.company.getOrCreate();
    const cfg = deps.repos.fiscal.getConfig();
    const cliente = sale.customerId ? await deps.repos.customers.findById(sale.customerId) : null;

    // Los artículos rápidos no tienen ficha: su descripción viaja en la línea.
    const articulos = new Map<string, { descripcion: string; codigo: string | null }>();
    for (const l of lines) {
      if (!l.articleId) continue;
      const a = await deps.repos.articles.findById(l.articleId);
      if (a) articulos.set(l.articleId, { descripcion: a.description, codigo: a.barcode ?? null });
    }

    // DETALLE DE ALÍCUOTAS: se agrupan los renglones por tasa. Sólo en la A. El
    // neto sale de sacarle el impuesto al importe cuando los precios se cargan
    // CON IVA (`priceMode: 'gross'`); si se cargan netos, el importe ya es neto.
    const porTasa = new Map<number, { base: number; importe: number }>();
    if (v.letter === 'A') {
      for (const l of lines) {
        const tasa = Number(l.vatRate ?? 0);
        if (!Number.isFinite(tasa)) continue;
        const total = Number(l.lineTotal);
        const base = empresa.priceMode === 'gross' ? total / (1 + tasa / 100) : total;
        const prev = porTasa.get(tasa) ?? { base: 0, importe: 0 };
        porTasa.set(tasa, { base: prev.base + base, importe: prev.importe + base * (tasa / 100) });
      }
    }

    const datos: DatosFactura = {
      comercio: {
        nombre: cfg?.businessName || empresa?.name || 'StockFlow',
        logoDataUrl: empresa?.logoDataUrl ?? null,
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
            condicionIva: CONDICION_IVA_CLIENTE[cliente.category] ?? null,
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
        descripcion:
          (l.articleId ? articulos.get(l.articleId)?.descripcion : l.description) ?? 'Artículo',
        cantidad: String(Number(l.quantity)),
        precioUnitario: l.unitPrice,
        total: l.lineTotal,
        codigo: l.articleId ? (articulos.get(l.articleId)?.codigo ?? null) : null,
        alicuota: l.vatRate,
        descuento: l.discount,
      })),
      totales: {
        neto: sale.subtotal,
        iva: sale.vatAmount,
        total: sale.total,
      },
      condicionVenta: sale.isAccountSale ? 'Cuenta corriente' : 'Contado',
      alicuotas: [...porTasa.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([tasa, x]) => ({
          tasa: String(tasa),
          base: x.base.toFixed(2),
          importe: x.importe.toFixed(2),
        })),
      qrDataUrl: await qrComoImagen(v.qrUrl ?? sale.afipQrUrl ?? null),
    };

    if (soloSiFalta && yaArchivado(deps.userDataDir, datos.comprobante)) return false;

    const ruta = archivarFacturaPdf(deps.userDataDir, datos);
    if (ruta) console.log('[facturas] archivada:', ruta);
    return ruta != null;
  } catch (err) {
    console.error('[facturas] no se pudo archivar el comprobante:', err);
    return false;
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
        // Resguardo en userData al guardar. Si la ruta elegida está DENTRO del
        // directorio de instalación (el próximo update la borra), se guarda
        // directamente la ruta del resguardo.
        if (payload.certPath) {
          const resguardo = resguardarCertificado(deps.userDataDir, payload.certPath);
          const enInstalacion = /program files|archivos de programa/i.test(payload.certPath);
          if (resguardo && enInstalacion) payload = { ...payload, certPath: resguardo };
        }
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
    /**
     * Archiva los PDF que falten de comprobantes YA emitidos.
     *
     * El archivado automático corre al emitir, así que todo lo facturado antes
     * de que existiera esa función —o mientras el servidor estuvo en una
     * versión vieja— no tiene PDF. Sin esto, esas facturas no se archivan
     * NUNCA y el comercio se entera cuando el contador se las pide.
     */
    'fiscal:archivarPendientes': withSession(
      deps,
      async (_p, ctx): Promise<{ archivadas: number; total: number }> => {
        requireAdmin(ctx.currentUser?.role);
        // Punto de venta configurado: las ventas migradas no lo guardan.
        const puntos = deps.repos.fiscal.listSalePoints();
        const puntoDeVenta = puntos[0]?.number ?? 1;
        // Se recorren las VENTAS con CAE y no `fiscal_vouchers`: en una base
        // migrada desde StockFácil esa tabla está VACÍA —el CAE viejo vive en
        // la venta— y las 8.014 facturas históricas no se archivarían nunca.
        const ventas = await deps.repos.sales.findByDateRange(0, Date.now());
        const conCae = ventas.filter((s) => s.afipCAE && s.afipCAE.trim() !== '');
        let archivadas = 0;
        for (const venta of conCae) {
          const ok = await archivar(
            deps,
            venta.id,
            {
              id: venta.id,
              label: `Factura ${venta.type}`,
              letter: venta.type as 'A' | 'B' | 'C',
              salePoint: puntoDeVenta,
              number: venta.number,
              cae: venta.afipCAE!,
              caeExpiry: venta.afipExpiry ?? null,
              total: venta.total,
              qrUrl: venta.afipQrUrl ?? null,
              observations: [],
            } as IssuedVoucherDTO,
            true,
          );
          if (ok) archivadas += 1;
        }
        return { archivadas, total: conCae.length };
      },
    ),

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
