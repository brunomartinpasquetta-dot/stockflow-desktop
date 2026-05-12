import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-electron']),
  // Renderer (React, navegador) + config de Vite
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
  // Componentes shadcn/ui (exportan `xxxVariants`), contextos (exportan hooks) y
  // el router: no aplican la regla "sólo exportar componentes" (no son HMR-fast-refresh).
  {
    files: ['src/components/ui/**/*.{ts,tsx}', 'src/contexts/**/*.{ts,tsx}', 'src/router.tsx'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  // Proceso main de Electron + tests de integración (Node)
  {
    files: ['electron/**/*.{ts,tsx,mts,cts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // TypeScript ya valida símbolos no definidos; `no-undef` produce falsos
      // positivos con tipos globales (NodeJS, etc.).
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
])
