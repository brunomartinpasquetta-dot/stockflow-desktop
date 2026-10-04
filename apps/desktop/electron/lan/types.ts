/**
 * Tipos compartidos del modo multi-caja LAN.
 *
 * - 'single'  : modo por defecto (1 PC, sin red, IPC local).
 * - 'server'  : esta PC actúa como servidor: corre Fastify embebido y atiende
 *               las cajas cliente de la LAN.
 * - 'client'  : esta PC actúa como caja cliente: rutea las llamadas IPC de
 *               datos hacia el servidor por HTTP. El hardware (impresora,
 *               balanza) sigue siendo local.
 */
export type LanMode = 'single' | 'server' | 'client';

export interface LanConfig {
  mode: LanMode;
  /** Sólo en modo server (default 7777). */
  port?: number;
  /** Sólo en modo server: PIN de 6 dígitos que comparten clientes. */
  token?: string;
  /** Sólo en modo client: IP del servidor. */
  serverIp?: string;
  /** Sólo en modo client (default 7777). */
  serverPort?: number;
  /**
   * Sólo en modo client, MULTISUCURSAL: dirección completa del servidor
   * (`https://comercio.mistockflow.com` o `http://IP:puerto`). Si está, manda
   * sobre serverIp/serverPort. Las configs viejas no la tienen y siguen igual.
   */
  serverUrl?: string;
  /**
   * ACCESO REMOTO: si el comercio lo quiere prendido. Se guarda la INTENCIÓN,
   * no el resultado: si al arrancar no hay internet, el interruptor sigue
   * prendido y el túnel reintenta hasta lograrlo.
   */
  remotoActivado?: boolean;
  /** Dirección pública asignada a esta instalación (`cliente.dominio`). */
  remotoHostname?: string;
}

export const DEFAULT_LAN_PORT = 7777;
