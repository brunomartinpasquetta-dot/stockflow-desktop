/**
 * Smoke del XML que se le manda a ARCA — RG 5616. Corre con:
 *   pnpm --filter @stockflow/desktop test:fiscal-xml
 *
 * Es la versión SIN base de datos del `fiscal.smoke`, para que pueda correr en
 * la CI de cada release (los smokes que abren la DB necesitan el ABI de
 * Electron y por eso no están en el workflow). Cubre lo que no puede romperse
 * nunca: que el pedido de CAE lleve la condición frente al IVA del receptor, en
 * la posición correcta, y que la tabla de códigos siga siendo la de ARCA.
 *
 * Desde el 1/12/2026 ARCA rechaza cualquier comprobante sin ese campo.
 */
import {
  MONOTRIBUTO_CLASS_A_LEGEND,
  RECEIVER_VAT_CONDITION_CLASSES,
  RECEIVER_VAT_CONDITION_IDS,
  isReceiverVatConditionAllowed,
  resolveReceiverVatConditionId,
  resolveVoucherLetter,
  validateForLetter,
} from '@stockflow/shared';

import { WsfeClient } from '../fiscal/WsfeClient';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failures++;
  }
}

/* ARCA simulado: guarda el XML y devuelve un CAE. */
let ultimoXml = '';
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  ultimoXml = init?.body ?? '';
  return {
    text: async () => `<?xml version="1.0"?><s><FeCabResp><Resultado>A</Resultado></FeCabResp>
      <FECAEDetResponse><Resultado>A</Resultado><CAE>75000000000001</CAE>
      <CAEFchVto>20261231</CAEFchVto></FECAEDetResponse></s>`,
  } as Response;
}) as unknown as typeof fetch;

const client = new WsfeClient('https://wswhomo.afip.gov.ar/wsfev1/service.asmx', {
  token: 't',
  sign: 's',
  cuit: '20331225577',
});

function condicion(xml: string): number | null {
  const m = /<ar:CondicionIVAReceptorId>(\d+)<\/ar:CondicionIVAReceptorId>/.exec(xml);
  return m?.[1] ? Number(m[1]) : null;
}

async function main(): Promise<void> {
  console.log('\nSmoke XML de ARCA (RG 5616 — condición IVA del receptor)\n');

  console.log('[el pedido de CAE lleva el campo]');
  for (const [categoria, codigo] of Object.entries(RECEIVER_VAT_CONDITION_IDS)) {
    await client.requestCae({
      salePoint: 1,
      voucherCode: 6,
      number: 1,
      date: new Date(2026, 8, 9),
      docType: 96,
      docNumber: '33122557',
      receiverVatConditionId: codigo,
      netAmount: 1000,
      vatAmount: 210,
      total: 1210,
      vatDetails: [{ id: 5, baseAmount: 1000, amount: 210 }],
    });
    check(`categoría ${categoria} → CondicionIVAReceptorId ${codigo}`, condicion(ultimoXml) === codigo, `enviado: ${condicion(ultimoXml)}`);
  }

  // El esquema de ARCA es posicional: si el campo se corre de lugar, el
  // servicio no lo ve y responde "campo obligatorio" (error 10246).
  const posCond = ultimoXml.indexOf('<ar:CondicionIVAReceptorId>');
  check(
    'va después de MonCotiz',
    posCond > ultimoXml.indexOf('<ar:MonCotiz>') && ultimoXml.includes('<ar:MonCotiz>'),
  );
  check('va antes del detalle de IVA', posCond < ultimoXml.indexOf('<ar:Iva>'));
  check('aparece una sola vez', ultimoXml.split('<ar:CondicionIVAReceptorId>').length - 1 === 1);

  console.log('\n[tabla de códigos de ARCA (manual WSFEv1 v4.7, pág. 203)]');
  const esperada: Record<number, string[]> = {
    1: ['A', 'C'],
    4: ['B', 'C'],
    5: ['B', 'C'],
    6: ['A', 'C'],
    7: ['B', 'C'],
    8: ['B', 'C'],
    9: ['B', 'C'],
    10: ['B', 'C'],
    13: ['A', 'C'],
    15: ['B', 'C'],
    16: ['A', 'C'],
  };
  for (const [id, clases] of Object.entries(esperada)) {
    const actual = RECEIVER_VAT_CONDITION_CLASSES[Number(id)] ?? [];
    check(`código ${id} admite ${clases.join('/')}`, [...actual].sort().join() === clases.sort().join(), `actual: ${actual.join('/')}`);
  }
  check('Consumidor Final = 5', RECEIVER_VAT_CONDITION_IDS.CF === 5);
  check('Monotributo = 6 y NO admite clase B', RECEIVER_VAT_CONDITION_IDS.MT === 6 && !isReceiverVatConditionAllowed(6, 'B'));
  check('resolveReceiverVatConditionId(CF) = 5', resolveReceiverVatConditionId('CF') === 5);

  console.log('\n[letra del comprobante]');
  check('emisor RI + cliente RI → A', resolveVoucherLetter('RI', 'RI') === 'A');
  check('emisor RI + cliente Monotributo → A (RG 5616)', resolveVoucherLetter('RI', 'MT') === 'A');
  check('emisor RI + consumidor final → B', resolveVoucherLetter('RI', 'CF') === 'B');
  check('emisor RI + exento → B', resolveVoucherLetter('RI', 'EX') === 'B');
  check('emisor Monotributo → siempre C', ['RI', 'MT', 'CF', 'EX'].every((c) => resolveVoucherLetter('MT', c as 'RI') === 'C'));

  console.log('\n[validaciones previas al CAE]');
  const cuit = { docType: 80, docNumber: '27222222228' };
  check('B a un Monotributista se rechaza local', !validateForLetter('B', cuit, 6).ok);
  check('A a un Consumidor Final se rechaza local', !validateForLetter('A', cuit, 5).ok);
  check('A sin CUIT se rechaza local', !validateForLetter('A', { docType: 96, docNumber: '33122557' }, 1).ok);
  check('A a un Monotributista con CUIT es válida', validateForLetter('A', cuit, 6).ok);
  check('B a un consumidor final sin identificar es válida', validateForLetter('B', { docType: 99, docNumber: '0' }, 5).ok);
  check('la leyenda de Factura A a monotributista está definida', MONOTRIBUTO_CLASS_A_LEGEND.includes('Régimen General'));

  globalThis.fetch = realFetch;
  console.log(failures === 0 ? '\n✅ TODO OK\n' : `\n❌ ${failures} FALLAS\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('\n💥 el smoke reventó:', err);
  process.exit(1);
});
