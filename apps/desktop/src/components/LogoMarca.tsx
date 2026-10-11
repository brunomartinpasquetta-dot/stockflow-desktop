/**
 * Logo con texto («StockFlow»), en la versión que corresponde al tema.
 *
 * En el tema oscuro el texto va en claro: el azul marino de «Stock» (#0B2660)
 * sobre el fondo oscuro no se lee. Se resuelven las dos imágenes por CSS
 * (`dark:`), así cambian al instante con el tema y sin estado.
 */
import { BRANDING } from '@/assets/branding'
import { cn } from '@/lib/utils'

type Variante = 'apilado' | 'horizontal' | 'completo'

const FUENTES: Record<Variante, { claro: string; oscuro: string }> = {
  apilado: { claro: BRANDING.logoStacked, oscuro: BRANDING.logoStackedOscuro },
  horizontal: { claro: BRANDING.logoHorizontal, oscuro: BRANDING.logoHorizontalOscuro },
  completo: { claro: BRANDING.logoFull, oscuro: BRANDING.logoFullOscuro },
}

export function LogoMarca({
  variante,
  className,
  alt = 'StockFlow',
}: {
  variante: Variante
  className?: string
  alt?: string
}) {
  const f = FUENTES[variante]
  return (
    <>
      <img src={f.claro} alt={alt} className={cn(className, 'dark:hidden')} draggable={false} />
      <img src={f.oscuro} alt="" aria-hidden className={cn(className, 'hidden dark:block')} draggable={false} />
    </>
  )
}
