import { StrictMode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import { TooltipProvider } from '@/components/ui/tooltip'
import { LanProvider } from '@/contexts/LanContext'
import { LicenseProvider } from '@/contexts/LicenseContext'
import { queryClient, subscribeToDataChanges } from '@/lib/queryClient'
import { router } from '@/router'
import { estaEnOscuro, iniciarTema } from '@/lib/tema'
import './index.css'

// En Windows el puntero blanco del SO se pierde sobre el fondo claro. Marcamos
// el <html> para aplicar un cursor de alto contraste sólo en esa plataforma
// (en macOS dejamos el cursor nativo).
if (navigator.userAgent.includes('Windows')) {
  document.documentElement.classList.add('is-windows')
}

// Tema claro/oscuro: se aplica ANTES de dibujar nada para que no haya un
// destello blanco, y vale para todas las ventanas (todas arrancan por acá).
iniciarTema()

/** El Toaster de sonner tiene su propio tema: lo sigue a la pantalla. */
function ToasterConTema() {
  const [oscuro, setOscuro] = useState(estaEnOscuro())
  useEffect(() => {
    const f = () => setOscuro(estaEnOscuro())
    window.addEventListener('stockflow:tema', f)
    return () => window.removeEventListener('stockflow:tema', f)
  }, [])
  return (
    // offset: la barra de título (32 px) es zona de arrastre de la ventana; con el
    // offset por defecto la X del aviso caía sobre ella y el clic movía la
    // ventana en vez de cerrar (Bruno, 13-oct-2026: «ninguno se puede cerrar»).
    // Portal a <body>: dentro de #root, el aviso quedaba DEBAJO del velo de los
    // diálogos (z-50) y la X no recibía el clic (Bruno, 13-oct-2026). En <body>
    // es hermano de los diálogos y su z-index (sonner) gana.
    createPortal(
      <Toaster position="top-right" offset="52px" richColors closeButton theme={oscuro ? 'dark' : 'light'} />,
      document.body,
    )
  )
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('No se encontró el elemento #root')

// Si la página la sirvió el servidor (puesto que entra por navegador), no hay
// preload de Electron que arme `window.stockflow`: lo monta el puente web.
if (!window.stockflow) {
  const { instalarPuenteWeb } = await import('@/web/webBridge')
  instalarPuenteWeb()
}

subscribeToDataChanges()

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={300}>
        <LanProvider>
          <LicenseProvider>
            <RouterProvider router={router} />
            <ToasterConTema />
          </LicenseProvider>
        </LanProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
