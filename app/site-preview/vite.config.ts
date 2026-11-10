import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The app preview on quorum.watch: the local-edition renderer with the sample bridge (mock.ts), written into the site
// folder. The base is absolute because the site serves the folder at /app-preview without a trailing slash.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react()],
  base: '/app-preview/',
  define: { __QUORUM_EDITION__: JSON.stringify('local') },
  build: { outDir: path.resolve(here, '../../site/app-preview'), emptyOutDir: true },
});
