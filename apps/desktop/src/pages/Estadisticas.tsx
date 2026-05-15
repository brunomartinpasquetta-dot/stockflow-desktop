/**
 * Dashboard de Estadísticas (P-FIX-FASE3).
 *
 * 6 tabs: Resumen, Productos, Clientes, Proveedores, Formas de Pago, Tiempo.
 * Gráficos con `recharts`. Export Excel multi-sheet.
 */
import { useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
} from 'recharts'
import { BarChart3, Download } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCurrency } from '@/lib/format'
import { usePermission } from '@/contexts/AuthContext'
import {
  useTopProducts,
  useBottomProducts,
  usePaymentMethodsRanking,
  useTopCustomers,
  useTopSuppliers,
  useSalesTrend,
  useAverageTicket,
  useSalesByHour,
  useSalesByDayOfWeek,
  useMarginByCategory,
  useStockRotation,
} from '@/lib/hooks'

const PIE_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#ec4899', '#0ea5e9', '#f97316']

function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

const DOW_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

export function Estadisticas() {
  const canView = usePermission('view_reports')
  const [preset, setPreset] = useState<'7d' | '30d' | '90d' | 'custom'>('30d')
  const [fromIso, setFromIso] = useState(() => isoDaysAgo(30))
  const [toIso, setToIso] = useState(() => todayIso())
  const [activeTab, setActiveTab] = useState('resumen')

  function applyPreset(p: '7d' | '30d' | '90d'): void {
    setPreset(p)
    const days = p === '7d' ? 7 : p === '30d' ? 30 : 90
    setFromIso(isoDaysAgo(days))
    setToIso(todayIso())
  }

  const range = useMemo(
    () => ({ from: dayStart(fromIso), to: dayEnd(toIso) }),
    [fromIso, toIso],
  )

  // Resumen
  const avgTicket = useAverageTicket(range, activeTab === 'resumen')
  const granularity =
    Math.ceil((range.to - range.from) / (1000 * 60 * 60 * 24)) > 90 ? 'monthly' : 'daily'
  const trend = useSalesTrend({ ...range, granularity }, activeTab === 'resumen')
  const margin = useMarginByCategory(range, activeTab === 'resumen' || activeTab === 'productos')
  const dow = useSalesByDayOfWeek(range, activeTab === 'resumen' || activeTab === 'tiempo')

  // Productos
  const topP = useTopProducts({ ...range, limit: 10 }, activeTab === 'productos')
  const bottomP = useBottomProducts({ ...range, limit: 10 }, activeTab === 'productos')
  const rotation = useStockRotation({ ...range, limit: 20 }, activeTab === 'productos')

  // Clientes / Proveedores
  const topC = useTopCustomers({ ...range, limit: 10 }, activeTab === 'clientes')
  const topS = useTopSuppliers({ ...range, limit: 10 }, activeTab === 'proveedores')

  // Pagos
  const pmRank = usePaymentMethodsRanking(range, activeTab === 'pagos')

  // Tiempo
  const byHour = useSalesByHour(range, activeTab === 'tiempo')

  const totalRevenue = useMemo(() => {
    const rows = trend.data ?? []
    return rows.reduce((acc, r) => acc + Number(r.total), 0)
  }, [trend.data])
  const grossMargin = useMemo(() => {
    const rows = margin.data ?? []
    const m = rows.reduce((acc, r) => acc + Number(r.margin), 0)
    const rev = rows.reduce((acc, r) => acc + Number(r.revenue), 0)
    return { amount: m, pct: rev > 0 ? (m / rev) * 100 : 0 }
  }, [margin.data])

  function exportarExcel(): void {
    const wb = XLSX.utils.book_new()

    const append = (name: string, rows: Record<string, unknown>[]) => {
      if (rows.length === 0) return
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name.slice(0, 31))
    }

    append('Resumen', [
      { Métrica: 'Ventas totales', Valor: totalRevenue },
      { Métrica: 'Cantidad ventas', Valor: avgTicket.data?.count ?? 0 },
      { Métrica: 'Ticket Promedio', Valor: Number(avgTicket.data?.avg ?? 0) },
      { Métrica: 'Ticket Mínimo', Valor: Number(avgTicket.data?.min ?? 0) },
      { Métrica: 'Ticket Máximo', Valor: Number(avgTicket.data?.max ?? 0) },
      { Métrica: 'Margen Bruto', Valor: grossMargin.amount },
      { Métrica: 'Margen %', Valor: grossMargin.pct.toFixed(2) },
    ])
    append('Tendencia', (trend.data ?? []).map((r) => ({
      Período: r.bucket,
      Ventas: r.count,
      Total: Number(r.total),
    })))
    append('Top Productos', (topP.data ?? []).map((r) => ({
      Código: r.code,
      Descripción: r.description,
      Marca: r.brand,
      Cantidad: Number(r.quantity),
      Facturación: Number(r.revenue),
      'Margen %': Number(r.marginPct),
    })))
    append('Bottom Productos', (bottomP.data ?? []).map((r) => ({
      Código: r.code,
      Descripción: r.description,
      Cantidad: Number(r.quantity),
      Facturación: Number(r.revenue),
    })))
    append('Rotación', (rotation.data ?? []).map((r) => ({
      Artículo: r.description,
      Vendido: Number(r.quantitySold),
      Stock: Number(r.currentStock),
      Rotación: Number(r.rotation),
    })))
    append('Margen Familia', (margin.data ?? []).map((r) => ({
      Familia: r.familyName,
      Facturación: Number(r.revenue),
      Costo: Number(r.cost),
      Margen: Number(r.margin),
      '% Margen': Number(r.marginPct),
    })))
    append('Top Clientes', (topC.data ?? []).map((r) => ({
      Cliente: r.fullName,
      Ventas: r.salesCount,
      Total: Number(r.totalAmount),
    })))
    append('Top Proveedores', (topS.data ?? []).map((r) => ({
      Proveedor: r.supplierName,
      Compras: r.purchasesCount,
      Total: Number(r.totalAmount),
    })))
    append('Formas de Pago', (pmRank.data ?? []).map((r) => ({
      Medio: r.name,
      Total: Number(r.totalAmount),
      Ventas: r.salesCount,
      '% Total': Number(r.percentageOfTotal),
    })))
    append('Por Hora', (byHour.data ?? []).map((r) => ({
      Hora: `${String(r.hour).padStart(2, '0')}:00`,
      Ventas: r.count,
      Total: Number(r.total),
    })))
    append('Por Día Semana', (dow.data ?? []).map((r) => ({
      Día: DOW_NAMES[r.dayOfWeek] ?? r.dayOfWeek,
      Ventas: r.count,
      Total: Number(r.total),
    })))

    XLSX.writeFile(wb, `estadisticas-${fromIso}-${toIso}.xlsx`)
  }

  if (!canView) return <Navigate to="/" replace />

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Estadísticas</h1>
        </div>
        <Button variant="outline" onClick={exportarExcel}>
          <Download className="h-4 w-4" />
          Exportar Excel
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 pt-4">
          <div className="flex gap-1">
            <Button size="sm" variant={preset === '7d' ? 'default' : 'outline'} onClick={() => applyPreset('7d')}>7 días</Button>
            <Button size="sm" variant={preset === '30d' ? 'default' : 'outline'} onClick={() => applyPreset('30d')}>30 días</Button>
            <Button size="sm" variant={preset === '90d' ? 'default' : 'outline'} onClick={() => applyPreset('90d')}>90 días</Button>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Desde</Label>
            <Input type="date" value={fromIso} onChange={(e) => { setFromIso(e.target.value); setPreset('custom') }} />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Hasta</Label>
            <Input type="date" value={toIso} onChange={(e) => { setToIso(e.target.value); setPreset('custom') }} />
          </div>
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="productos">Productos</TabsTrigger>
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          <TabsTrigger value="pagos">Formas de Pago</TabsTrigger>
          <TabsTrigger value="tiempo">Tiempo</TabsTrigger>
        </TabsList>

        <TabsContent value="resumen" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Ventas" value={formatCurrency(totalRevenue)} />
            <KpiCard label="Cantidad" value={String(avgTicket.data?.count ?? 0)} />
            <KpiCard label="Ticket Promedio" value={formatCurrency(avgTicket.data?.avg ?? '0')} />
            <KpiCard label="Margen Bruto" value={`${formatCurrency(grossMargin.amount)} (${grossMargin.pct.toFixed(1)}%)`} />
          </div>
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Tendencia de ventas</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trend.data ?? []}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" />
                    <YAxis />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Line type="monotone" dataKey="total" stroke="#6366f1" name="Total" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Ventas por día de la semana</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(dow.data ?? []).map((d) => ({ ...d, name: DOW_NAMES[d.dayOfWeek] ?? d.dayOfWeek, totalN: Number(d.total) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="totalN" fill="#10b981" name="Total" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="productos" className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <ProductTable title="Top 10 más vendidos" rows={topP.data ?? []} />
            <ProductTable title="Bottom 10 menos vendidos" rows={bottomP.data ?? []} />
          </div>
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Margen por familia</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={(margin.data ?? []).map((r) => ({ name: r.familyName, value: Number(r.margin) }))}
                      dataKey="value"
                      nameKey="name"
                      outerRadius={90}
                      label
                    >
                      {(margin.data ?? []).map((_, i) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Rotación de stock</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Artículo</TableHead>
                    <TableHead className="text-right">Vendido</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Rotación</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(rotation.data ?? []).slice(0, 20).map((r) => (
                    <TableRow key={r.articleId}>
                      <TableCell className="text-xs">{r.description}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.quantitySold}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.currentStock}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs font-medium">{r.rotation}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="clientes" className="flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Top 10 Clientes</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(topC.data ?? []).map((r) => ({ name: r.fullName, value: Number(r.totalAmount) }))} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={150} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="value" fill="#6366f1" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cliente</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(topC.data ?? []).map((r) => (
                    <TableRow key={r.customerId}>
                      <TableCell className="text-xs">{r.fullName}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.salesCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.totalAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="proveedores" className="flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Top 10 Proveedores</h3>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(topS.data ?? []).map((r) => ({ name: r.supplierName, value: Number(r.totalAmount) }))} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={150} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="value" fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Proveedor</TableHead>
                    <TableHead className="text-right">Compras</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(topS.data ?? []).map((r) => (
                    <TableRow key={r.supplierId}>
                      <TableCell className="text-xs">{r.supplierName}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.purchasesCount}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.totalAmount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pagos" className="flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Formas de pago</h3>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={(pmRank.data ?? []).map((r) => ({ name: r.name, value: Number(r.totalAmount) }))}
                        dataKey="value"
                        nameKey="name"
                        outerRadius={90}
                        label
                      >
                        {(pmRank.data ?? []).map((_, i) => (
                          <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Medio</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">% del total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(pmRank.data ?? []).map((r) => (
                      <TableRow key={r.paymentMethodId}>
                        <TableCell className="text-xs">{r.name}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.totalAmount)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{r.percentageOfTotal}%</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tiempo" className="flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Ventas por hora del día</h3>
              <HeatmapHour data={byHour.data ?? []} />
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hora</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(byHour.data ?? []).map((r) => (
                    <TableRow key={r.hour}>
                      <TableCell className="text-xs">{String(r.hour).padStart(2, '0')}:00</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.count}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  )
}

function ProductTable({ title, rows }: { title: string; rows: Array<{ articleId: string; code: string; description: string; quantity: string; revenue: string; marginPct: string }> }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <h3 className="mb-2 text-sm font-medium">{title}</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Artículo</TableHead>
              <TableHead className="text-right">Cant.</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Margen %</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={4} className="py-4 text-center text-xs text-muted-foreground">Sin datos</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.articleId}>
                <TableCell className="text-xs">{r.description}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">{r.quantity}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums text-xs">{r.marginPct}%</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function HeatmapHour({ data }: { data: Array<{ hour: number; count: number; total: string }> }) {
  const byHour = new Map(data.map((d) => [d.hour, d]))
  const max = Math.max(1, ...data.map((d) => d.count))
  const hours = Array.from({ length: 24 }, (_, h) => h)
  return (
    <div className="mb-3 grid grid-cols-24 gap-0.5" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
      {hours.map((h) => {
        const d = byHour.get(h)
        const intensity = d ? d.count / max : 0
        const bg = `rgba(99, 102, 241, ${Math.max(0.08, intensity)})`
        return (
          <div
            key={h}
            className="flex h-10 flex-col items-center justify-center rounded-sm text-[10px] font-medium"
            style={{ backgroundColor: bg, color: intensity > 0.55 ? '#fff' : '#1f2937' }}
            title={d ? `${h}h · ${d.count} ventas · ${formatCurrency(d.total)}` : `${h}h · sin ventas`}
          >
            <div>{String(h).padStart(2, '0')}</div>
            <div className="text-[9px]">{d?.count ?? 0}</div>
          </div>
        )
      })}
    </div>
  )
}
