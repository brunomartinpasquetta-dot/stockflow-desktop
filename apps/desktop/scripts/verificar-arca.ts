/**
 * Prueba de punta a punta contra ARCA HOMOLOGACIÓN, con un certificado real.
 *
 *   ARCA_DIR=~/ruta/al/certificado ARCA_CUIT=20111111112 \
 *     pnpm --filter @stockflow/desktop test:arca
 *
 * En esa carpeta tienen que estar `stockflow.crt` y `stockflow.key`. SIEMPRE
 * contra homologación: los endpoints están fijos a propósito, para que no haya
 * forma de emitir un comprobante real desde acá.
 *
 * Usa el MISMO código que la app (WsaaClient + WsfeClient), así que lo que se
 * verifica acá es exactamente lo que hace StockFlow al facturar.
 *
 * Qué comprueba:
 *  1. Login WSAA con el certificado (firma CMS).
 *  2. Estado de los servidores (FEDummy).
 *  3. Puntos de venta habilitados y de qué tipo (FEParamGetPtosVenta).
 *  4. La TABLA REAL de condiciones frente al IVA del receptor
 *     (FEParamGetCondicionIvaReceptor), contrastada con la que tiene el código.
 *  5. Emisión real de comprobantes con el campo CondicionIVAReceptorId.
 */
import path from 'node:path';

import {
  RECEIVER_VAT_CONDITION_CLASSES,
  RECEIVER_VAT_CONDITION_IDS,
  RECEIVER_VAT_CONDITION_LABELS,
} from '@stockflow/shared';

import { WsaaClient, extractTag } from '../electron/fiscal/WsaaClient';
import { WsfeClient } from '../electron/fiscal/WsfeClient';

const DIR = process.env.ARCA_DIR ?? '';
const CUIT = (process.env.ARCA_CUIT ?? '').replace(/\D/g, '');
const WSAA = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
const WSFE = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';

function ok(label: string, cond: boolean, detail = ''): void {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Llamada SOAP cruda, para los métodos que el cliente de la app no expone. */
async function soap(action: string, inner: string, auth: { token: string; sign: string }): Promise<string> {
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/">',
    '<soapenv:Header/><soapenv:Body>',
    `<ar:${action}>`,
    `<ar:Auth><ar:Token>${auth.token}</ar:Token><ar:Sign>${auth.sign}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>`,
    inner,
    `</ar:${action}>`,
    '</soapenv:Body></soapenv:Envelope>',
  ].join('');
  const r = await fetch(WSFE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `http://ar.gov.afip.dif.FEV1/${action}` },
    body,
  });
  return r.text();
}

function todos(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) if (m[1]) out.push(m[1]);
  return out;
}

async function main(): Promise<void> {
  if (!DIR || !CUIT) {
    console.error('Faltan ARCA_DIR (carpeta con stockflow.crt y .key) y ARCA_CUIT.');
    process.exit(2);
  }
  console.log('\n═══ ARCA HOMOLOGACIÓN — prueba con certificado real ═══\n');

  /* 1 · Login */
  console.log('[1] Autenticación WSAA');
  const wsaa = new WsaaClient({
    certPath: path.join(DIR, 'stockflow.crt'),
    keyPath: path.join(DIR, 'stockflow.key'),
    wsaaUrl: WSAA,
    service: 'wsfe',
    cacheDir: path.join(DIR, 'cache'),
    cuit: CUIT,
  });
  const ta = await wsaa.getAccessTicket();
  ok('login con el certificado', ta.token.length > 0, `ticket válido hasta ${new Date(ta.expiresAt).toLocaleString('es-AR')}`);

  const client = WsfeClient.fromTicket(WSFE, ta, CUIT);

  /* 2 · Servidores */
  console.log('\n[2] Estado de los servidores');
  const d = await client.dummy();
  ok('FEDummy', d.app === 'OK' && d.db === 'OK' && d.auth === 'OK', `app=${d.app} base=${d.db} auth=${d.auth}`);

  /* 3 · Puntos de venta */
  console.log('\n[3] Puntos de venta habilitados');
  let puntos: { number: number; type: string; blocked: boolean }[] = [];
  try {
    puntos = await client.salePoints();
    if (puntos.length === 0) console.log('    (ARCA no devolvió ninguno; en homologación se suele poder usar el 1 igual)');
    for (const p of puntos) console.log(`    · ${p.number} — ${p.type}${p.blocked ? ' [BLOQUEADO]' : ''}`);
  } catch (e) {
    console.log('    no se pudo consultar:', e instanceof Error ? e.message : String(e));
  }

  /* 4 · La tabla real de condiciones IVA del receptor */
  console.log('\n[4] Tabla de condición IVA del receptor, según ARCA');
  const xmlCond = await soap('FEParamGetCondicionIvaReceptor', '', ta);
  const filas = todos(xmlCond, 'CondicionIvaReceptor').map((f) => ({
    id: Number(extractTag(f, 'Id') ?? '0'),
    desc: extractTag(f, 'Desc') ?? '',
    clase: (extractTag(f, 'Cmp_Clase') ?? '').trim(),
  }));
  if (filas.length === 0) {
    console.log('    respuesta sin filas:', xmlCond.slice(0, 400));
  } else {
    for (const f of filas) console.log(`    · ${String(f.id).padStart(2)} ${f.desc.padEnd(42)} clase: ${f.clase || '(todas)'}`);

    console.log('\n    Contraste con lo que tiene el código:');
    for (const f of filas) {
      const nuestro = RECEIVER_VAT_CONDITION_LABELS[f.id];
      if (nuestro === undefined) continue;
      ok(`código ${f.id} — "${f.desc}"`, true, `nosotros: "${nuestro}"`);
    }
    const idsArca = new Set(filas.map((f) => f.id));
    for (const [cat, id] of Object.entries(RECEIVER_VAT_CONDITION_IDS)) {
      ok(`la categoría ${cat} usa el código ${id} y ARCA lo reconoce`, idsArca.has(id));
    }
    // La clase que ARCA declara para cada código, contra nuestra tabla.
    for (const f of filas) {
      const nuestras = RECEIVER_VAT_CONDITION_CLASSES[f.id];
      if (!nuestras || !f.clase) continue;
      const arca = f.clase.toUpperCase();
      const coincide = nuestras.some((c) => arca.includes(c));
      ok(`código ${f.id}: clases ARCA "${arca}" vs nuestras "${nuestras.join('/')}"`, coincide);
    }
  }

  /* 5 · Emisión real */
  const pv = puntos.find((p) => !p.blocked)?.number ?? 1;
  console.log(`\n[5] Emisión de comprobantes de prueba (punto de venta ${pv})`);

  const casos = [
    { letra: 'B' as const, codigo: 6, cond: RECEIVER_VAT_CONDITION_IDS.CF, docType: 99, doc: '0', nombre: 'Factura B a consumidor final' },
    { letra: 'C' as const, codigo: 11, cond: RECEIVER_VAT_CONDITION_IDS.CF, docType: 99, doc: '0', nombre: 'Factura C a consumidor final' },
    { letra: 'A' as const, codigo: 1, cond: RECEIVER_VAT_CONDITION_IDS.RI, docType: 80, doc: '20111111112', nombre: 'Factura A a Responsable Inscripto' },
    { letra: 'A' as const, codigo: 1, cond: RECEIVER_VAT_CONDITION_IDS.MT, docType: 80, doc: '20111111112', nombre: 'Factura A a Monotributista (RG 5616)' },
  ];

  for (const c of casos) {
    try {
      const esC = c.letra === 'C';
      const r = await client.requestCae({
        salePoint: pv,
        voucherCode: c.codigo,
        date: new Date(),
        docType: c.docType,
        docNumber: c.doc,
        receiverVatConditionId: c.cond,
        netAmount: esC ? 121 : 100,
        vatAmount: esC ? 0 : 21,
        total: 121,
        vatDetails: esC ? [] : [{ id: 5, baseAmount: 100, amount: 21 }],
      });
      ok(c.nombre, true, `CAE ${r.cae} · N° ${r.number}${r.observations.length ? ' · obs: ' + r.observations.join(' | ') : ''}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Un rechazo por condición del emisor (no es RI, no tiene ese PV) no es
      // un fallo del campo nuevo: se distingue por el código.
      const porCampo = /1024[23456]/.test(msg);
      ok(c.nombre, false, msg.slice(0, 220) + (porCampo ? '   ← ¡ES DEL CAMPO NUEVO!' : ''));
    }
  }

  console.log('\n═══ fin ═══\n');
}

void main().catch((e) => {
  console.error('\n💥', e instanceof Error ? e.message : e);
  process.exit(1);
});
