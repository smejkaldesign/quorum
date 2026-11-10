// ESLint flat config for app/. Rules stay at the recommended sets with three adjustments: no-unused-vars warns, an
// empty catch block is allowed (the code base swallows expected failures that way on purpose), and the React Compiler
// rules that eslint-plugin-react-hooks 7 adds (refs, purity, immutability, set-state-in-effect) warn instead of
// erroring until those sites are reworked. CI fails on errors and reports warnings (.github/workflows/ci.yml).
// typescript-eslint is imported through lint/ (see lint/index.js): the root typescript@7 package is the native
// compiler and has no JavaScript API, so the parser needs the TypeScript 5 that lint/ installs on its own.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { tseslint } from './lint/index.js';

export default defineConfig([
  globalIgnores(['dist/', 'release/', 'build/', '.dev/', 'assets/']),
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 'latest', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['warn', { ignoreRestSiblings: true }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended, reactHooks.configs.flat.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
