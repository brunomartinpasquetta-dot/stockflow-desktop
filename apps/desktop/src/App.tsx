import { useState } from 'react'

function App() {
  const [result, setResult] = useState('—')
  const [busy, setBusy] = useState(false)

  async function checkBridge() {
    setBusy(true)
    try {
      if (!window.stockflow) {
        setResult('window.stockflow no está disponible (¿corriendo fuera de Electron?)')
        return
      }
      const res = await window.stockflow.system.getInfo()
      setResult(
        res.ok
          ? `v${res.data.version} · ${res.data.platform} · machineId ${res.data.machineId.slice(0, 12)}… · db ${res.data.dbPath}`
          : `error ${res.code}: ${res.message}`,
      )
    } catch (err) {
      setResult(`excepción: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', lineHeight: 1.5 }}>
      <h1 style={{ marginBottom: '.25rem' }}>StockFlow Desktop — IPC ready</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Proceso main + bridge contextBridge activos. La interfaz de usuario llega en P06.
      </p>
      <button type="button" onClick={() => void checkBridge()} disabled={busy}>
        {busy ? 'Consultando…' : 'Probar window.stockflow.system.getInfo()'}
      </button>
      <pre style={{ background: '#f4f4f4', padding: '1rem', borderRadius: 6, marginTop: '1rem', whiteSpace: 'pre-wrap' }}>
        {result}
      </pre>
    </main>
  )
}

export default App
