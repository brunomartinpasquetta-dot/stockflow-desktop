/**
 * WelcomeScreen — pantalla principal del Desktop cuando no hay ventanas abiertas
 * (P-MDI-LAYOUT). Logo + branding + 4 accesos rápidos.
 */
import { useEffect, useState } from 'react'
import { Boxes, Package, Receipt, Users, Wallet } from 'lucide-react'

import { api } from '@/lib/api'
import { useWindowManager } from '@/contexts/WindowManagerContext'

export function WelcomeScreen() {
  const wm = useWindowManager()
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    api.system.getVersion().then((r) => setVersion(r.version)).catch(() => undefined)
  }, [])

  const QUICK = [
    { pageKey: 'ventas', label: 'Nueva Venta', shortcut: 'F6', icon: Receipt },
    { pageKey: 'caja', label: 'Caja', shortcut: 'F7', icon: Wallet },
    { pageKey: 'articulos', label: 'Artículos', shortcut: 'F1', icon: Package },
    { pageKey: 'clientes', label: 'Clientes', shortcut: 'F3', icon: Users },
  ]

  return (
    <div className="flex h-full flex-col items-center justify-center px-8 py-12">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg">
        <Boxes className="h-12 w-12" />
      </div>
      <h1 className="text-3xl font-semibold text-foreground">StockFlow</h1>
      <p className="mt-1 text-sm text-muted-foreground">Sistema de Gestión Comercial</p>

      <div className="mt-10 grid w-full max-w-3xl grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {QUICK.map((q) => {
          const Icon = q.icon
          return (
            <button
              key={q.pageKey}
              type="button"
              onClick={() => wm.openWindow({ pageKey: q.pageKey })}
              className="flex flex-col items-center gap-2 rounded-lg border bg-card p-5 text-card-foreground shadow-sm transition-colors hover:border-primary hover:bg-primary/5"
            >
              <Icon className="h-8 w-8 text-primary" />
              <span className="text-sm font-medium">{q.label}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{q.shortcut}</span>
            </button>
          )
        })}
      </div>

      <div className="mt-12 text-[11px] text-muted-foreground">
        {version && <span>StockFlow v{version}</span>}
      </div>
    </div>
  )
}
