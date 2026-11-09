// Vitest picks this file over vite.config.ts, so the renderer plugin stays out of the test run. Tests live under test/.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    testTimeout: 20000,
  },
});
