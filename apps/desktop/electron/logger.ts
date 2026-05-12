/**
 * Configuración de electron-log para el proceso main. Redirige `console.*` del
 * main hacia el log persistente (archivo + consola) para que los errores
 * INTERNAL serializados en los handlers queden registrados.
 */
import log from 'electron-log/main';

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
