import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.claude']),
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
  },
  // ── mobile-client/: the page a paired phone runs ──
  //
  // Until T-75 this was a 2 964-line Rust string literal, so eslint had never
  // seen a character of it. It is now four real .js files that src-tauri's
  // build script glues into one <script>. They are plain browser ES5 with
  // `var` and function expressions, not React TypeScript, so they get their
  // own block rather than being bent into the one above.
  //
  // The rule that earns this block is `no-undef`, and it covers a gap tsc
  // leaves: the import statements at the top of client.js are the only
  // written-down record of which names the three spliced modules owe it, and
  // client.js is a .js importer, which tsc does not check unless `checkJs` is
  // on (it is not — see tsconfig.app.json for why). Drop a name from that
  // import block and eslint is the only thing that says so.
  //
  // The two relaxations below are this file's idiom, not a waiver: `catch(_){}`
  // is how the client swallows a failed localStorage read, and the only unused
  // bindings it has are catch parameters and unread arguments. Nothing else is
  // turned off — `npx eslint mobile-client` reports 5 real errors today (one
  // dead variable, four inert regex escapes) and they are left standing on
  // purpose, because T-75 ships the same page bytes it found. Fixing them is
  // its own change.
  {
    files: ['mobile-client/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: globals.browser,
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
])
