import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import { TooltipProvider } from '@/components/ui/tooltip'
import { LanProvider } from '@/contexts/LanContext'
import { LicenseProvider } from '@/contexts/LicenseContext'
import { queryClient, subscribeToDataChanges } from '@/lib/queryClient'
import { router } from '@/router'
import './index.css'

// En Windows el puntero blanco del SO se pierde sobre el fondo claro. Marcamos
// el <html> para aplicar un cursor de alto contraste sólo en esa plataforma
// (en macOS dejamos el cursor nativo).
if (navigator.userAgent.includes('Windows')) {
  document.documentElement.classList.add('is-windows')
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
            <Toaster position="top-right" richColors closeButton />
          </LicenseProvider>
        </LanProvider>
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
)
