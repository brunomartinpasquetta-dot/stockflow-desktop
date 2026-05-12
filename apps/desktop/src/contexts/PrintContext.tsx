/**
 * Impresión simple: el contenido a imprimir se monta en un contenedor oculto
 * (`.print-root`) que sólo es visible en `@media print` mientras el `<body>`
 * tiene la clase `printing`. Al pedir una impresión se monta el nodo, se
 * dispara `window.print()` y, al terminar (`afterprint`), se limpia.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

interface PrintContextValue {
  /** Monta `node` en el contenedor de impresión y abre el diálogo del sistema. */
  print: (node: ReactNode) => void
}

const PrintContext = createContext<PrintContextValue | null>(null)

export function PrintProvider({ children }: { children: ReactNode }) {
  const [node, setNode] = useState<ReactNode | null>(null)

  const print = useCallback((n: ReactNode) => setNode(n), [])

  // Una vez montado el contenido, dejamos que el DOM pinte y abrimos el diálogo.
  useEffect(() => {
    if (node == null) return
    document.body.classList.add('printing')
    const id = window.setTimeout(() => window.print(), 60)
    return () => window.clearTimeout(id)
  }, [node])

  useEffect(() => {
    function onAfterPrint() {
      document.body.classList.remove('printing')
      setNode(null)
    }
    window.addEventListener('afterprint', onAfterPrint)
    return () => window.removeEventListener('afterprint', onAfterPrint)
  }, [])

  const value = useMemo(() => ({ print }), [print])

  return (
    <PrintContext.Provider value={value}>
      {children}
      <div className="print-root">{node}</div>
    </PrintContext.Provider>
  )
}

export function usePrint(): PrintContextValue {
  const ctx = useContext(PrintContext)
  if (!ctx) throw new Error('usePrint debe usarse dentro de <PrintProvider>')
  return ctx
}
