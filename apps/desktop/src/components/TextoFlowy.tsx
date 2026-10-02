/**
 * Texto de una respuesta de Flowy con el formato básico que usan las fichas y
 * la IA: **negrita**, viñetas ("- ", "* ") y títulos ("### "). Antes el panel
 * mostraba los asteriscos tal cual.
 *
 * Arma nodos de React (nunca HTML crudo): un texto raro no puede inyectar nada.
 * Los saltos de línea los respeta el contenedor (whitespace-pre-wrap).
 */
import { Fragment, type ReactNode } from 'react'

function enLinea(texto: string, clave: string): ReactNode[] {
  // **negrita**
  return texto.split(/(\*\*[^*\n]+\*\*)/g).map((parte, i) => {
    if (parte.length > 4 && parte.startsWith('**') && parte.endsWith('**')) {
      return <strong key={`${clave}-${i}`}>{parte.slice(2, -2)}</strong>
    }
    // *itálica* suelta: se muestra el texto sin asteriscos.
    return <Fragment key={`${clave}-${i}`}>{parte.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1$2')}</Fragment>
  })
}

function linea(texto: string, i: number): ReactNode {
  const titulo = /^\s{0,3}#{1,4}\s+(.*)$/.exec(texto)
  if (titulo) return <strong>{enLinea(titulo[1] ?? '', `t${i}`)}</strong>
  const vineta = /^(\s*)[-*•]\s+(.*)$/.exec(texto)
  if (vineta) return <>{vineta[1]}• {enLinea(vineta[2] ?? '', `v${i}`)}</>
  return <>{enLinea(texto, `l${i}`)}</>
}

export function TextoFlowy({ texto }: { texto: string }) {
  const lineas = texto.split('\n')
  return (
    <>
      {lineas.map((l, i) => (
        <Fragment key={i}>
          {linea(l, i)}
          {i < lineas.length - 1 ? '\n' : null}
        </Fragment>
      ))}
    </>
  )
}
