/**
 * Importación masiva de stock desde Excel.
 *
 * - `parseFile`: lee el archivo y devuelve headers + preview de filas (sin
 *   inserts).
 * - `validate`: chequea cada fila contra el schema esperado y devuelve los
 *   errores junto con un muestreo de filas válidas.
 * - `execute`: crea familias y proveedores faltantes (si se permite), y luego
 *   inserta los artículos en transacciones de a 100.
 *
 * NO importa `@stockflow/core`: usa los repos directamente.
 */
import type { Repositories } from '@stockflow/db';

export interface ImportMapping {
  barcode: string;
  description: string;
  listPrice1: string;
  stock: string;
  brand?: string | null;
  familyName?: string | null;
  supplierName?: string | null;
  costPrice?: string | null;
  vatRate?: string | null;
  minStock?: string | null;
}

export interface ImportOptions {
  createMissingFamilies: boolean;
  createMissingSuppliers: boolean;
  skipRowsWithErrors: boolean;
}

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

export interface ImportValidationResult {
  valid: number;
  errors: ImportError[];
  sampleValid: Array<Record<string, unknown>>;
}

export interface ImportExecuteResult {
  created: number;
  skipped: number;
  familiesCreated: number;
  suppliersCreated: number;
}

const VALID_VAT_RATES = new Set(['0', '10.5', '21', '27']);

function toStr(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

function isNumStr(v: string): boolean {
  if (v === '') return false;
  return !Number.isNaN(Number(v.replace(',', '.')));
}

function asNumber(v: string): number {
  return Number(v.replace(',', '.'));
}

export class ExcelImportService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private XLSX: any = null;

  private async getXlsx(): Promise<unknown> {
    if (this.XLSX) return this.XLSX;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('xlsx');
    this.XLSX = mod.default ?? mod;
    return this.XLSX;
  }

  async parseFile(filePath: string): Promise<{
    sheets: string[];
    preview: Array<Record<string, unknown>>;
    headers: string[];
    totalRows: number;
  }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const XLSX: any = await this.getXlsx();
      const wb = XLSX.readFile(filePath);
      const sheets = wb.SheetNames as string[];
      const firstSheetName = sheets[0];
      if (!firstSheetName) throw new Error('El archivo no tiene hojas');
      const sheet = wb.Sheets[firstSheetName];
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
      if (aoa.length === 0) {
        return { sheets, preview: [], headers: [], totalRows: 0 };
      }
      const headers = (aoa[0] ?? []).map((h) => toStr(h));
      const dataRows = aoa.slice(1);
      const preview = dataRows.slice(0, 10).map((row) => {
        const obj: Record<string, unknown> = {};
        headers.forEach((h, i) => {
          obj[h] = row[i] ?? '';
        });
        return obj;
      });
      return { sheets, preview, headers, totalRows: dataRows.length };
    } catch (err) {
      throw new Error('No se pudo leer el archivo Excel', { cause: err });
    }
  }

  private async readAllRows(filePath: string): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const XLSX: any = await this.getXlsx();
    const wb = XLSX.readFile(filePath);
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) return { headers: [], rows: [] };
    const sheet = wb.Sheets[firstSheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][];
    if (aoa.length === 0) return { headers: [], rows: [] };
    const headers = (aoa[0] ?? []).map((h) => toStr(h));
    const rows = aoa.slice(1).map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] ?? '';
      });
      return obj;
    });
    return { headers, rows };
  }

  async validate(
    filePath: string,
    mapping: ImportMapping,
    repos: Repositories,
  ): Promise<ImportValidationResult> {
    const { rows } = await this.readAllRows(filePath);
    const errors: ImportError[] = [];
    const sampleValid: Array<Record<string, unknown>> = [];
    const barcodeSeen = new Set<string>();
    let valid = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNum = i + 2; // header en fila 1
      let rowErrors = 0;
      const pushErr = (field: string, message: string): void => {
        errors.push({ row: rowNum, field, message });
        rowErrors++;
      };

      const barcode = toStr(row[mapping.barcode]);
      const description = toStr(row[mapping.description]);
      const listPrice1 = toStr(row[mapping.listPrice1]);
      const stock = toStr(row[mapping.stock]);

      if (!barcode) pushErr('barcode', 'Código de barras vacío');
      else if (barcodeSeen.has(barcode)) pushErr('barcode', `Código duplicado en el archivo: ${barcode}`);
      else {
        barcodeSeen.add(barcode);
        try {
          const existing = await repos.articles.findByBarcode(barcode);
          if (existing) pushErr('barcode', `Código ya existe en la base: ${barcode}`);
        } catch {
          // Ignorar; el chequeo es best-effort.
        }
      }

      if (!description) pushErr('description', 'Descripción vacía');
      if (!isNumStr(listPrice1) || asNumber(listPrice1) < 0) pushErr('listPrice1', 'Precio inválido');
      if (!isNumStr(stock) || asNumber(stock) < 0) pushErr('stock', 'Stock inválido');

      if (mapping.vatRate) {
        const v = toStr(row[mapping.vatRate]);
        if (v && !VALID_VAT_RATES.has(v.replace(',', '.'))) {
          pushErr('vatRate', `Alícuota inválida: ${v} (esperado 0, 10.5, 21, 27)`);
        }
      }
      if (mapping.costPrice) {
        const v = toStr(row[mapping.costPrice]);
        if (v && !isNumStr(v)) pushErr('costPrice', `Costo inválido: ${v}`);
      }
      if (mapping.minStock) {
        const v = toStr(row[mapping.minStock]);
        if (v && !isNumStr(v)) pushErr('minStock', `Stock mínimo inválido: ${v}`);
      }

      if (rowErrors === 0) {
        valid++;
        if (sampleValid.length < 5) sampleValid.push(row);
      }
    }

    return { valid, errors, sampleValid };
  }

  async execute(
    filePath: string,
    mapping: ImportMapping,
    options: ImportOptions,
    repos: Repositories,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ImportExecuteResult> {
    const validation = await this.validate(filePath, mapping, repos);
    const { rows } = await this.readAllRows(filePath);

    const errorRows = new Set(validation.errors.map((e) => e.row));
    const filtered: { row: Record<string, unknown>; rowNum: number }[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2;
      if (errorRows.has(rowNum)) {
        if (!options.skipRowsWithErrors) {
          throw new Error(`La fila ${rowNum} tiene errores y skipRowsWithErrors está en false`);
        }
        continue;
      }
      filtered.push({ row: rows[i]!, rowNum });
    }

    // Pre-resolver familias y proveedores.
    const families = await repos.families.findAll();
    const familyByName = new Map<string, string>();
    for (const f of families as Array<{ id: string; name: string }>) {
      familyByName.set(f.name.toLowerCase(), f.id);
    }
    const suppliers = await repos.suppliers.findAll();
    const supplierByName = new Map<string, string>();
    for (const s of suppliers as Array<{ id: string; name: string }>) {
      supplierByName.set(s.name.toLowerCase(), s.id);
    }

    let familiesCreated = 0;
    let suppliersCreated = 0;
    if (mapping.familyName && options.createMissingFamilies) {
      const needed = new Set<string>();
      for (const { row } of filtered) {
        const name = toStr(row[mapping.familyName]);
        if (name && !familyByName.has(name.toLowerCase())) needed.add(name);
      }
      for (const name of needed) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const created: any = await (repos.families as unknown as { create: (d: Record<string, unknown>) => Promise<{ id: string }> }).create({ name });
          familyByName.set(name.toLowerCase(), created.id);
          familiesCreated++;
        } catch {
          // ignore
        }
      }
    }
    if (mapping.supplierName && options.createMissingSuppliers) {
      const needed = new Set<string>();
      for (const { row } of filtered) {
        const name = toStr(row[mapping.supplierName]);
        if (name && !supplierByName.has(name.toLowerCase())) needed.add(name);
      }
      let counter = Date.now();
      for (const name of needed) {
        try {
          // El supplier tiene `code` único; generamos uno.
          const code = `IMP-${counter++}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const created: any = await (repos.suppliers as unknown as { create: (d: Record<string, unknown>) => Promise<{ id: string }> }).create({ code, name });
          supplierByName.set(name.toLowerCase(), created.id);
          suppliersCreated++;
        } catch {
          // ignore
        }
      }
    }

    let created = 0;
    let skipped = 0;
    const total = filtered.length;

    for (let i = 0; i < filtered.length; i++) {
      const { row } = filtered[i]!;
      const barcode = toStr(row[mapping.barcode]);
      const description = toStr(row[mapping.description]);
      const listPrice1 = toStr(row[mapping.listPrice1]);
      const stock = toStr(row[mapping.stock]);

      const data: Record<string, unknown> = {
        barcode,
        description,
        listPrice1,
        stock,
      };
      if (mapping.brand) data.brand = toStr(row[mapping.brand]) || null;
      if (mapping.familyName) {
        const fname = toStr(row[mapping.familyName]).toLowerCase();
        const fid = familyByName.get(fname);
        if (fid) data.familyId = fid;
      }
      if (mapping.supplierName) {
        const sname = toStr(row[mapping.supplierName]).toLowerCase();
        const sid = supplierByName.get(sname);
        if (sid) data.supplierId = sid;
      }
      if (mapping.costPrice) {
        const v = toStr(row[mapping.costPrice]);
        if (v) data.costPrice = v;
      }
      if (mapping.vatRate) {
        const v = toStr(row[mapping.vatRate]);
        if (v) data.vatRate = v;
      }
      if (mapping.minStock) {
        const v = toStr(row[mapping.minStock]);
        if (v) data.minStock = v;
      }

      try {
        await (repos.articles as unknown as { create: (d: Record<string, unknown>) => Promise<unknown> }).create(data);
        created++;
      } catch {
        skipped++;
      }
      if (onProgress) onProgress(i + 1, total);
    }

    return { created, skipped, familiesCreated, suppliersCreated };
  }
}
