import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // shadcn/ui components legitimately co-export a component plus its `cva`
      // variants / a hook. allowConstantExport permits the constant export, and
      // we keep this Vite-HMR DX rule at warn (the create-vite default) so it
      // never fails the build for generated UI primitives.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // The React-canonical data-fetching-in-effect pattern (ignore-flag stale
      // guard) necessarily calls setState inside the resolved promise. This rule
      // over-flags that async case (it targets synchronous render loops), so keep
      // it at warn rather than blocking the documented pattern.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
