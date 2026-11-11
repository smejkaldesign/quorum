// The admin app is static; the Supabase project it talks to and the relay it calls are fixed at build time:
//   QUORUM_SUPABASE_URL, QUORUM_SUPABASE_ANON_KEY   the hosted project (shell, or the repo's .env for a production build)
//   RELAY_URL                                       the relay that sends the code email (default relay.quorum.watch)
// A development build (vite dev) falls back to the local Supabase stack and a relay on localhost, so the app can be
// tried against `supabase start` with nothing set. The anon key is the publishable one; no secret is ever built in.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = (name: string): Record<string, string> => {
  const file = path.join(here, '..', name);
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
};
// the local stack's anon key is the same on every machine and printed by the CLI; read it when the CLI is here
const localStack = () => {
  try {
    const out = execSync('supabase status -o env', { cwd: path.join(here, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
    const key = out.match(/^ANON_KEY="?([^"\n]+)"?/m)?.[1];
    const url = out.match(/^API_URL="?([^"\n]+)"?/m)?.[1];
    if (key && url) return { url, key };
  } catch {}
  return { url: 'http://127.0.0.1:54321', key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0' };
};

export default defineConfig(({ mode }) => {
  const dev = mode === 'development';
  const file = envFile(dev ? '.env.development' : '.env');
  const url = process.env.QUORUM_SUPABASE_URL || file.QUORUM_SUPABASE_URL;
  const key = process.env.QUORUM_SUPABASE_ANON_KEY || file.QUORUM_SUPABASE_ANON_KEY;
  const supabase = url && key ? { url, key } : dev ? localStack() : { url: '', key: '' };
  if (!supabase.url) console.warn('admin: QUORUM_SUPABASE_URL and QUORUM_SUPABASE_ANON_KEY are not set; the build will show "not configured"');
  const relay = (process.env.RELAY_URL || file.RELAY_URL || (dev ? 'http://127.0.0.1:8787' : 'https://relay.quorum.watch')).replace(/\/+$/, '');
  return {
    plugins: [react()],
    define: { __QUORUM_SUPABASE__: JSON.stringify(supabase), __RELAY_URL__: JSON.stringify(relay) },
    server: { port: 5180 },
    test: { environment: 'node' },
  };
});
