/**
 * El QR de Mercado Pago es UNO por instalación (Bruno, 11-oct-2026): el que se
 * imprimió y está pegado en el mostrador. Vale para todas las aperturas de
 * caja; lo que cambia por venta es el importe. La pantalla elige el mismo que
 * el servidor: el primero que se vinculó y sigue activo. Las filas de
 * `mp_pos_devices` conservan en qué caja diaria se creó cada uno (histórico),
 * pero eso ya no decide cuál se usa.
 */
export interface DispositivoQr {
  cashRegisterId: string
  active: boolean
  createdAt: number
}

export function qrDeLaInstalacion<T extends DispositivoQr>(lista: readonly T[] | undefined): T | null {
  const activos = (lista ?? []).filter((d) => d.active).sort((a, b) => a.createdAt - b.createdAt)
  return activos[0] ?? null
}
