/**
 * Facturas de compra por teléfono — QR fiscal del comprobante (ARCA/AFIP).
 *
 * Toda factura electrónica trae un QR con la URL
 *   https://www.afip.gob.ar/fe/qr/?p=<base64 de un JSON>
 * De ahí salen, sin leer una sola letra de la hoja: fecha, CUIT del emisor,
 * punto de venta, tipo y número de comprobante, importe total y CAE. Sirve para
 * reconocer al proveedor y para controlar la suma de los renglones.
 *
 * Es MEJOR ESFUERZO: en una foto de celular de la hoja entera el QR ocupa pocos
 * píxeles y puede no leerse. Si no se lee, devuelve null y la factura sigue.
 * JS puro (`jsqr` + `jpeg-js`): sin dependencias nativas.
 */
import jpeg from 'jpeg-js';
import * as jsqrMod from 'jsqr';

export interface DatosQr {
  /** `AAAA-MM-DD`. */
  fecha: string | null;
  /** CUIT del emisor, sólo dígitos. */
  cuit: string | null;
  ptoVta: number | null;
  /** Código de comprobante de ARCA (1 = Factura A, 6 = Factura B, 11 = Factura C…). */
  tipoCmp: number | null;
  /** Letra del comprobante según `tipoCmp`; null si no es A/B/C/M. */
  letra: 'A' | 'B' | 'C' | 'M' | null;
  nroCmp: number | null;
  /** Importe total del comprobante. */
  importe: number | null;
  /** CAE / CAEA. */
  codAut: string | null;
}

type Lector = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opciones?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' },
) => { data: string } | null;

// `jsqr` es CommonJS con `exports.default`: según quién lo cargue (tsx, esbuild,
// node) el default llega directo o envuelto.
const jsQR: Lector = (() => {
  let m: unknown = jsqrMod;
  for (let i = 0; i < 3 && typeof m !== 'function'; i++) m = (m as { default?: unknown } | null)?.default;
  return m as Lector;
})();

/** Letra del comprobante por código de ARCA (factura, nota de débito, nota de crédito, recibo…). */
function letraDeTipo(tipo: number | null): DatosQr['letra'] {
  if (tipo === null) return null;
  if ([1, 2, 3, 4, 5, 201, 202, 203].includes(tipo)) return 'A';
  if ([6, 7, 8, 9, 10, 206, 207, 208].includes(tipo)) return 'B';
  if ([11, 12, 13, 15, 211, 212, 213].includes(tipo)) return 'C';
  if ([51, 52, 53, 54].includes(tipo)) return 'M';
  return null;
}

const aEntero = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Decodifica el contenido del QR fiscal. Acepta la URL completa (cualquier host:
 * afip.gob.ar, arca.gob.ar) o sólo el parámetro; base64 común o url-safe, con o
 * sin relleno. Devuelve null si no es un QR de comprobante.
 */
export function decodificarUrlQr(url: string): DatosQr | null {
  if (typeof url !== 'string') return null;
  const m = /[?&]p=([^&#\s]+)/.exec(url.trim());
  if (!m) return null;
  let b64 = m[1]!;
  try {
    b64 = decodeURIComponent(b64);
  } catch {
    /* venía con un % suelto: se usa tal cual */
  }
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/ /g, '+');
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const j = json as Record<string, unknown>;
  const cuit = j.cuit === undefined || j.cuit === null ? '' : String(j.cuit).replace(/\D/g, '');
  const nroCmp = aEntero(j.nroCmp);
  // Sin CUIT ni número no es un comprobante: es otro QR con un "p=".
  if (!cuit && nroCmp === null) return null;
  const tipoCmp = aEntero(j.tipoCmp);
  const importe = typeof j.importe === 'number' ? j.importe : typeof j.importe === 'string' ? Number(j.importe) : NaN;
  const codAut = j.codAut === undefined || j.codAut === null ? '' : String(j.codAut).replace(/\D/g, '');
  const fecha = typeof j.fecha === 'string' && /^\d{4}-\d{2}-\d{2}/.test(j.fecha) ? j.fecha.slice(0, 10) : null;
  return {
    fecha,
    cuit: cuit || null,
    ptoVta: aEntero(j.ptoVta),
    tipoCmp,
    letra: letraDeTipo(tipoCmp),
    nroCmp,
    importe: Number.isFinite(importe) ? Math.round(importe * 100) / 100 : null,
    codAut: codAut || null,
  };
}

// ---------------------------------------------------------------------------
// Imagen
// ---------------------------------------------------------------------------

interface Gris {
  ancho: number;
  alto: number;
  px: Uint8ClampedArray;
}

function aGris(jpegBuf: Buffer): Gris | null {
  if (!Buffer.isBuffer(jpegBuf) || jpegBuf.length < 4 || jpegBuf[0] !== 0xff || jpegBuf[1] !== 0xd8) return null;
  try {
    // Topes bajos a propósito: la página del teléfono ya reduce a 2000 px, y
    // una cámara común da 12 MP. Un JPEG armado de 60 MP congelaría la app
    // (esto corre en el proceso principal): arriba de 25 MP no se busca el QR.
    const img = jpeg.decode(jpegBuf, { useTArray: true, formatAsRGBA: false, tolerantDecoding: true, maxResolutionInMP: 25, maxMemoryUsageInMB: 256 });
    const n = img.width * img.height;
    const px = new Uint8ClampedArray(n);
    const d = img.data;
    for (let i = 0, j = 0; i < n; i++, j += 3) px[i] = (d[j]! * 77 + d[j + 1]! * 150 + d[j + 2]! * 29) >> 8;
    return { ancho: img.width, alto: img.height, px };
  } catch {
    return null;
  }
}

/** Recorte (x, y, w, h) llevado a `escala` (≤ 1 promedia bloques; > 1 interpola), listo para jsQR (RGBA). */
function recorte(g: Gris, x: number, y: number, w: number, h: number, escala: number): { data: Uint8ClampedArray; w: number; h: number } {
  const dw = Math.max(1, Math.round(w * escala));
  const dh = Math.max(1, Math.round(h * escala));
  const data = new Uint8ClampedArray(dw * dh * 4);
  const paso = 1 / escala;
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      let v: number;
      if (escala >= 1) {
        // Bilineal.
        const fx = Math.min(w - 1, (i + 0.5) * paso - 0.5);
        const fy = Math.min(h - 1, (j + 0.5) * paso - 0.5);
        const x0 = Math.max(0, Math.floor(fx));
        const y0 = Math.max(0, Math.floor(fy));
        const x1 = Math.min(w - 1, x0 + 1);
        const y1 = Math.min(h - 1, y0 + 1);
        const ax = Math.max(0, fx - x0);
        const ay = Math.max(0, fy - y0);
        const f0 = (y + y0) * g.ancho + x;
        const f1 = (y + y1) * g.ancho + x;
        v =
          g.px[f0 + x0]! * (1 - ax) * (1 - ay) + g.px[f0 + x1]! * ax * (1 - ay) + g.px[f1 + x0]! * (1 - ax) * ay + g.px[f1 + x1]! * ax * ay;
      } else {
        // Promedio del bloque de origen.
        const sx0 = Math.floor(i * paso);
        const sy0 = Math.floor(j * paso);
        const sx1 = Math.min(w, Math.max(sx0 + 1, Math.floor((i + 1) * paso)));
        const sy1 = Math.min(h, Math.max(sy0 + 1, Math.floor((j + 1) * paso)));
        let suma = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          const fila = (y + sy) * g.ancho + x;
          for (let sx = sx0; sx < sx1; sx++) suma += g.px[fila + sx]!;
        }
        v = suma / ((sx1 - sx0) * (sy1 - sy0));
      }
      const o = (j * dw + i) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, w: dw, h: dh };
}

/**
 * Texto del primer QR que se pueda leer en la foto, o null. Prueba la hoja
 * entera a varios tamaños y después por zonas superpuestas (en una foto de la
 * hoja completa el QR es chico: de cerca se lee mejor). `filtro` descarta QR que
 * no interesan (p. ej. el de una promoción impresa en la misma hoja).
 */
function leerTextoQr(jpegBuf: Buffer, filtro: (texto: string) => boolean = () => true): string | null {
  const g = aGris(jpegBuf);
  if (!g) return null;
  const mayor = Math.max(g.ancho, g.alto);
  const probar = (x: number, y: number, w: number, h: number, escala: number): string | null => {
    try {
      const r = recorte(g, x, y, w, h, escala);
      const qr = jsQR(r.data, r.w, r.h, { inversionAttempts: 'dontInvert' });
      return qr && qr.data && filtro(qr.data) ? qr.data : null;
    } catch {
      return null;
    }
  };

  // 1. Hoja entera, de chica a grande (lo barato primero).
  for (const lado of [1000, 1600, 2400]) {
    if (lado >= mayor) continue;
    const t = probar(0, 0, g.ancho, g.alto, lado / mayor);
    if (t) return t;
  }
  const entera = probar(0, 0, g.ancho, g.alto, 1);
  if (entera) return entera;

  // 2. Por zonas: grilla de mitades y de tercios, superpuestas al 50 %.
  for (const partes of [2, 3]) {
    const w = Math.floor(g.ancho / partes);
    const h = Math.floor(g.alto / partes);
    const pasos = partes * 2 - 1;
    for (let fy = 0; fy < pasos; fy++) {
      for (let fx = 0; fx < pasos; fx++) {
        const x = Math.min(g.ancho - w, Math.floor((fx * w) / 2));
        const y = Math.min(g.alto - h, Math.floor((fy * h) / 2));
        const ladoZona = Math.max(w, h);
        // Tal cual (o reducida a 1400) y, si la zona es chica, ampliada al doble.
        const escalas = ladoZona > 1400 ? [1400 / ladoZona, 1] : ladoZona < 700 ? [1, 2] : [1];
        for (const e of escalas) {
          const t = probar(x, y, w, h, e);
          if (t) return t;
        }
      }
    }
  }
  return null;
}

/** Datos del QR fiscal de la foto de una hoja, o null si no hay o no se pudo leer. */
export function leerQrFiscal(jpegBuf: Buffer): DatosQr | null {
  try {
    const texto = leerTextoQr(jpegBuf, (t) => decodificarUrlQr(t) !== null);
    return texto ? decodificarUrlQr(texto) : null;
  } catch {
    return null;
  }
}
