/**
 * Smoke test de la lógica de precios/IVA (funciones puras, sin DB).
 *   pnpm --filter @stockflow/core test:smoke:pricing
 */
import type { Article, Customer } from '@stockflow/shared';

import { applyDiscount, calculateSaleTotals, calculateVAT, resolvePrice } from '../index';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

function fakeArticle(over: Partial<Article>): Article {
  return {
    id: 'a1',
    barcode: '000',
    description: 'x',
    brand: null,
    familyId: null,
    supplierId: null,
    costPrice: '0.0000',
    listPrice1: '100.0000',
    listPrice2: '90.0000',
    listPrice3: '80.0000',
    wholesalePrice: '70.0000',
    wholesaleMinQty: '10.000',
    vatRate: '21.00',
    stock: '0.000',
    minStock: '0.000',
    idealStock: '0.000',
    soldByWeight: false,
    unit: 'UN',
    imagePath: null,
    notes: null,
    active: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}
function fakeCustomer(over: Partial<Customer>): Customer {
  return {
    id: 'c1',
    lastName: 'X',
    firstName: null,
    address: null,
    city: null,
    phone: null,
    mobile: null,
    docType: null,
    docNumber: null,
    category: 'CF',
    priceList: 1,
    creditLimit: '0.0000',
    email: null,
    facebook: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

console.log('\nSmoke test — pricing\n');

// resolvePrice: minorista por lista
const art = fakeArticle({});
check('resolvePrice lista 1', resolvePrice(art, fakeCustomer({ priceList: 1 }), '5.000') === '100.0000');
check('resolvePrice lista 2', resolvePrice(art, fakeCustomer({ priceList: 2 }), '5.000') === '90.0000');
check('resolvePrice lista 3', resolvePrice(art, fakeCustomer({ priceList: 3 }), '5.000') === '80.0000');

// resolvePrice: mayorista cuando quantity >= wholesaleMinQty
check(
  'resolvePrice quantity=5 (< minQty 10) → listPrice1',
  resolvePrice(art, fakeCustomer({ priceList: 1 }), '5.000') === '100.0000',
);
check(
  'resolvePrice quantity=15 (>= minQty 10) → wholesalePrice',
  resolvePrice(art, fakeCustomer({ priceList: 1 }), '15.000') === '70.0000',
);
check(
  'resolvePrice sin precio mayorista → siempre lista',
  resolvePrice(fakeArticle({ wholesalePrice: '0.0000' }), fakeCustomer({ priceList: 1 }), '99.000') === '100.0000',
);

// applyDiscount
check('applyDiscount 10%', applyDiscount('100', '10') === '90.0000');
check('applyDiscount 0%', applyDiscount('100', '0') === '100.0000');
check('applyDiscount 50% sobre 250', applyDiscount('250.0000', '50') === '125.0000');

// IVA contenido (modo 'gross') vs agregado (modo 'net')
const vat = calculateVAT('121.0000', '21.00', 'gross');
check('calculateVAT gross: net', vat.net === '100.0000', `net=${vat.net}`);
check('calculateVAT gross: vat', vat.vat === '21.0000', `vat=${vat.vat}`);
const vatAdd = calculateVAT('100.0000', '21.00', 'net');
check('calculateVAT net: gross', vatAdd.gross === '121.0000', `gross=${vatAdd.gross}`);
check('calculateVAT net: vat', vatAdd.vat === '21.0000', `vat=${vatAdd.vat}`);
check('calculateVAT tasa 0 → vat 0', calculateVAT('100.0000', '0.00', 'gross').vat === '0.0000');

// calculateSaleTotals
const totals = calculateSaleTotals(
  [
    { quantity: '2.000', unitPrice: '850.0000', vatRate: '21.00' },
    { quantity: '1.000', unitPrice: '100.0000', vatRate: '21.00', discount: '0.0000' },
  ],
  '0.0000',
);
check('calculateSaleTotals subtotal', totals.subtotal === '1800.0000', `subtotal=${totals.subtotal}`);
check('calculateSaleTotals total', totals.total === '1800.0000', `total=${totals.total}`);
check('calculateSaleTotals 2 líneas', totals.lines.length === 2);
const totalsDisc = calculateSaleTotals([{ quantity: '1.000', unitPrice: '1000.0000' }], '100.0000');
check('calculateSaleTotals con descuento global', totalsDisc.total === '900.0000', `total=${totalsDisc.total}`);

if (failures > 0) {
  console.error(`\nSMOKE TEST (pricing) FALLÓ — ${failures} check(s) con error.\n`);
  process.exit(1);
}
console.log('\nSMOKE TEST (pricing) OK ✅\n');
