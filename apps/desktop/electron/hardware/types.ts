/**
 * Tipos compartidos del subsistema de hardware (impresora térmica, balanza,
 * cajón monedero). Autocontenido: no importa nada de @stockflow/*.
 */

export type PrinterKind = 'usb' | 'network' | 'file' | 'system';
export type PrinterWidth = 58 | 80;
export type PaperFormat = '58mm' | '80mm' | 'A4';

export interface PrinterConfig {
  kind: PrinterKind;
  /**
   * usb: 'vendorId:productId';
   * network: 'ip:port';
   * file: ruta absoluta;
   * system: nombre exacto de la impresora del SO (CUPS / spooler).
   */
  interface: string;
  width: PrinterWidth;
  characterSet: string;
  autoOpenDrawer: boolean;
  /** Formato lógico del papel; si falta, se infiere de `width`. */
  paperFormat?: PaperFormat;
}

export type ScaleProtocol = 'kretz' | 'systel' | 'magris' | 'generic';

export interface ScaleConfig {
  portPath: string;
  baudRate: number;
  protocol: ScaleProtocol;
  mode: 'continuous' | 'request';
}

export interface BackupConfig {
  destination: string;
  autoOnCashClose: boolean;
  autoOnAppQuit: boolean;
}

export interface HardwareConfigFile {
  printer: PrinterConfig | null;
  scale: ScaleConfig | null;
  backup: BackupConfig;
}

export interface WeightReading {
  /** Siempre en kg, 3 decimales, como string para evitar floats. */
  value: string;
  unit: 'kg';
  stable: boolean;
  raw: string;
}

export interface UsbDeviceInfo {
  vendorId: number;
  productId: number;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
}

export interface SystemPrinterInfo {
  name: string;
  isDefault?: boolean;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface BackupEntry {
  filename: string;
  fullPath: string;
  sizeBytes: number;
  createdAt: number;
}

export interface SaleTicketLineData {
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
}

export interface SaleTicketPaymentData {
  method: string;
  amount: string;
}

export interface SaleTicketData {
  number: number;
  voucherType: 'A' | 'B' | 'C' | 'X';
  createdAt: number;
  company: {
    name: string;
    cuit?: string | null;
    address?: string | null;
    phone?: string | null;
    ingBrutos?: string | null;
  };
  customer?: { name: string; docNumber?: string | null } | null;
  lines: SaleTicketLineData[];
  subtotal: string;
  vatTotal: string;
  total: string;
  payments: SaleTicketPaymentData[];
  accountSale?: boolean;
}

export interface CashCloseReportData {
  company: { name: string };
  registerNumber: number;
  openDate: number;
  closeDate: number;
  openingAmount: string;
  salesCount: number;
  salesTotal: string;
  paymentBreakdown: { method: string; amount: string }[];
  incomeMovements: string;
  expenseMovements: string;
  expectedClosing: string;
  declaredClosing: string;
  difference: string;
}
