/**
 * StatusBar — barra superior persistente (P-MDI-LAYOUT).
 *
 * Mezcla: GlobalSearchBar + estado caja + LAN + hora + usuario.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { User, Wallet } from 'lucide-react'

import { api } from '@/lib/api'
import { GlobalSearchBar } from '@/components/GlobalSearchBar'
import { LanStatusIndicator } from '@/components/LanStatusIndicator'
import { useAuth } from '@/contexts/AuthContext'

export function StatusBar() {
  const { currentUser } = useAuth()
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  const cashQuery = useQuery({
    queryKey: ['cash', 'current'],
    queryFn: api.cash.getCurrent,
    staleTime: 15_000,
  })

  const cashLabel = cashQuery.data
    ? `Caja: abierta`
    : 'Caja cerrada'

  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')

  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-background px-3 text-sm">
      <div className="max-w-md flex-1">
        <GlobalSearchBar />
      </div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Wallet className="h-3.5 w-3.5" />
        <span>{cashLabel}</span>
      </div>
      <LanStatusIndicator />
      <div className="font-mono text-xs text-muted-foreground">{hh}:{mm}</div>
      {currentUser && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <User className="h-3.5 w-3.5" />
          <span>{currentUser.fullName}</span>
        </div>
      )}
    </div>
  )
}
