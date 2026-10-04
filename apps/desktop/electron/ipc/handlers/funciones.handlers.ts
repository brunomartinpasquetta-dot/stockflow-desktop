/**
 * Edición de la licencia (común / multisucursal) para la interfaz.
 *
 * Viaja por la red como los datos (grupo `funciones` en LAN_ROUTED_GROUPS):
 * en una terminal manda la licencia del SERVIDOR, que es la del comercio;
 * la terminal no tiene licencia propia. El hook `useFuncion` de la interfaz
 * lee este canal.
 *
 * Interruptor "Edición Multisucursal (versión de prueba)"
 * (`funciones:edicionPrueba` / `funciones:setEdicionPrueba`): existe sólo si
 * la versión de la app es de prueba (-alpha/-beta/-rc); en una final
 * `disponible` es false y activarlo se rechaza, exista o no el archivo (ver
 * license/funciones.ts). Es de la PC que tiene la base: desde una terminal o
 * por internet se rechaza (LAN_SERVER_DENIED_CHANNELS / REMOTO_DENIED_CHANNELS).
 */
import { BusinessRuleError, PermissionDeniedError, requirePermission, ValidationError } from '@stockflow/core';

import { tieneMultisucursal } from '../../license/funciones';
import { cajaPorPcActiva, cajaPorPcDelComercio, compartirCajaDelServidor, hayCajasAbiertasDeOtrasPc } from '../caja-por-pc';
import { type HandlerDeps, type HandlerMap, withSession } from '../handler-context';
import type { EdicionPruebaDTO, FuncionesDTO } from '../types';

export function buildFuncionesHandlers(deps: HandlerDeps): HandlerMap {
  return {
    'funciones:estado': withSession(deps, (): FuncionesDTO => {
      const multisucursal = tieneMultisucursal(deps);
      return { edicion: multisucursal ? 'multisucursal' : 'comun', multisucursal, cajaPorPc: cajaPorPcActiva(deps) };
    }),
    'funciones:edicionPrueba': withSession(deps, (): EdicionPruebaDTO => deps.licenseManager.getEdicionPrueba()),
    'funciones:setEdicionPrueba': withSession(deps, (payload: { activa?: unknown }, ctx): EdicionPruebaDTO => {
      // Sólo un administrador con permiso de configuración de la empresa.
      if (ctx.currentUser.role !== 'admin') throw new PermissionDeniedError('manage_company', ctx.currentUser.role);
      requirePermission(ctx.currentUser, 'manage_company');
      const estado = deps.licenseManager.getEdicionPrueba();
      if (!estado.disponible) {
        throw new BusinessRuleError(
          'edicion_prueba_no_disponible',
          'La edición Multisucursal de prueba sólo existe en las versiones de prueba. En esta versión la edición la define la licencia.',
        );
      }
      const activa = payload?.activa === true;
      if (activa === estado.activa) return estado;
      if (activa) {
        // Multisucursal fuerza la caja por PC: la misma transición que al
        // prenderla a mano (lan:setCajaPorPc), para que nadie quede sin caja.
        if (!cajaPorPcActiva(deps)) compartirCajaDelServidor(deps);
      } else {
        // Al volver a común la caja por PC queda como la tenga el comercio;
        // si se apaga, no puede haber cajas abiertas de otras PC.
        const seguiraPorPc = estado.edicionReal === 'multisucursal' || cajaPorPcDelComercio(deps);
        if (!seguiraPorPc && hayCajasAbiertasDeOtrasPc(deps)) {
          throw new ValidationError(
            'edicionPrueba',
            'Hay cajas abiertas en otras PC. Ciérrelas desde el Historial de cajas antes de desactivar la edición de prueba.',
          );
        }
      }
      const nuevo = deps.licenseManager.setEdicionPrueba(activa);
      // El mismo aviso que cuando cambia la licencia: la interfaz de todas las
      // ventanas refresca la edición sin reiniciar.
      deps.emit('license:changed', null);
      return nuevo;
    }),
  };
}
