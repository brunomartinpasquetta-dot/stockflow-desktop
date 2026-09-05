/**
 * Dashboard de Estadísticas (P-FIX-FASE3).
 *
 * 6 tabs: Resumen, Productos, Clientes, Proveedores, Formas de Pago, Tiempo.
 * Gráficos con `recharts`. Export Excel multi-sheet.
 */
import { useMemo, useState } from 'react'
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
import { BarChart3, CalendarDays, CalendarRange, CalendarSearch, Download, Banknote, CreditCard, Minus, QrCode, Landmark, TrendingDown, TrendingUp, Wallet } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatCurrency } from '@/lib/format'
import { usePermission } from '@/contexts/AuthContext'
import { useCompany } from '@/lib/hooks'
import { SinPermiso } from '@/components/SinPermiso'
import {
  useTopProducts,
  useBottomProducts,
  useTopCustomers,
  useTopSuppliers,
  useSalesTrend,
  useAverageTicket,
  useSalesByHour,
  useSalesByDayOfWeek,
  useMarginByCategory,
  useStockRotation,
  useVentasPorFormaPago,
  useVentasPorFormaPagoEnTiempo,
  useResumenDelDia,
  useAvanceDelMes,
  useResultadoNeto,
  useAntiguedadDeuda,
  useConversionPresupuestos,
  useStockSinMovimiento,
  useReposicionPrioritaria,
  useSalesByVendorReport,
  useCatalogoEstadisticas,
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

/* Rangos en hora local de la máquina (misma zona que usa el resto de la
   pantalla y que 'localtime' en las consultas). */
function diaRange(offsetDias: number): { from: number; to: number } {
  const d = new Date()
  d.setDate(d.getDate() - offsetDias)
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
  const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime()
  return { from, to }
}
function rangosDeMes(): {
  mesActual: { from: number; to: number }
  mesAnteriorParcial: { from: number; to: number }
  mesAnteriorCompleto: { from: number; to: number }
  diasTranscurridos: number
  diasDelMes: number
} {
  const ahora = new Date()
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1).getTime()
  const inicioMesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1).getTime()
  // Mismo día y hora, un mes atrás (Date normaliza los fines de mes solo).
  const mismaAlturaMesAnterior = new Date(
    ahora.getFullYear(), ahora.getMonth() - 1, ahora.getDate(),
    ahora.getHours(), ahora.getMinutes(), 59, 999,
  ).getTime()
  return {
    mesActual: { from: inicioMes, to: ahora.getTime() },
    mesAnteriorParcial: { from: inicioMesAnterior, to: mismaAlturaMesAnterior },
    mesAnteriorCompleto: { from: inicioMesAnterior, to: inicioMes - 1 },
    diasTranscurridos: ahora.getDate(),
    diasDelMes: new Date(ahora.getFullYear(), ahora.getMonth() + 1, 0).getDate(),
  }
}
function dayStart(iso: string): number {
  return new Date(`${iso}T00:00:00`).getTime()
}
function dayEnd(iso: string): number {
  return new Date(`${iso}T23:59:59.999`).getTime()
}

const DOW_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']

/** Ícono por nombre de forma de pago. */
function iconForMedio(name: string): typeof Wallet {
  const n = name.toLowerCase()
  if (n.includes('efectivo')) return Banknote
  if (n.includes('transfer') || n.includes('qr') || n.includes('mp') || n.includes('mercado')) return QrCode
  if (n.includes('débito') || n.includes('debito') || n.includes('crédito') || n.includes('credito') || n.includes('tarjeta')) return CreditCard
  if (n.includes('cuenta')) return Landmark
  return Wallet
}

export function Estadisticas() {
  const canView = usePermission('view_reports')
  const [preset, setPreset] = useState<'7d' | '30d' | '90d' | 'custom'>('30d')
  const [fromIso, setFromIso] = useState(() => isoDaysAgo(30))
  const [toIso, setToIso] = useState(() => todayIso())
  const [activeTab, setActiveTab] = useState('resumen')
  const [mediosSel, setMediosSel] = useState<Set<string>>(new Set())

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

  // Resumen del día / Avance del mes / Resultado (rangos locales, memo por render)
  const rangosDia = useMemo(() => ({ hoy: diaRange(0), ayer: diaRange(1), mismoDiaSemanaAnterior: diaRange(7) }), [])
  const rangosMes = useMemo(() => rangosDeMes(), [])
  const resumenDia = useResumenDelDia(rangosDia, activeTab === 'resumen')
  const avanceMes = useAvanceDelMes(rangosMes, activeTab === 'resumen')
  const resHoy = useResultadoNeto(rangosDia.hoy, activeTab === 'resumen')
  const resMes = useResultadoNeto(rangosMes.mesActual, activeTab === 'resumen')
  const resPeriodo = useResultadoNeto(range, activeTab === 'resumen')
  const vfpHoy = useVentasPorFormaPago(rangosDia.hoy, activeTab === 'resumen')
  const vfpMes = useVentasPorFormaPago(rangosMes.mesActual, activeTab === 'resumen')

  // Vendedores
  const vendedores = useSalesByVendorReport(range, activeTab === 'vendedores')

  // Catálogo web (pestaña condicional: solo con la integración configurada)
  const companyQuery = useCompany()
  const catalogoIntegrado = Boolean(companyQuery.data?.catalogoUrl)
  const catalogo = useCatalogoEstadisticas(range, activeTab === 'catalogo' && catalogoIntegrado)

  // Gestión
  const aging = useAntiguedadDeuda(activeTab === 'gestion')
  const conversion = useConversionPresupuestos(range, activeTab === 'gestion')
  const sinMovimiento = useStockSinMovimiento({ dias: 90, limit: 20 }, activeTab === 'gestion')
  const reposicion = useReposicionPrioritaria({ ...range, limit: 20 }, activeTab === 'gestion')

  // Productos
  const topP = useTopProducts({ ...range, limit: 10 }, activeTab === 'productos')
  const bottomP = useBottomProducts({ ...range, limit: 10 }, activeTab === 'productos')
  const rotation = useStockRotation({ ...range, limit: 20 }, activeTab === 'productos')

  // Clientes / Proveedores
  const topC = useTopCustomers({ ...range, limit: 10 }, activeTab === 'clientes')
  const topS = useTopSuppliers({ ...range, limit: 10 }, activeTab === 'proveedores')

  // Pagos
  const pagoGranularity = useMemo<'daily' | 'weekly' | 'monthly'>(() => {
    const days = (range.to - range.from) / (1000 * 60 * 60 * 24)
    if (days <= 31) return 'daily'
    if (days <= 92) return 'weekly'
    return 'monthly'
  }, [range])

  const vfp = useVentasPorFormaPago(range, activeTab === 'pagos' || activeTab === 'resumen')
  const vfpTiempo = useVentasPorFormaPagoEnTiempo(
    { ...range, granularity: pagoGranularity },
    activeTab === 'pagos',
  )

  // Color estable por medio (índice en vfp.data → PIE_COLORS)
  const colorMap = useMemo(() => {
    const map: Record<string, string> = {}
    ;(vfp.data ?? []).forEach((r, i) => {
      map[r.paymentMethodId] = PIE_COLORS[i % PIE_COLORS.length] ?? '#6366f1'
    })
    return map
  }, [vfp.data])

  // Filtro de forma de pago (vacío = todos)
  const isSel = (id: string): boolean => mediosSel.size === 0 || mediosSel.has(id)
  const toggleMedio = (id: string): void => {
    setMediosSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const vfpFiltrado = (vfp.data ?? []).filter((r) => isSel(r.paymentMethodId))
  // Totales para la tabla detallada (sobre el filtrado). SIN useMemo manual: el
  // React Compiler memoiza solo, y un useMemo con dep inestable (vfpFiltrado se
  // recrea por render) rompía el lint ("memoization could not be preserved").
  const vfpTotMonto = vfpFiltrado.reduce((acc, r) => acc + Number(r.montoTotal), 0)
  const vfpTotVentas = vfpFiltrado.reduce((acc, r) => acc + r.cantidadVentas, 0)
  const vfpTotOper = vfpFiltrado.reduce((acc, r) => acc + r.cantidadOperaciones, 0)
  const vfpTotales = {
    monto: vfpTotMonto,
    ventas: vfpTotVentas,
    operaciones: vfpTotOper,
    ticket: vfpTotVentas > 0 ? vfpTotMonto / vfpTotVentas : 0,
  }
  const totalSeleccionado = vfpTotMonto

  // Pivot largo → ancho para el gráfico de evolución temporal (sin useMemo).
  const vfpTiempoPivot = ((): Record<string, number | string>[] => {
    const buckets = new Map<string, Record<string, number | string>>()
    ;(vfpTiempo.data ?? []).forEach((r) => {
      if (!isSel(r.paymentMethodId)) return
      let row = buckets.get(r.bucket)
      if (!row) {
        row = { bucket: r.bucket }
        buckets.set(r.bucket, row)
      }
      row[r.paymentMethodId] = Number(row[r.paymentMethodId] ?? 0) + Number(r.monto)
    })
    return Array.from(buckets.values())
  })()

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
      'Margen %': r.marginPct == null ? 's/costo' : Number(r.marginPct),
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
      '% Margen': r.marginPct == null ? 's/costo' : Number(r.marginPct),
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
    append('Ventas por Forma de Pago', (vfp.data ?? []).map((r) => ({
      Medio: r.name,
      Monto: Number(r.montoTotal),
      '% Total': Number(r.porcentajeDelTotal),
      Ventas: r.cantidadVentas,
      Operaciones: r.cantidadOperaciones,
      'Ticket Prom': Number(r.ticketPromedio),
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

  if (!canView) return <SinPermiso area="Estadísticas" />

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
          {(vfp.data ?? []).length > 0 && (
            <div className="flex w-full flex-col gap-1">
              <Label className="text-xs">Formas de pago</Label>
              <div className="flex flex-wrap items-center gap-1">
                <Button
                  size="sm"
                  variant={mediosSel.size === 0 ? 'default' : 'outline'}
                  className="h-7 px-2 text-xs"
                  onClick={() => setMediosSel(new Set())}
                >
                  Todos
                </Button>
                {(vfp.data ?? []).map((r) => {
                  const active = isSel(r.paymentMethodId)
                  return (
                    <Button
                      key={r.paymentMethodId}
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      className="h-7 px-2 text-xs"
                      style={active ? { backgroundColor: colorMap[r.paymentMethodId], borderColor: colorMap[r.paymentMethodId] } : undefined}
                      onClick={() => toggleMedio(r.paymentMethodId)}
                    >
                      {r.name}
                    </Button>
                  )
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col gap-3">
        <TabsList>
          <TabsTrigger value="resumen">Resumen</TabsTrigger>
          <TabsTrigger value="productos">Productos</TabsTrigger>
          <TabsTrigger value="clientes">Clientes</TabsTrigger>
          <TabsTrigger value="proveedores">Proveedores</TabsTrigger>
          <TabsTrigger value="vendedores">Vendedores</TabsTrigger>
          <TabsTrigger value="pagos">Formas de Pago</TabsTrigger>
          <TabsTrigger value="tiempo">Tiempo</TabsTrigger>
          <TabsTrigger value="gestion">Gestión</TabsTrigger>
          {catalogoIntegrado && <TabsTrigger value="catalogo">Catálogo web</TabsTrigger>}
        </TabsList>

        <TabsContent value="resumen" className="flex flex-col gap-3">
          {/* Tríptico HOY | MES | PERÍODO (panel de diseño, sep-2026): cada
              tarjeta responde una pregunta del dueño con la misma anatomía —
              ventas grandes, comparaciones, y el RESULTADO en la única banda
              con color (verde ganancia / rojo pérdida). */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <TarjetaHorizonte
              icono={CalendarDays}
              titulo="Hoy"
              contexto={new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
              heroe={formatCurrency(resumenDia.data?.hoy.total ?? '0')}
              heroeDerecha={<span className="text-xs tabular-nums text-muted-foreground">{resumenDia.data?.hoy.count ?? 0} operación(es)</span>}
              subEtiqueta="ventas de hoy"
              comparaciones={[
                { label: 'Ayer', value: formatCurrency(resumenDia.data?.ayer.total ?? '0'), tendencia: tendenciaVs(resumenDia.data?.hoy.total, resumenDia.data?.ayer.total) },
                { label: 'Mismo día sem. anterior', value: formatCurrency(resumenDia.data?.mismoDiaSemanaAnterior.total ?? '0'), tendencia: tendenciaVs(resumenDia.data?.hoy.total, resumenDia.data?.mismoDiaSemanaAnterior.total) },
              ]}
              resultado={resHoy.data}
              etiquetaResultado="Resultado del día"
            />
            <TarjetaHorizonte
              icono={CalendarRange}
              titulo="Mes en curso"
              contexto={`${new Date().toLocaleDateString('es-AR', { month: 'long' })} — día ${rangosMes.diasTranscurridos} de ${rangosMes.diasDelMes}`}
              heroe={formatCurrency(avanceMes.data?.mesActual ?? '0')}
              heroeDerecha={
                avanceMes.data?.variacionPct != null ? (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
                      Number(avanceMes.data.variacionPct) >= 0
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
                        : 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-400'
                    }`}
                  >
                    {Number(avanceMes.data.variacionPct) >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                    {Number(avanceMes.data.variacionPct) >= 0 ? '+' : ''}{avanceMes.data.variacionPct}%
                  </span>
                ) : null
              }
              subEtiqueta="frente a igual altura del mes anterior"
              comparaciones={[
                { label: 'Anterior a igual altura', value: formatCurrency(avanceMes.data?.mesAnteriorParcial ?? '0') },
                { label: 'Anterior completo', value: formatCurrency(avanceMes.data?.mesAnteriorCompleto ?? '0') },
                { label: 'Proyección de cierre', value: `≈ ${formatCurrency(avanceMes.data?.proyeccionCierre ?? '0')}`, destacar: true },
              ]}
              resultado={resMes.data}
              etiquetaResultado="Resultado del mes"
            />
            <TarjetaHorizonte
              icono={CalendarSearch}
              titulo="Período seleccionado"
              contexto={`${fromIso.slice(8, 10)}/${fromIso.slice(5, 7)} – ${toIso.slice(8, 10)}/${toIso.slice(5, 7)}`}
              heroe={formatCurrency(totalRevenue)}
              heroeDerecha={<span className="text-xs tabular-nums text-muted-foreground">{avgTicket.data?.count ?? 0} venta(s)</span>}
              subEtiqueta="ventas netas del período"
              comparaciones={[
                { label: 'Ticket promedio', value: formatCurrency(avgTicket.data?.avg ?? '0') },
                { label: 'Margen bruto', value: `${formatCurrency(grossMargin.amount)} · ${grossMargin.pct.toFixed(1)}%` },
              ]}
              resultado={resPeriodo.data}
              etiquetaResultado="Resultado del período"
            />
          </div>

          {/* Formas de pago con barras de participación: hoy y mes lado a lado. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <BarrasMedios titulo="Formas de pago — hoy" rows={vfpHoy.data ?? []} />
            <BarrasMedios titulo="Formas de pago — mes en curso" rows={vfpMes.data ?? []} />
          </div>

          <Card>
            <CardContent className="pt-4">
              <div className="text-xs text-muted-foreground">
                Ventas por medios seleccionados{mediosSel.size === 0 ? ' (todos)' : ''}
              </div>
              <div className="mt-1 text-xl font-bold tabular-nums">{formatCurrency(totalSeleccionado)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <h3 className="text-sm font-medium">Tendencia de ventas</h3>
              <p className="mb-2 text-xs text-muted-foreground">Total vendido por día del período seleccionado, descontadas las devoluciones.</p>
              <div className="h-36">
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
              <h3 className="text-sm font-medium">Ventas por día de la semana</h3>
              <p className="mb-2 text-xs text-muted-foreground">Suma de ventas del período según el día de la semana: permite identificar los días más fuertes del comercio.</p>
              <div className="mx-auto h-36 w-full max-w-md">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(dow.data ?? []).map((d) => ({ ...d, name: DOW_NAMES[d.dayOfWeek] ?? d.dayOfWeek, totalN: Number(d.total) }))}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="name" />
                    <YAxis />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="totalN" fill="#10b981" name="Total" maxBarSize={32} />
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
              <h3 className="text-sm font-medium">Margen por familia</h3>
              <p className="mb-2 text-xs text-muted-foreground">Participación de cada familia de artículos en la ganancia bruta del período.</p>
              <div className="h-36">
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
              <h3 className="text-sm font-medium">Top 10 Clientes</h3>
              <p className="mb-2 text-xs text-muted-foreground">Clientes con mayor monto de compras en el período seleccionado.</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(topC.data ?? []).map((r) => ({ name: r.fullName, value: Number(r.totalAmount) }))} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={150} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="value" fill="#6366f1" maxBarSize={14} />
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
              <h3 className="text-sm font-medium">Top 10 Proveedores</h3>
              <p className="mb-2 text-xs text-muted-foreground">Proveedores a los que se les compró mayor monto en el período seleccionado.</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={(topS.data ?? []).map((r) => ({ name: r.supplierName, value: Number(r.totalAmount) }))} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis type="number" />
                    <YAxis dataKey="name" type="category" width={150} />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Bar dataKey="value" fill="#f59e0b" maxBarSize={14} />
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
          {/* a) Grid de cards por medio */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {vfpFiltrado.length === 0 ? (
              <Card><CardContent className="py-6 text-center text-xs text-muted-foreground">Sin datos</CardContent></Card>
            ) : vfpFiltrado.map((r) => {
              const color = colorMap[r.paymentMethodId]
              const Icon = iconForMedio(r.name)
              return (
                <Card key={r.paymentMethodId} className="border-l-4" style={{ borderLeftColor: color }}>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Icon className="h-4 w-4" style={{ color }} />
                      {r.name}
                    </div>
                    <div className="mt-1 text-xl font-bold tabular-nums">{formatCurrency(r.montoTotal)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{r.porcentajeDelTotal}% del total</div>
                    <div className="text-xs text-muted-foreground">{r.cantidadVentas} ventas</div>
                    <div className="text-xs text-muted-foreground">Ticket prom. {formatCurrency(r.ticketPromedio)}</div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {/* b) Gráfico de torta */}
          <Card>
            <CardContent className="pt-4">
              <h3 className="text-sm font-medium">Distribución por forma de pago</h3>
              <p className="mb-2 text-xs text-muted-foreground">Participación de cada medio de pago sobre el total cobrado en el período.</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={vfpFiltrado.map((r) => ({ name: r.name, value: Number(r.montoTotal) }))}
                      dataKey="value"
                      nameKey="name"
                      outerRadius={90}
                      label
                    >
                      {vfpFiltrado.map((r) => (
                        <Cell key={r.paymentMethodId} fill={colorMap[r.paymentMethodId]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* c) Tabla detallada */}
          <Card>
            <CardContent className="pt-4">
              <h3 className="mb-2 text-sm font-medium">Detalle por forma de pago</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Medio</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="text-right">%</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Operaciones</TableHead>
                    <TableHead className="text-right">Ticket Prom.</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vfpFiltrado.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="py-4 text-center text-xs text-muted-foreground">Sin datos</TableCell></TableRow>
                  ) : (
                    <>
                      {vfpFiltrado.map((r) => (
                        <TableRow key={r.paymentMethodId}>
                          <TableCell className="text-xs">{r.name}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.montoTotal)}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">{r.porcentajeDelTotal}%</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">{r.cantidadVentas}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">{r.cantidadOperaciones}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">{formatCurrency(r.ticketPromedio)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold">
                        <TableCell className="text-xs">TOTAL</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{formatCurrency(vfpTotales.monto)}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">100%</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{vfpTotales.ventas}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{vfpTotales.operaciones}</TableCell>
                        <TableCell className="text-right tabular-nums text-xs">{formatCurrency(vfpTotales.ticket)}</TableCell>
                      </TableRow>
                    </>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* d) Evolución temporal apilada */}
          <Card>
            <CardContent className="pt-4">
              <h3 className="text-sm font-medium">Evolución por forma de pago</h3>
              <p className="mb-2 text-xs text-muted-foreground">Monto cobrado con cada medio de pago a lo largo del tiempo del período.</p>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={vfpTiempoPivot}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="bucket" />
                    <YAxis />
                    <Tooltip formatter={(v) => formatCurrency(Number(v))} />
                    <Legend />
                    {vfpFiltrado.map((r) => (
                      <Bar
                        maxBarSize={26}
                        key={r.paymentMethodId}
                        stackId="m"
                        dataKey={r.paymentMethodId}
                        name={r.name}
                        fill={colorMap[r.paymentMethodId]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
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

        <TabsContent value="vendedores" className="flex flex-col gap-3">
          <Card>
            <CardContent className="pt-4">
              <div className="mb-2 text-sm font-medium">Ventas por vendedor — período seleccionado</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendedor</TableHead>
                    <TableHead className="text-right">Ventas</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                    <TableHead className="text-right">Ticket promedio</TableHead>
                    <TableHead className="text-right">Participación</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(vendedores.data?.rows ?? []).map((r) => (
                    <TableRow key={r.userId}>
                      <TableCell>{r.userName}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.salesCount}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.totalAmount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.averageTicket)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.percentageOfTotal}%</TableCell>
                    </TableRow>
                  ))}
                  {(vendedores.data?.rows ?? []).length === 0 && (
                    <TableRow><TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">Sin ventas en el período.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="gestion" className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Card>
              <CardContent className="pt-4">
                <div className="text-sm font-medium">Antigüedad de la deuda de clientes</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {aging.data ? `${aging.data.clientesConDeuda} cliente(s) con deuda — total ${formatCurrency(aging.data.total)}` : '…'}
                </div>
                <div className="mt-2 flex flex-col gap-1 text-sm tabular-nums">
                  {(aging.data?.buckets ?? []).map((b) => (
                    <div key={b.rango} className="flex items-center justify-between">
                      <span>{b.rango}</span>
                      <span>
                        {formatCurrency(b.monto)}
                        <span className="ml-2 text-xs text-muted-foreground">{b.comprobantes} comp.</span>
                      </span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-4">
                <div className="text-sm font-medium">Conversión de presupuestos — período seleccionado</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-sm tabular-nums">
                  <div className="flex justify-between"><span>Emitidos</span><span>{conversion.data?.total ?? 0}</span></div>
                  <div className="flex justify-between"><span>Convertidos en venta</span><span>{conversion.data?.convertidos ?? 0}</span></div>
                  <div className="flex justify-between"><span>Aceptados</span><span>{conversion.data?.aceptados ?? 0}</span></div>
                  <div className="flex justify-between"><span>Pendientes</span><span>{conversion.data?.pendientes ?? 0}</span></div>
                  <div className="flex justify-between"><span>Rechazados</span><span>{conversion.data?.rechazados ?? 0}</span></div>
                  <div className="flex justify-between font-semibold">
                    <span>Tasa de conversión</span>
                    <span>{conversion.data?.tasaConversionPct == null ? '—' : `${conversion.data.tasaConversionPct}%`}</span>
                  </div>
                </div>
                <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                  Monto convertido: {formatCurrency(conversion.data?.montoConvertido ?? '0')}
                </div>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium">Stock sin movimiento (últimos 90 días)</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {sinMovimiento.data
                  ? `${sinMovimiento.data.articulos} artículo(s) — capital inmovilizado ${formatCurrency(sinMovimiento.data.capitalTotal)} (valuado al costo)`
                  : '…'}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Artículo</TableHead>
                    <TableHead className="text-right">Stock</TableHead>
                    <TableHead className="text-right">Capital inmovilizado</TableHead>
                    <TableHead className="text-right">Última venta</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(sinMovimiento.data?.top ?? []).map((r) => (
                    <TableRow key={r.articleId}>
                      <TableCell className="text-sm">{r.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.stock}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(r.capitalInmovilizado)}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">
                        {r.ultimaVenta == null ? 'Sin ventas registradas' : new Date(r.ultimaVenta).toLocaleDateString('es-AR')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm font-medium">Reposición prioritaria — bajo mínimo y con ventas en el período</div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Artículo</TableHead>
                    <TableHead className="text-right">Stock actual</TableHead>
                    <TableHead className="text-right">Stock mínimo</TableHead>
                    <TableHead className="text-right">Vendido en el período</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(reposicion.data ?? []).map((r) => (
                    <TableRow key={r.articleId}>
                      <TableCell className="text-sm">{r.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.stock}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.minStock}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.vendidoEnRango}</TableCell>
                    </TableRow>
                  ))}
                  {(reposicion.data ?? []).length === 0 && (
                    <TableRow><TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">Sin artículos bajo mínimo con ventas en el período.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="catalogo" className="flex flex-col gap-3">
          {catalogo.data?.disponible === false ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No se pudieron obtener las estadísticas del catálogo web.
                {catalogo.data.motivo ? ` (${catalogo.data.motivo})` : ''} Verifique la dirección y la clave en Mi Empresa.
              </CardContent>
            </Card>
          ) : (
            <>
              <FilaDatosCatalogo
                visitas={catalogo.data?.visitas ?? 0}
                visitantes={catalogo.data?.visitantes ?? null}
              />
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                <TablaCatalogo
                  titulo="Productos más vistos"
                  descripcion="Artículos del catálogo con más visitas en el período."
                  columnas={['Producto', 'Vistas']}
                  filas={(catalogo.data?.productosMasVistos ?? []).map((r) => [r.descripcion, String(r.vistas)])}
                />
                <TablaCatalogo
                  titulo="Productos más comprados"
                  descripcion="Artículos con más unidades pedidas desde el catálogo en el período."
                  columnas={['Producto', 'Cantidad']}
                  filas={(catalogo.data?.productosMasComprados ?? []).map((r) => [r.descripcion, String(r.cantidad)])}
                />
                <TablaCatalogo
                  titulo="Términos más buscados"
                  descripcion="Qué buscan los visitantes dentro del catálogo."
                  columnas={['Búsqueda', 'Veces']}
                  filas={(catalogo.data?.terminosMasBuscados ?? []).map((r) => [r.termino, String(r.veces)])}
                />
                <TablaCatalogo
                  titulo="Búsquedas sin resultado"
                  descripcion="Lo que los visitantes buscan y el catálogo no ofrece: demanda sin cubrir."
                  columnas={['Búsqueda', 'Veces']}
                  filas={(catalogo.data?.busquedasSinResultado ?? []).map((r) => [r.termino, String(r.veces)])}
                />
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** Tendencia de HOY frente a una referencia (solo signo visual, sin %). */
function tendenciaVs(actual?: string, referencia?: string): 'up' | 'down' | 'flat' {
  const a = Number(actual ?? 0)
  const r = Number(referencia ?? 0)
  if (r === 0 || Math.abs(a - r) < 0.005) return 'flat'
  return a > r ? 'up' : 'down'
}

/**
 * Tarjeta del tríptico HOY/MES/PERÍODO: misma anatomía en las tres —
 * encabezado, ventas en grande, comparaciones alineadas, ledger del
 * resultado y banda final coloreada (el único color fuerte de la tarjeta).
 */
function TarjetaHorizonte({
  icono: Icono,
  titulo,
  contexto,
  heroe,
  heroeDerecha,
  subEtiqueta,
  comparaciones,
  resultado,
  etiquetaResultado,
}: {
  icono: typeof CalendarDays
  titulo: string
  contexto: string
  heroe: string
  heroeDerecha: React.ReactNode
  subEtiqueta: string
  comparaciones: Array<{ label: string; value: string; tendencia?: 'up' | 'down' | 'flat'; destacar?: boolean }>
  resultado?: { ventasNetas: string; cmv: string; comisiones: string; resultado: string; margenPct: string | null }
  etiquetaResultado: string
}) {
  const negativo = Number(resultado?.resultado ?? 0) < 0
  return (
    <Card>
      <CardContent className="flex h-full flex-col gap-1.5 p-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Icono className="h-3.5 w-3.5" />
          {titulo}
          <span className="font-normal normal-case tracking-normal">· {contexto}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-2xl font-bold leading-8 tabular-nums tracking-tight">{heroe}</span>
          {heroeDerecha}
        </div>
        <div className="-mt-1 text-xs text-muted-foreground">{subEtiqueta}</div>
        <div className="flex min-h-[54px] flex-col justify-start gap-0.5">
          {comparaciones.map((c) => (
            <div key={c.label} className="flex items-baseline justify-between text-xs leading-[18px]">
              <span className="truncate text-muted-foreground">{c.label}</span>
              <span className={`flex items-center gap-1 tabular-nums ${c.destacar ? 'font-semibold' : 'font-medium'}`}>
                {c.tendencia === 'up' && <TrendingUp className="h-3 w-3 text-emerald-600" />}
                {c.tendencia === 'down' && <TrendingDown className="h-3 w-3 text-rose-600" />}
                {c.tendencia === 'flat' && <Minus className="h-3 w-3 text-muted-foreground" />}
                {c.value}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-0.5 border-t border-dashed pt-1 text-[11px]">
          <div className="flex justify-between"><span className="text-muted-foreground">Ventas netas</span><span className="tabular-nums">{formatCurrency(resultado?.ventasNetas ?? '0')}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Costo de mercadería</span><span className="tabular-nums"><span className="text-muted-foreground">− </span>{formatCurrency(resultado?.cmv ?? '0')}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Comisiones</span><span className="tabular-nums"><span className="text-muted-foreground">− </span>{formatCurrency(resultado?.comisiones ?? '0')}</span></div>
        </div>
        <div
          className={`flex items-baseline justify-between rounded-md px-2.5 py-1 ${
            negativo ? 'bg-rose-50 dark:bg-rose-950/40' : 'bg-emerald-50 dark:bg-emerald-950/40'
          }`}
        >
          <span className={`text-[11px] font-semibold uppercase tracking-wide ${negativo ? 'text-rose-800 dark:text-rose-300' : 'text-emerald-800 dark:text-emerald-300'}`}>
            {etiquetaResultado}
          </span>
          <span className={`text-base font-bold tabular-nums ${negativo ? 'text-rose-700 dark:text-rose-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
            {formatCurrency(resultado?.resultado ?? '0')}
            {resultado?.margenPct != null && <span className="ml-1 text-xs font-semibold">· {resultado.margenPct}%</span>}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

/** Formas de pago con barra de participación: la comparación es visual. */
function BarrasMedios({
  titulo,
  rows,
}: {
  titulo: string
  rows: Array<{ paymentMethodId: string; name: string; montoTotal: string; porcentajeDelTotal: string }>
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{titulo}</div>
        {rows.length === 0 ? (
          <div className="py-2 text-xs text-muted-foreground">Sin cobros en el rango.</div>
        ) : (
          <div className="mt-1.5 flex flex-col gap-1">
            {rows.map((r) => {
              const Icon = iconForMedio(r.name)
              const pct = Math.max(0, Math.min(100, Number(r.porcentajeDelTotal)))
              return (
                <div key={r.paymentMethodId} className="grid grid-cols-[130px_1fr_auto] items-center gap-2 text-xs">
                  <span className="flex items-center gap-1.5 truncate text-muted-foreground">
                    <Icon className="h-3 w-3 shrink-0" />{r.name}
                  </span>
                  <div className="h-2 overflow-hidden rounded-sm bg-muted">
                    <div className="h-full rounded-sm bg-primary/70" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="tabular-nums">
                    {formatCurrency(r.montoTotal)}
                    <span className="ml-1.5 text-muted-foreground">{r.porcentajeDelTotal}%</span>
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** Franja de visitas del catálogo web. */
function FilaDatosCatalogo({ visitas, visitantes }: { visitas: number; visitantes: number | null }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
      <span className="font-semibold">Catálogo web — período seleccionado</span>
      <span className="text-muted-foreground">Visitas: <span className="font-medium tabular-nums text-foreground">{visitas}</span></span>
      {visitantes != null && (
        <span className="text-muted-foreground">Visitantes: <span className="font-medium tabular-nums text-foreground">{visitantes}</span></span>
      )}
    </div>
  )
}

/** Tabla simple de dos columnas para las estadísticas del catálogo. */
function TablaCatalogo({ titulo, descripcion, columnas, filas }: { titulo: string; descripcion: string; columnas: [string, string]; filas: string[][] }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <h3 className="text-sm font-medium">{titulo}</h3>
        <p className="mb-2 text-xs text-muted-foreground">{descripcion}</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{columnas[0]}</TableHead>
              <TableHead className="text-right">{columnas[1]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filas.map((f, i) => (
              <TableRow key={i}>
                <TableCell className="text-sm">{f[0]}</TableCell>
                <TableCell className="text-right tabular-nums">{f[1]}</TableCell>
              </TableRow>
            ))}
            {filas.length === 0 && (
              <TableRow><TableCell colSpan={2} className="py-4 text-center text-xs text-muted-foreground">Sin datos en el período.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function ProductTable({ title, rows }: { title: string; rows: Array<{ articleId: string; code: string; description: string; quantity: string; revenue: string; marginPct: string | null }> }) {
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
                <TableCell className="text-right tabular-nums text-xs">{r.marginPct == null ? 's/costo' : `${r.marginPct}%`}</TableCell>
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
