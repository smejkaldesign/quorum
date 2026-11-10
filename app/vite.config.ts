import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// QUORUM_EDITION picks the renderer edition at build time. The define becomes a string literal, so the cloud-only
// branches in src/edition.tsx are removed from the local bundle (scripts/check-edition-boundary.mjs verifies this).
const edition = process.env.QUORUM_EDITION === 'cloud' ? 'cloud' : 'local';

export default defineConfig({
  plugins: [react()],
  base: './',
  define: { __QUORUM_EDITION__: JSON.stringify(edition) },
  build: { outDir: 'dist', emptyOutDir: true },
});
