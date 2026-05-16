import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import { TooltipProvider } from '@/components/ui/tooltip'
import { LanProvider } from '@/contexts/LanContext'
import { LicenseProvider } from '@/contexts/LicenseContext'
import { queryClient } from '@/lib/queryClient'
import { router } from '@/router'
import './index.css'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('No se encontró el elemento #root')

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
