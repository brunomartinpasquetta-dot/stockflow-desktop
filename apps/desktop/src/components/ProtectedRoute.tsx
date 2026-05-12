import { Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'

import { useAuth } from '@/contexts/AuthContext'
import { Layout } from '@/components/Layout'

export function ProtectedRoute() {
  const { currentUser, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!currentUser) return <Navigate to="/login" replace />
  return <Layout />
}
