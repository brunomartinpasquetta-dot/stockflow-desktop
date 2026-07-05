/**
 * Declaración mínima del elemento <webview> de Electron para JSX (POC WhatsApp).
 */
declare global {
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webview: any
    }
  }
}

export {}
