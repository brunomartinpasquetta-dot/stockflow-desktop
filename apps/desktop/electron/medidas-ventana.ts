/**
 * Medidas de las ventanas de módulo, sin depender de Electron (se prueba en
 * `electron/__tests__/ventanas.smoke.ts`). Regla general en el cerebro:
 * `~/cerebro/modulos/ventanas-dentro-de-pantalla.md` ([VENTANAS-PANTALLA]).
 */
export interface AreaDePantalla { x: number; y: number; width: number; height: number }

export interface MedidasDeVentana {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  x: number;
  y: number;
  /** < 1 si la pantalla es más chica que el mínimo que pide la página. */
  zoom: number;
}

/**
 * Tamaño de una ventana de módulo SIEMPRE dentro de la pantalla donde se abre.
 *
 * Antes cada página pedía su tamaño y su mínimo fijos (p. ej. 1360×820 con un
 * mínimo de 1100×700) y Windows los respetaba aunque la pantalla fuera más
 * chica: en una PC de 1366×768, o con la escala de Windows al 125–150 %, la
 * ventana quedaba más grande que la pantalla y no se podía achicar (Nemesis,
 * 6-oct-2026). Ahora el tamaño y el mínimo se recortan al área útil y, si el
 * mínimo que pide la página no entra, el contenido se achica (zoom) en vez de
 * salirse de la pantalla.
 */
export function medidasDeVentana(
  area: AreaDePantalla,
  pedido: { width?: number; height?: number; minWidth?: number; minHeight?: number },
): MedidasDeVentana {
  const maxW = Math.max(320, Math.floor(area.width * 0.96));
  const maxH = Math.max(240, Math.floor(area.height * 0.96));
  // Por defecto: ~92 % del área útil (tope 1500×900). Con 1100×720 fijos, las
  // pantallas grandes abrían ventanas chicas y los layouts anchos quebraban.
  const defW = Math.min(1500, Math.round(area.width * 0.92));
  const defH = Math.min(900, Math.round(area.height * 0.92));
  const minPedidoW = pedido.minWidth ?? 480;
  const minPedidoH = pedido.minHeight ?? 360;
  const width = Math.min(pedido.width ?? defW, maxW);
  const height = Math.min(pedido.height ?? defH, maxH);
  const minWidth = Math.min(minPedidoW, maxW, width);
  const minHeight = Math.min(minPedidoH, maxH, height);
  // Si la página necesita más lugar del que hay, se achica el contenido (con un
  // piso de 75 % para que se siga leyendo) en vez de cortar la ventana.
  const zoom = Math.max(0.75, Math.min(1, maxW / minPedidoW, maxH / minPedidoH));
  return {
    width,
    height,
    minWidth,
    minHeight,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    zoom: Math.round(zoom * 100) / 100,
  };
}
