/**
 * <FormShell>
 *
 * Layout estándar para formularios que viven dentro de una `InternalWindow`.
 *  - Header opcional (título + acciones).
 *  - Body scrolleable (overflow-auto, min-h-0).
 *  - Footer fijo (acciones tipo guardar/cancelar).
 *  - Respeta el flex-col del padre y NO setea height por sí mismo: usa
 *    `h-full` para llenar el contenedor que lo envuelve.
 *
 * No reemplaza el layout de pantallas grandes con tablas (Ventas/Compras/Caja).
 * Pensado para Configuracion, paneles de detalle y diálogos altos.
 */
import * as React from 'react'

import { cn } from '@/lib/utils'

export interface FormShellProps {
  title?: React.ReactNode
  headerActions?: React.ReactNode
  footer?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}

export function FormShell({
  title,
  headerActions,
  footer,
  children,
  className,
  bodyClassName,
}: FormShellProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {(title || headerActions) && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b pb-3">
          {title ? <div className="text-base font-semibold">{title}</div> : <div />}
          {headerActions ? <div className="flex items-center gap-2">{headerActions}</div> : null}
        </div>
      )}
      <div className={cn('min-h-0 flex-1 overflow-auto py-3', bodyClassName)}>{children}</div>
      {footer && (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t pt-3">
          {footer}
        </div>
      )}
    </div>
  )
}
