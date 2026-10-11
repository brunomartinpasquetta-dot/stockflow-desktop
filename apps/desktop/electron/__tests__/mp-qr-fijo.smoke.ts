/**
 * El QR de Mercado Pago es UNO por instalación y sobrevive cerrar y abrir caja.
 *
 * Caso real (Denver, 11-oct-2026): el QR vinculado el 9-oct «se desvinculó»
 * al abrir la caja del día siguiente, porque el punto de cobro estaba atado al
 * id de la caja diaria. Se prueba el ciclo COMPLETO —abrir, vincular, cerrar,
 * abrir otra— y el estado que queda, incluido el punto de cobro de más que
 * se creó al tocar «Generar QR» en la caja nueva: el sistema tiene que seguir
 * eligiendo el original, que es el cartel pegado en el mostrador.
 *   pnpm --filter @stockflow/desktop test:mp-qr-fijo
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeLocalDb, createRepositories, initLocalDb, mpConfig, mpPosDevices } from '@stockflow/db';
import { CashService, MpQrService, type ServiceContext } from '@stockflow/core';

import { qrDeLaInstalacion } from '../../src/lib/mpQr';

const dir = mkdtempSync(join(tmpdir(), 'stockflow-mp-qr-fijo-'));
let fallas = 0;
function check(ok: boolean, que: string, detalle = ''): void {
  if (!ok) fallas++;
  console.log(`${ok ? '✅' : '❌'} ${que}${!ok && detalle ? `  → ${detalle}` : ''}`);
}

async function main(): Promise<void> {
  const { db } = initLocalDb(join(dir, 'stockflow.db'));
  const repos = createRepositories(db);
  const admin = await repos.users.findByUsername('admin');
  if (!admin) throw new Error('falta el usuario admin del seed');
  const ctx = { db, repos, currentUser: admin } as unknown as ServiceContext;
  const cash = new CashService(ctx);
  // Sin red: el token no se usa porque nunca debería hacer falta crear un punto nuevo.
  const mp = new MpQrService(ctx, { encrypt: (s: string) => s, decrypt: (s: string) => s } as never);

  // Mercado Pago «configurado» (sucursal creada), como en el comercio.
  const ahora = Date.now();
  db.insert(mpConfig)
    .values({
      id: 'cfg-1',
      companyId: null,
      mpUserId: '25734945',
      accessTokenEncrypted: 'no-se-usa',
      webhookSecret: 'x',
      storeId: 'store-1',
      webhookUrlConfigured: 0,
      createdAt: ahora,
      updatedAt: ahora,
    } as never)
    .run();

  // ── Día 1: se abre la caja, se vincula el QR y se imprime el cartel ────────
  const cajaA = await cash.openCashRegister('1000.0000');
  const cartel = {
    id: 'dev-1',
    cashRegisterId: cajaA.id,
    externalPosId: 'CAJAAAAA0001',
    mpPosId: '111',
    qrUrl: 'https://mpago.la/CARTEL-ORIGINAL',
    qrImageBase64: null,
    active: 1,
    createdAt: ahora,
    updatedAt: ahora,
  };
  db.insert(mpPosDevices).values(cartel as never).run();

  const qrA = await mp.getQrForCashRegister(cajaA.id);
  check(qrA?.qrUrl === cartel.qrUrl, 'día 1: la caja abierta tiene el QR del cartel');
  const otraVezA = await mp.createPosDevice({ cashRegisterId: cajaA.id });
  check(otraVezA.id === cartel.id, 'día 1: «Generar QR» de nuevo devuelve el mismo, no crea otro');

  // ── Cierre del día y apertura del siguiente ────────────────────────────────
  await cash.closeCashRegister(cajaA.id, '1000.0000');
  const cajaB = await cash.openCashRegister('1000.0000');
  check(cajaB.id !== cajaA.id, 'día 2: la caja nueva tiene otro id (es otra sesión)');

  const qrB = await mp.getQrForCashRegister(cajaB.id);
  check(qrB?.qrUrl === cartel.qrUrl, 'día 2: la caja nueva usa el MISMO QR del cartel (no se desvinculó)', JSON.stringify(qrB));
  const devB = await mp.getPosDeviceByCashRegister(cajaB.id);
  check(devB?.id === cartel.id, 'día 2: el punto de cobro para cobrar es el original');
  const generarB = await mp.createPosDevice({ cashRegisterId: cajaB.id });
  check(generarB.id === cartel.id, 'día 2: «Generar QR» no crea un segundo punto de cobro');
  check((await mp.listPosDevices()).length === 1, 'día 2: sigue habiendo un solo punto de cobro');

  // ── Lo que pasó en Denver: quedó un segundo punto de cobro creado por error ─
  db.insert(mpPosDevices)
    .values({
      ...cartel,
      id: 'dev-2',
      cashRegisterId: cajaB.id,
      externalPosId: 'CAJABBBB0002',
      mpPosId: '222',
      qrUrl: 'https://mpago.la/CARTEL-DE-MAS',
      createdAt: ahora + 60_000,
      updatedAt: ahora + 60_000,
    } as never)
    .run();
  const conSobrante = await mp.getPosDeviceByCashRegister(cajaB.id);
  check(conSobrante?.id === cartel.id, 'con un punto de cobro de más, se sigue usando el ORIGINAL (el cartel del mostrador)', conSobrante?.id);
  const qrConSobrante = await mp.getQrForCashRegister(cajaB.id);
  check(qrConSobrante?.qrUrl === cartel.qrUrl, 'y «Ver e imprimir QR» muestra el cartel original');

  // ── La pantalla elige igual que el servidor ────────────────────────────────
  const lista = (await mp.listPosDevices()).map((d) => ({ ...d, active: d.active === 1 }));
  check(qrDeLaInstalacion(lista)?.id === cartel.id, 'la pantalla (Ventas / Configuración) elige el mismo: el original');
  check(qrDeLaInstalacion([]) === null && qrDeLaInstalacion(undefined) === null, 'sin puntos de cobro, no hay QR (se ofrece generarlo)');
  check(
    qrDeLaInstalacion(lista.map((d) => (d.id === cartel.id ? { ...d, active: false } : d)))?.id === 'dev-2',
    'si el original se da de baja, pasa a valer el siguiente activo',
  );

  // ── Día 3: otra apertura más, el cartel sigue ──────────────────────────────
  await cash.closeCashRegister(cajaB.id, '1000.0000');
  const cajaC = await cash.openCashRegister('1000.0000');
  check((await mp.getQrForCashRegister(cajaC.id))?.qrUrl === cartel.qrUrl, 'día 3: el cartel original sigue valiendo');

  closeLocalDb(db);
}

main()
  .catch((e) => {
    fallas++;
    console.error('❌ excepción:', e);
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
    console.log(fallas ? `\n❌ ${fallas} FALLAS` : '\n✅ TODO OK');
    process.exit(fallas ? 1 : 0);
  });
