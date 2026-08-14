/**
 * ARCHIVO DE FACTURAS EN PDF.
 *
 * Cada comprobante autorizado por ARCA se guarda automáticamente como PDF, sin
 * que nadie tenga que acordarse de exportarlo. Es lo que el contador pide a fin
 * de mes y lo que hay que mostrar si ARCA pregunta.
 *
 * DECISIONES QUE IMPORTAN:
 *
 * 1. **Lo genera el SERVIDOR, no la pantalla.** Si lo hiciera el renderer, una
 *    factura emitida desde una terminal por navegador no se archivaría —o se
 *    perdería si el cajero cierra la ventana antes de que termine—. Acá se
 *    dispara donde se recibe el CAE y no depende de nadie.
 *
 * 2. **La carpeta vive en userData**, junto a la base y la licencia. El
 *    instalador NUNCA la toca (NSIS reemplaza el directorio del programa, no
 *    éste), así que sobrevive a todas las actualizaciones. Regla explícita de
 *    Bruno: esta carpeta no se borra nunca.
 *
 * 3. **Un archivo por comprobante, ordenado por año y mes**, con el nombre que
 *    usa ARCA (`B-0005-00000001.pdf`): así se encuentra sin abrirlo y se puede
 *    mandar por WhatsApp o adjuntar al mail del contador.
 *
 * 4. **Si falla, la factura NO se cae.** El CAE ya está: perder el PDF es
 *    molesto, perder la venta es grave. Se registra el error y sigue.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

export interface LineaFactura {
  descripcion: string;
  cantidad: string;
  precioUnitario: string;
  total: string;
  /** Código del artículo. Si ninguna línea lo trae, la columna no se dibuja. */
  codigo?: string | null;
  /** Alícuota del renglón ("21.00"); se discrimina sólo en Factura A. */
  alicuota?: string | null;
  /** Descuento del renglón. */
  descuento?: string | null;
}

export interface DatosFactura {
  comercio: {
    nombre: string;
    /** Logo como data URL; sale arriba a la izquierda. */
    logoDataUrl?: string | null;
    domicilio?: string | null;
    cuit?: string | null;
    ingBrutos?: string | null;
    condicionIva?: string | null;
    inicioActividad?: number | null;
  };
  cliente: { nombre: string; documento?: string | null; condicionIva?: string | null } | null;
  comprobante: {
    etiqueta: string;
    letra: string;
    puntoVenta: number;
    numero: number;
    fecha: number;
    cae: string;
    vencimientoCae: number | null;
  };
  lineas: LineaFactura[];
  totales: { neto?: string | null; iva?: string | null; total: string };
  /** Condición de venta ("Contado", "Cuenta corriente"). */
  condicionVenta?: string | null;
  /** DETALLE DE ALÍCUOTAS. Sólo en Factura A, que es donde el IVA se discrimina. */
  alicuotas?: { tasa: string; base: string; importe: string }[] | null;
  /**
   * QR de ARCA (RG 4892), ya renderizado como data URL. Es OBLIGATORIO en el
   * comprobante: el PDF archivado tiene que ser igual al que se le entrega al
   * cliente, si no sirve de respaldo a medias.
   */
  qrDataUrl?: string | null;
}

/** Carpeta donde vive el archivo. NO se borra nunca. */
export function carpetaFacturas(userDataDir: string): string {
  return path.join(userDataDir, 'facturas');
}

/** Ruta que le tocaría a un comprobante, exista o no el archivo. */
export function rutaDeComprobante(
  userDataDir: string,
  c: DatosFactura['comprobante'],
): string {
  const f = new Date(c.fecha || Date.now());
  return path.join(
    carpetaFacturas(userDataDir),
    String(f.getFullYear()),
    String(f.getMonth() + 1).padStart(2, '0'),
    nombreArchivo(c),
  );
}

/** true si ese comprobante ya tiene su PDF archivado. */
export function yaArchivado(userDataDir: string, c: DatosFactura['comprobante']): boolean {
  return existsSync(rutaDeComprobante(userDataDir, c));
}

const money = (v: string | number | null | undefined): string =>
  `$ ${Number(v ?? 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fecha = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString('es-AR') : '';

/** `B-0005-00000001.pdf` */
function nombreArchivo(c: DatosFactura['comprobante']): string {
  const pv = String(c.puntoVenta).padStart(5, '0');
  const nro = String(c.numero).padStart(8, '0');
  return `${c.letra}-${pv}-${nro}.pdf`;
}

function construirPdf(d: DatosFactura): ArrayBuffer {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const c = d.comprobante;
  const pv = String(c.puntoVenta).padStart(5, '0');
  const nro = String(c.numero).padStart(8, '0');

  // ── Encabezado: emisor a la izquierda, comprobante a la derecha, con la
  //    letra en el recuadro del medio, como manda el formato de ARCA.
  // Logo, si el comercio lo cargó. Se dibuja arriba a la izquierda y el resto
  // del encabezado baja lo necesario.
  let yTitulo = 20;
  if (d.comercio.logoDataUrl) {
    try {
      doc.addImage(d.comercio.logoDataUrl, 'PNG', 14, 10, 0, 16, undefined, 'FAST');
      yTitulo = 32;
    } catch {
      /* logo ilegible: sale sin él, la factura no se cae por esto */
    }
  }
  doc.setFontSize(14).setFont('helvetica', 'bold');
  doc.text(d.comercio.nombre, 14, yTitulo);
  doc.setFontSize(8.5).setFont('helvetica', 'normal');
  let y = yTitulo + 5;
  for (const linea of [
    d.comercio.domicilio,
    d.comercio.cuit ? `CUIT: ${d.comercio.cuit}` : null,
    d.comercio.ingBrutos ? `Ing. Brutos: ${d.comercio.ingBrutos}` : null,
    d.comercio.condicionIva,
    d.comercio.inicioActividad ? `Inicio de actividades: ${fecha(d.comercio.inicioActividad)}` : null,
  ].filter(Boolean) as string[]) {
    doc.text(linea, 14, y);
    y += 4;
  }

  doc.setDrawColor(60).rect(96, 12, 18, 16);
  doc.setFontSize(20).setFont('helvetica', 'bold');
  doc.text(c.letra, 105, 24, { align: 'center' });

  doc.setFontSize(13).setFont('helvetica', 'bold');
  doc.text(c.etiqueta.toUpperCase(), 200, 18, { align: 'right' });
  doc.setFontSize(10).setFont('helvetica', 'normal');
  doc.text(`N° ${pv}-${nro}`, 200, 24, { align: 'right' });
  doc.text(`Fecha: ${fecha(c.fecha)}`, 200, 29, { align: 'right' });

  y = Math.max(y, 34) + 4;
  doc.setDrawColor(180).line(14, y, 200, y);
  y += 6;

  // ── Cliente. La condición frente al IVA es un dato obligatorio del
  //    comprobante: si no se conoce, es Consumidor Final.
  doc.setFontSize(9).setFont('helvetica', 'bold');
  doc.text(d.cliente ? d.cliente.nombre : 'Consumidor Final', 14, y);
  doc.setFont('helvetica', 'normal');
  const datosCliente = [
    d.cliente?.documento,
    d.cliente?.condicionIva ?? 'Consumidor Final',
    d.condicionVenta ? `Condición de venta: ${d.condicionVenta}` : null,
  ].filter(Boolean) as string[];
  if (datosCliente.length > 0) {
    y += 4.5;
    doc.text(datosCliente.join('   ·   '), 14, y);
  }

  // ── Detalle. Las columnas opcionales sólo aparecen si hay algo que poner:
  //    una columna vacía en 40 renglones come el ancho que necesita la
  //    descripción. El IVA por renglón va SÓLO en la A.
  const conCodigo = d.lineas.some((l) => (l.codigo ?? '').trim().length > 0);
  const conDescuento = d.lineas.some((l) => Number(l.descuento ?? 0) > 0);
  const conAlicuota = c.letra === 'A' && d.lineas.some((l) => l.alicuota != null);

  const head = [
    ...(conCodigo ? ['Código'] : []),
    'Descripción',
    'Cant.',
    'P. unitario',
    ...(conDescuento ? ['Dto.'] : []),
    ...(conAlicuota ? ['IVA'] : []),
    'Importe',
  ];
  const body = d.lineas.map((l) => [
    ...(conCodigo ? [l.codigo ?? ''] : []),
    l.descripcion,
    l.cantidad,
    money(l.precioUnitario),
    ...(conDescuento ? [Number(l.descuento ?? 0) > 0 ? money(l.descuento) : ''] : []),
    ...(conAlicuota ? [l.alicuota ? `${Number(l.alicuota)}%` : ''] : []),
    money(l.total),
  ]);

  // Los anchos se declaran por índice y ese índice se corre según qué columnas
  // existan, así que se arma sobre la marcha en vez de hardcodearlo.
  const columnStyles: Record<number, { halign: 'right' | 'left'; cellWidth: number }> = {};
  let col = 0;
  if (conCodigo) columnStyles[col++] = { halign: 'left', cellWidth: 24 };
  col++; // descripción: ancho automático, se queda con lo que sobra
  columnStyles[col++] = { halign: 'right', cellWidth: 16 };
  columnStyles[col++] = { halign: 'right', cellWidth: 24 };
  if (conDescuento) columnStyles[col++] = { halign: 'right', cellWidth: 18 };
  if (conAlicuota) columnStyles[col++] = { halign: 'right', cellWidth: 13 };
  columnStyles[col] = { halign: 'right', cellWidth: 26 };

  autoTable(doc, {
    startY: y + 5,
    head: [head],
    body,
    styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' },
    headStyles: { fillColor: [27, 82, 204] },
    columnStyles,
    margin: { left: 14, right: 10 },
  });
  const finDetalle = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY;

  // El comprobante ocupa la HOJA ENTERA: los totales y el pie fiscal se anclan
  // abajo en vez de quedar pegados al detalle con media página en blanco. A4
  // son 297mm; se reservan 62mm para totales + pie.
  const ALTO_A4 = 297;
  // El detalle de alícuotas ocupa lugar abajo: si no se reserva, se monta con
  // el pie fiscal.
  const alicuotas = c.letra === 'A' ? (d.alicuotas ?? []) : [];
  const reservaPie = 62 + (alicuotas.length > 0 ? 6 + alicuotas.length * 5 : 0);
  const yTotales = Math.max(finDetalle + 6, ALTO_A4 - reservaPie);

  // Marco del detalle hasta donde arrancan los totales: así la hoja se ve
  // completa, como un talonario preimpreso.
  doc.setDrawColor(200);
  doc.line(14, finDetalle, 14, yTotales - 4);
  doc.line(200, finDetalle, 200, yTotales - 4);
  doc.line(14, yTotales - 4, 200, yTotales - 4);

  y = yTotales;

  // ── DETALLE DE ALÍCUOTAS, abajo a la izquierda, enfrentado a los totales. Es
  //    lo primero que mira el contador en una Factura A.
  if (alicuotas.length > 0) {
    let yA = yTotales;
    doc.setFontSize(7.5).setFont('helvetica', 'bold');
    doc.text('DETALLE DE ALÍCUOTAS', 14, yA);
    doc.setFont('helvetica', 'normal').setFontSize(8);
    yA += 4.5;
    doc.text('Alícuota', 14, yA);
    doc.text('Neto gravado', 62, yA, { align: 'right' });
    doc.text('IVA', 86, yA, { align: 'right' });
    doc.setDrawColor(180).line(14, yA + 1, 86, yA + 1);
    for (const a of alicuotas) {
      yA += 5;
      doc.text(`IVA ${Number(a.tasa)}%`, 14, yA);
      doc.text(money(a.base), 62, yA, { align: 'right' });
      doc.text(money(a.importe), 86, yA, { align: 'right' });
    }
  }

  // ── Totales. El IVA se discrimina SÓLO en la Factura A. En B y C va dentro
  //    del precio y mostrarlo aparte es un error fiscal: al consumidor final no
  //    se le discrimina el impuesto.
  doc.setFontSize(9).setFont('helvetica', 'normal');
  const discriminaIva =
    c.letra === 'A' && d.totales.neto != null && d.totales.iva != null && Number(d.totales.iva) > 0;
  if (discriminaIva) {
    doc.text(`Neto gravado: ${money(d.totales.neto)}`, 200, y, { align: 'right' });
    y += 4.5;
    doc.text(`IVA: ${money(d.totales.iva)}`, 200, y, { align: 'right' });
    y += 6;
  }
  doc.setFontSize(13).setFont('helvetica', 'bold');
  doc.text('TOTAL', 140, y);
  doc.text(money(d.totales.total), 200, y, { align: 'right' });

  // ── Pie fiscal: QR obligatorio (RG 4892) + CAE y vencimiento.
  y += 10;
  doc.setDrawColor(180).line(14, y, 200, y);
  y += 5;
  if (d.qrDataUrl) {
    try {
      doc.addImage(d.qrDataUrl, 'PNG', 14, y - 2, 26, 26);
    } catch {
      /* si el QR no se pudo dibujar, el resto del comprobante igual sale */
    }
  }
  const xPie = d.qrDataUrl ? 44 : 14;
  doc.setFontSize(9).setFont('helvetica', 'bold');
  doc.text(`CAE N°: ${c.cae}`, xPie, y);
  doc.setFont('helvetica', 'normal');
  if (c.vencimientoCae) {
    doc.text(`Vencimiento del CAE: ${fecha(c.vencimientoCae)}`, 200, y, { align: 'right' });
  }
  y += 6;
  doc.setFontSize(7.5).setTextColor(110);
  doc.text('Comprobante autorizado por ARCA · Documento generado automáticamente por StockFlow', xPie, y);

  return doc.output('arraybuffer');
}

/**
 * Genera y guarda el PDF. Devuelve la ruta, o null si algo falló (nunca lanza:
 * el CAE ya está y una factura no se pierde por un problema de archivo).
 */
export function archivarFacturaPdf(
  userDataDir: string,
  datos: DatosFactura,
): string | null {
  try {
    const f = new Date(datos.comprobante.fecha || Date.now());
    const destino = path.join(
      carpetaFacturas(userDataDir),
      String(f.getFullYear()),
      String(f.getMonth() + 1).padStart(2, '0'),
    );
    if (!existsSync(destino)) mkdirSync(destino, { recursive: true });
    const ruta = path.join(destino, nombreArchivo(datos.comprobante));
    writeFileSync(ruta, Buffer.from(construirPdf(datos)));
    return ruta;
  } catch (err) {
    console.error('[facturas] no se pudo archivar el PDF:', err);
    return null;
  }
}
