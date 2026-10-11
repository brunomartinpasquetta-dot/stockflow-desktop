import iconSvg from './branding/icon.svg'
import iconPng from './branding/icon-512.png'
import logoFull from './branding/logo-full.svg'
import logoFullOscuro from './branding/logo-full-oscuro.svg'
import logoTagline from './branding/logo-tagline.svg'
import logoWhite from './branding/logo-white.svg'
import logoMono from './branding/logo-mono.svg'
import logoStacked from './branding/logo-stacked.png'
import logoStackedOscuro from './branding/logo-stacked-oscuro.png'
import logoHorizontal from './branding/logo-horizontal.png'
import logoHorizontalOscuro from './branding/logo-horizontal-oscuro.png'

// Las variantes «Oscuro» llevan el mismo isotipo y el texto en claro: el azul
// marino de «Stock» no se lee sobre el tema oscuro. Se eligen con <LogoMarca>.
export const BRANDING = {
  iconSvg,
  iconPng,
  logoFull,
  logoFullOscuro,
  logoTagline,
  logoWhite,
  logoMono,
  logoStacked,
  logoStackedOscuro,
  logoHorizontal,
  logoHorizontalOscuro,
} as const
