/**
 * WindowIcon — renderiza un icono lucide a partir de su nombre.
 * Usa un switch explícito para satisfacer la regla `react-hooks/static-components`.
 */
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  Building2,
  Calculator,
  CreditCard,
  FileSpreadsheet,
  History,
  Info,
  Landmark,
  Package,
  PackagePlus,
  Receipt,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Tag,
  Tags,
  Truck,
  Users,
  Wallet,
} from 'lucide-react'

export function WindowIcon({ name, className }: { name: string | undefined; className?: string }) {
  switch (name) {
    case 'ArrowLeftRight': return <ArrowLeftRight className={className} />
    case 'BarChart3': return <BarChart3 className={className} />
    case 'Boxes': return <Boxes className={className} />
    case 'Building2': return <Building2 className={className} />
    case 'Calculator': return <Calculator className={className} />
    case 'CreditCard': return <CreditCard className={className} />
    case 'FileSpreadsheet': return <FileSpreadsheet className={className} />
    case 'History': return <History className={className} />
    case 'Info': return <Info className={className} />
    case 'Landmark': return <Landmark className={className} />
    case 'Package': return <Package className={className} />
    case 'PackagePlus': return <PackagePlus className={className} />
    case 'Receipt': return <Receipt className={className} />
    case 'Settings': return <Settings className={className} />
    case 'ShieldCheck': return <ShieldCheck className={className} />
    case 'ShoppingCart': return <ShoppingCart className={className} />
    case 'Tag': return <Tag className={className} />
    case 'Tags': return <Tags className={className} />
    case 'Truck': return <Truck className={className} />
    case 'Users': return <Users className={className} />
    case 'Wallet': return <Wallet className={className} />
    default: return null
  }
}
