/**
 * WelcomeScreen — pantalla principal del Desktop cuando no hay ventanas abiertas
 * (P-MDI-TOOLBAR). Look limpio: logo apilado (ícono + wordmark) centrado.
 *
 * Los accesos rápidos viven en QuickAccessToolbar (chrome superior), por eso
 * acá no hay cards. La versión del sistema vive en "Acerca de".
 */
import { BRANDING } from "@/assets/branding"

export function WelcomeScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center bg-gradient-to-br from-background to-muted/30 px-8 py-12">
      <img
        src={BRANDING.logoStacked}
        alt="StockFlow — Sistema de Gestión Comercial"
        className="h-auto w-[260px] select-none"
        draggable={false}
      />
    </div>
  )
}
