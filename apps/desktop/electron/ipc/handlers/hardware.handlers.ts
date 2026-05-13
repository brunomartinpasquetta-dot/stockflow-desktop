/**
 * Handlers IPC para hardware (impresora, balanza, cajón monedero).
 */
import { requirePermission } from '@stockflow/core';

import type {
  CashCloseReportData,
  PrinterConfig,
  SaleTicketData,
  ScaleConfig,
  SerialPortInfo,
  UsbDeviceInfo,
  WeightReading,
} from '../../hardware/types';
import { type HandlerDeps, type HandlerMap, unguarded, withSession } from '../handler-context';

export function buildHardwareHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'hardware:printer:list-usb': unguarded(
      deps,
      async (): Promise<UsbDeviceInfo[]> => deps.hardware.listUsbDevices(),
    ),
    'hardware:printer:list-serial': unguarded(
      deps,
      async (): Promise<SerialPortInfo[]> => deps.hardware.listSerialPorts(),
    ),
    'hardware:printer:get-config': unguarded(deps, async (): Promise<PrinterConfig | null> => {
      return deps.hardware.getConfig().printer;
    }),
    'hardware:printer:set-config': withSession(
      deps,
      async (payload: PrinterConfig | null, ctx): Promise<{ ok: true }> => {
        requirePermission(ctx.currentUser, 'manage_hardware');
        await deps.hardware.setPrinterConfig(payload);
        return { ok: true };
      },
    ),
    'hardware:printer:test': withSession(deps, async (): Promise<{ ok: true }> => {
      const printer = deps.hardware.getPrinter();
      if (!printer) throw new Error('Impresora no configurada');
      await printer.testPrint();
      return { ok: true };
    }),
    'hardware:printer:print-sale-ticket': withSession(
      deps,
      async (payload: SaleTicketData): Promise<{ ok: true }> => {
        const printer = deps.hardware.getPrinter();
        if (!printer) throw new Error('Impresora no configurada');
        await printer.printSaleTicket(payload);
        return { ok: true };
      },
    ),
    'hardware:printer:print-cash-close': withSession(
      deps,
      async (payload: CashCloseReportData): Promise<{ ok: true }> => {
        const printer = deps.hardware.getPrinter();
        if (!printer) throw new Error('Impresora no configurada');
        await printer.printCashCloseReport(payload);
        return { ok: true };
      },
    ),
    'hardware:cash-drawer:open': withSession(deps, async (): Promise<{ ok: true }> => {
      const printer = deps.hardware.getPrinter();
      if (!printer) throw new Error('Impresora no configurada');
      await printer.openCashDrawer();
      return { ok: true };
    }),
    'hardware:scale:get-config': unguarded(deps, async (): Promise<ScaleConfig | null> => {
      return deps.hardware.getConfig().scale;
    }),
    'hardware:scale:set-config': withSession(
      deps,
      async (payload: ScaleConfig | null, ctx): Promise<{ ok: true }> => {
        requirePermission(ctx.currentUser, 'manage_hardware');
        await deps.hardware.setScaleConfig(payload);
        return { ok: true };
      },
    ),
    'hardware:scale:read': withSession(deps, async (): Promise<WeightReading> => {
      const scale = deps.hardware.getScale();
      if (!scale) throw new Error('Balanza no configurada');
      return scale.requestWeight();
    }),
  };
}
