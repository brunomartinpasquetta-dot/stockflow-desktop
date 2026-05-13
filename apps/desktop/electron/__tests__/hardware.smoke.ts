/**
 * Smoke test del subsistema de hardware + backup + importación.
 *
 *   pnpm --filter @stockflow/desktop test:hardware
 *
 * Verifica los caminos felices sin hardware real:
 *  - PrinterService en modo `file` escribe bytes ESC/POS con códigos esperados.
 *  - BackupService crea un .zip que contiene la DB y metadata.json.
 *  - ExcelImportService valida un .xlsx con filas válidas + inválidas.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb } from '@stockflow/db';

import { BackupService } from '../backup/BackupService';
import { PrinterService } from '../hardware/PrinterService';
import { ExcelImportService } from '../import/ExcelImportService';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'stockflow-hw-smoke-'));
console.log(`\nTest de hardware/backup/import — dir temporal: ${tmpDir}\n`);

async function testPrinter(): Promise<void> {
  console.log('— PrinterService (file mode) —');
  const file58 = join(tmpDir, 'printer-58.bin');
  const printer58 = new PrinterService({
    kind: 'file',
    interface: file58,
    width: 58,
    characterSet: 'PC858_EURO',
    autoOpenDrawer: false,
  });
  await printer58.testPrint();
  const buf58 = readFileSync(file58);
  check('testPrint() genera bytes', buf58.length > 0, `${buf58.length} bytes`);
  check('contiene ESC INIT (0x1B 0x40)', buf58.includes(Buffer.from([0x1b, 0x40])));
  check('contiene comando CUT (0x1D 0x56)', buf58.includes(Buffer.from([0x1d, 0x56])));
  check('contiene texto "PRUEBA"', buf58.includes(Buffer.from('PRUEBA', 'latin1')));

  // Sale ticket
  const fileSale = join(tmpDir, 'printer-sale.bin');
  const printerSale = new PrinterService({
    kind: 'file',
    interface: fileSale,
    width: 80,
    characterSet: 'PC858_EURO',
    autoOpenDrawer: false,
  });
  await printerSale.printSaleTicket({
    number: 1,
    voucherType: 'B',
    createdAt: Date.now(),
    company: { name: 'Test Empresa', cuit: '30-12345678-3', address: 'Av. Siempreviva 742', phone: '+54', ingBrutos: null },
    customer: { name: 'Consumidor Final', docNumber: null },
    lines: [
      { description: 'Coca Cola 1.5L', quantity: '2', unitPrice: '500.00', total: '1000.00' },
      { description: 'Pan lactal', quantity: '1', unitPrice: '350.00', total: '350.00' },
    ],
    subtotal: '1350.00',
    vatTotal: '283.50',
    total: '1350.00',
    payments: [{ method: 'Efectivo', amount: '1350.00' }],
  });
  const bufSale = readFileSync(fileSale);
  check('printSaleTicket() contiene total', bufSale.includes(Buffer.from('TOTAL', 'latin1')));
  check('printSaleTicket() contiene company name', bufSale.includes(Buffer.from('Test Empresa', 'latin1')));

  // Cajón monedero
  const fileDrawer = join(tmpDir, 'printer-drawer.bin');
  const printerDrawer = new PrinterService({
    kind: 'file',
    interface: fileDrawer,
    width: 80,
    characterSet: 'PC858_EURO',
    autoOpenDrawer: false,
  });
  await printerDrawer.openCashDrawer();
  const bufDrawer = readFileSync(fileDrawer);
  check('openCashDrawer() emite kick (ESC p)', bufDrawer.includes(Buffer.from([0x1b, 0x70, 0x00])));
}

async function testBackup(): Promise<void> {
  console.log('\n— BackupService —');
  const dbPath = join(tmpDir, 'stockflow.db');
  // Inicializar una DB real (con migraciones) para que el zip tenga contenido sólido.
  const { db } = initLocalDb(dbPath);
  closeLocalDb(db);

  const backupDir = join(tmpDir, 'backups');
  const svc = new BackupService({ dbPath, backupDir, appVersion: '0.0.0-test' });
  const entry = await svc.createBackup();
  check('createBackup() devuelve entry', !!entry.fullPath && entry.sizeBytes > 0, `${entry.filename} (${entry.sizeBytes} bytes)`);

  // Verificar que el zip tiene magic bytes "PK"
  const zipBuf = readFileSync(entry.fullPath);
  check('archivo es ZIP (PK header)', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);

  // listBackups
  const list = await svc.listBackups();
  check('listBackups() incluye el recién creado', list.some((b) => b.fullPath === entry.fullPath), `${list.length} backup(s)`);
}

async function testImport(): Promise<void> {
  console.log('\n— ExcelImportService —');
  // Generar xlsx temporal con `xlsx`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xlsxMod: any = await import('xlsx');
  const XLSX = xlsxMod.default ?? xlsxMod;
  const filePath = join(tmpDir, 'stock-test.xlsx');
  const data = [
    ['barcode', 'description', 'price', 'stock'],
    ['7790000099991', 'Producto A', '100.00', '10'],
    ['7790000099992', 'Producto B', '250.50', '5'],
    ['', 'Sin barcode', '300', '1'],            // error: barcode vacío
    ['7790000099993', '', '50', '2'],            // error: description vacía
    ['7790000099994', 'Producto D', 'no-num', '7'], // error: precio inválido
    ['7790000099991', 'Duplicado', '99', '1'],   // error: barcode duplicado
  ];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'Hoja1');
  XLSX.writeFile(wb, filePath);

  const svc = new ExcelImportService();
  const parsed = await svc.parseFile(filePath);
  check('parseFile() detecta headers', parsed.headers.join(',') === 'barcode,description,price,stock', parsed.headers.join(','));
  check('parseFile() totalRows = 6', parsed.totalRows === 6, String(parsed.totalRows));

  // Para validate necesitamos repos reales
  const dbPath = join(tmpDir, 'import-test.db');
  const { db } = initLocalDb(dbPath);
  const repos = createRepositories(db);

  const validation = await svc.validate(
    filePath,
    { barcode: 'barcode', description: 'description', listPrice1: 'price', stock: 'stock' },
    repos,
  );
  check('validate() detecta 2 filas válidas', validation.valid === 2, `${validation.valid} válidas`);
  check('validate() detecta >= 4 errores', validation.errors.length >= 4, `${validation.errors.length} errores`);

  const fields = new Set(validation.errors.map((e) => e.field));
  check('errores incluyen barcode + description + listPrice1', fields.has('barcode') && fields.has('description') && fields.has('listPrice1'));

  closeLocalDb(db);
}

async function main(): Promise<void> {
  await testPrinter();
  await testBackup();
  await testImport();
}

main()
  .catch((err) => {
    console.error('\n✗ Excepción durante el test:', err);
    failures++;
  })
  .finally(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\nArchivos temporales eliminados: ${tmpDir}`);
    if (failures > 0) {
      console.error(`\nTEST HARDWARE FALLÓ — ${failures} check(s) con error.\n`);
      process.exit(1);
    }
    console.log('\nTEST HARDWARE OK ✅\n');
  });
