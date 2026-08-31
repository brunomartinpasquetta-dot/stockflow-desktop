/**
 * Pruebas de los FLUJOS DE DIAGNÓSTICO de Flowy (E3). Corre con:
 *   pnpm --filter @stockflow/desktop test:flows
 *
 * Checks stub: se simula el estado del sistema (impresora/balanza configurada
 * o no) sin Electron ni DB.
 */
import { detectFlow, handleFlowAnswer, startFlow, flowStateOf } from '../assistant/flows';

let fails = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) fails++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  → ${extra}` : ''}`);
}

const SIN_HARDWARE = { 'printer-configured': async () => false, 'scale-configured': async () => false };
const CON_HARDWARE = { 'printer-configured': async () => true, 'scale-configured': async () => true };

const run = async (): Promise<void> => {
  /* Detección de triggers */
  check('"no me imprime el ticket" dispara el flujo de impresora', detectFlow('no me imprime el ticket') === 'impresora-no-imprime');
  check('"quiero conectar la balanza" dispara el flujo de balanza', detectFlow('quiero conectar la balanza') === 'conectar-balanza');
  check('"como hago una venta" NO dispara ningún flujo', detectFlow('como hago una venta') === null);

  /* Impresora SIN configurar: el check automático resuelve solo, sin preguntar */
  let r = await startFlow('c1', 'impresora-no-imprime', SIN_HARDWARE);
  check('sin impresora configurada → solución directa (no pregunta lo que ya sabe)', r != null && r.done && /no tiene ninguna impresora configurada/i.test(r.reply), r?.reply.slice(0, 60));
  check('… con botón a Configuración', (r?.actions ?? []).some((a) => a.screen === 'configuracion'));

  /* Impresora configurada: diagnóstico ramificado completo hasta escalar */
  r = await startFlow('c2', 'impresora-no-imprime', CON_HARDWARE);
  check('con impresora configurada → pregunta lo físico', r != null && !r.done && /encendida/i.test(r.reply), r?.reply.slice(0, 60));
  check('… con opciones como chips', (r?.suggestions ?? []).length === 2, JSON.stringify(r?.suggestions));
  r = await handleFlowAnswer('c2', 'Sí, está todo bien', CON_HARDWARE);
  check('rama sí → pregunta la prueba de impresión', r != null && /probar impresi/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));
  r = await handleFlowAnswer('c2', 'No, la prueba tampoco imprime', CON_HARDWARE);
  check('prueba no imprime → pregunta si Windows la ve', r != null && /windows|aparece/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));
  r = await handleFlowAnswer('c2', 'si', CON_HARDWARE);
  check('"si" pelado elige la única opción afirmativa → escala a soporte con datos', r != null && r.done && /soporte/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));
  check('… y el flujo quedó cerrado', flowStateOf('c2') === null);

  /* Respuesta por número */
  r = await startFlow('c3', 'impresora-no-imprime', CON_HARDWARE);
  r = await handleFlowAnswer('c3', '2', CON_HARDWARE);
  check('responder "2" elige la segunda opción', r != null && r.done && /ese suele ser el motivo/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));

  /* Cambio de tema suelta el flujo sin ruido */
  await startFlow('c4', 'impresora-no-imprime', CON_HARDWARE);
  r = await handleFlowAnswer('c4', 'cuanto vendi hoy', CON_HARDWARE);
  check('cambiar de tema → null (la pregunta sigue al motor) y flujo suelto', r === null && flowStateOf('c4') === null);

  /* Salida explícita */
  await startFlow('c5', 'impresora-no-imprime', CON_HARDWARE);
  r = await handleFlowAnswer('c5', 'salir', CON_HARDWARE);
  check('"salir" cierra el flujo con despedida', r != null && r.done && /lo dejamos/i.test(r?.reply ?? ''));

  /* Balanza ya configurada → pregunta si pesa (check automático) */
  r = await startFlow('c6', 'conectar-balanza', CON_HARDWARE);
  check('balanza configurada → pregunta si toma el peso', r != null && /peso/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));
  r = await handleFlowAnswer('c6', 'No, no toma el peso', CON_HARDWARE);
  check('no pesa → va al diagnóstico de puerto', r != null && /puerto/i.test(r?.reply ?? ''), r?.reply.slice(0, 60));

  console.log(fails === 0 ? '\n✅ TODO OK' : `\n❌ ${fails} FALLAS`);
  process.exit(fails === 0 ? 0 : 1);
};

void run();
