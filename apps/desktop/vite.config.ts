import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// base "./" => rutas relativas para que Electron pueda cargar el bundle via file://
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor-react'
          if (/[\\/]node_modules[\\/](lucide-react|sonner|class-variance-authority|clsx|tailwind-merge)[\\/]/.test(id)) return 'vendor-ui'
          if (/[\\/]node_modules[\\/](@tanstack[\\/]react-query|react-hook-form|@hookform[\\/]resolvers|zod)[\\/]/.test(id)) return 'vendor-data'
          return undefined
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
