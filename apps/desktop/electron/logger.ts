/**
 * Configuración de electron-log para el proceso main. Redirige `console.*` del
 * main hacia el log persistente (archivo + consola) para que los errores
 * INTERNAL serializados en los handlers queden registrados.
 *
 * Se importa el entrypoint RAÍZ ('electron-log', no 'electron-log/main'): como
 * electron-log es CJS y queda external en el bundle ESM, un subpath sin
 * extensión ('electron-log/main') no resuelve bajo la resolución ESM de Node.
 * El módulo raíz detecta `process.type === 'browser'` y expone el mismo
 * `MainLogger` (misma API y mismos tipos que 'electron-log/main').
 */
import log from 'electron-log';

export function setupLogger(): typeof log {
  const isDev = process.env.NODE_ENV === 'development';
  log.transports.file.level = 'info';
  log.transports.console.level = isDev ? 'debug' : 'info';

  console.log = log.log.bind(log);
  console.info = log.info.bind(log);
  console.warn = log.warn.bind(log);
  console.error = log.error.bind(log);
  console.debug = log.debug.bind(log);

  return log;
}

export { log };
