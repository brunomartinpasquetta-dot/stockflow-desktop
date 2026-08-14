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
}

export interface DatosFactura {
  comercio: {
    nombre: string;
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
  doc.setFontSize(14).setFont('helvetica', 'bold');
  doc.text(d.comercio.nombre, 14, 20);
  doc.setFontSize(8.5).setFont('helvetica', 'normal');
  let y = 25;
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

  // ── Cliente
  doc.setFontSize(9).setFont('helvetica', 'bold');
  doc.text(d.cliente ? d.cliente.nombre : 'Consumidor Final', 14, y);
  doc.setFont('helvetica', 'normal');
  const datosCliente = [d.cliente?.documento, d.cliente?.condicionIva].filter(Boolean) as string[];
  if (datosCliente.length > 0) {
    y += 4.5;
    doc.text(datosCliente.join('   ·   '), 14, y);
  }

  // ── Detalle
  autoTable(doc, {
    startY: y + 5,
    head: [['Descripción', 'Cant.', 'P. unitario', 'Importe']],
    body: d.lineas.map((l) => [l.descripcion, l.cantidad, money(l.precioUnitario), money(l.total)]),
    styles: { fontSize: 8.5, cellPadding: 1.6 },
    headStyles: { fillColor: [27, 82, 204] },
    columnStyles: {
      1: { halign: 'right', cellWidth: 20 },
      2: { halign: 'right', cellWidth: 28 },
      3: { halign: 'right', cellWidth: 30 },
    },
    margin: { left: 14, right: 10 },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;

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

  // ── Pie fiscal
  y += 10;
  doc.setDrawColor(180).line(14, y, 200, y);
  y += 5;
  doc.setFontSize(9).setFont('helvetica', 'bold');
  doc.text(`CAE N°: ${c.cae}`, 14, y);
  doc.setFont('helvetica', 'normal');
  if (c.vencimientoCae) {
    doc.text(`Vencimiento del CAE: ${fecha(c.vencimientoCae)}`, 200, y, { align: 'right' });
  }
  y += 6;
  doc.setFontSize(7.5).setTextColor(110);
  doc.text('Comprobante autorizado por ARCA · Documento generado automáticamente por StockFlow', 14, y);

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
