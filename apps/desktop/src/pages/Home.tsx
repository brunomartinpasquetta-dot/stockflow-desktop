import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Package, Truck, Users } from 'lucide-react'

import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import { useArticles, useCustomers } from '@/lib/hooks'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export function Home() {
  const { currentUser } = useAuth()
  const company = useQuery({ queryKey: ['company'], queryFn: api.company.get })
  const articles = useArticles()
  const customers = useCustomers()

  const cards = [
    { to: '/articulos', label: 'Artículos', icon: Package, count: articles.data?.length },
    { to: '/proveedores', label: 'Proveedores', icon: Truck, count: undefined },
    { to: '/clientes', label: 'Clientes', icon: Users, count: customers.data?.length },
  ]

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">{company.data?.name ?? 'StockFlow'}</h1>
        <p className="text-sm text-muted-foreground">Hola, {currentUser?.fullName}. Usá los atajos F1–F12 o el menú lateral.</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {cards.map((c) => {
          const Icon = c.icon
          return (
            <Link key={c.to} to={c.to}>
              <Card className="transition-colors hover:bg-accent">
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>{c.label}</CardTitle>
                  <Icon className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <span className="text-2xl font-semibold">{c.count ?? '—'}</span>
                  <span className="ml-1 text-xs text-muted-foreground">registro(s)</span>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Próximas funciones</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Compras (F5), Ventas / PDV (F6), Caja (F7), Estadísticas (F8), Movimientos (F9) y Contabilidad (F10) llegan en
          los próximos pasos.
        </CardContent>
      </Card>
    </div>
  )
}
