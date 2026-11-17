// Vitest picks this file over vite.config.ts, so the renderer plugin stays out of the test run. Tests live under test/.
import { defineConfig } from 'vitest/config';
// run here too, so the test workers start with the fixed TMPDIR
import './test/setup-tmp.js';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // keeps temp folders out of a repo when TMPDIR points into one (test/setup-tmp.js)
    setupFiles: ['test/setup-tmp.js'],
    testTimeout: 20000,
  },
});
