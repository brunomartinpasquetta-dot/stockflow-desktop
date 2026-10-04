/**
 * VENTAS Y COMPRAS SIN DUPLICAR (ítem 13 del plan multisucursal).
 *
 * Problema: en una terminal (red local o sucursal por internet) el cajero
 * cobra, la venta ENTRA en el servidor, pero la respuesta se pierde (corte,
 * túnel lento, tiempo de espera). La pantalla muestra error, el carrito sigue
 * ahí y el cajero vuelve a cobrar: venta duplicada, stock descontado dos
 * veces y el doble en caja.
 *
 * Solución: cada intento de cobro lleva una clave única. Mientras el carrito
 * no cambie, volver a cobrar reusa la MISMA clave; el servidor la reconoce y
 * devuelve la venta ya registrada en vez de crear otra. Cuando la venta sale
 * bien, la clave se descarta y la próxima venta (aunque sea idéntica, otro
 * cliente comprando lo mismo) lleva una nueva.
 *
 * La clave viaja DENTRO del payload, así que cualquier reintento del caller
 * (hoy no hay reintentos automáticos) manda la misma.
 */

/** uuid v4. `crypto.randomUUID` no existe fuera de un contexto seguro (la terminal por navegador en http://IP), por eso el respaldo con getRandomValues. */
export function nuevaClaveIdempotencia(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID()
    } catch {
      /* contexto no seguro: sigue el respaldo */
    }
  }
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** JSON con las claves ordenadas: el mismo carrito da siempre la misma huella. */
function huellaDe(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o = val as Record<string, unknown>
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = o[k]
          return acc
        }, {})
    }
    return val
  })
}

/**
 * Recuerda la clave del último intento que no se confirmó. Uso:
 *
 *     const intento = useRef(new IntentoDeOperacion())
 *     const clave = intento.current.clavePara(payload)
 *     const r = await api.sales.create({ ...payload, idempotencyKey: clave })
 *     intento.current.confirmar()
 */
export class IntentoDeOperacion {
  private ultimo: { huella: string; clave: string } | null = null
  private readonly generar: () => string

  constructor(generar: () => string = nuevaClaveIdempotencia) {
    this.generar = generar
  }

  /** Misma operación que el intento anterior sin confirmar → misma clave; si cambió algo, clave nueva. */
  clavePara(payload: unknown): string {
    const huella = huellaDe(payload)
    if (!this.ultimo || this.ultimo.huella !== huella) {
      this.ultimo = { huella, clave: this.generar() }
    }
    return this.ultimo.clave
  }

  /** La operación quedó registrada: la próxima lleva clave nueva. */
  confirmar(): void {
    this.ultimo = null
  }
}
