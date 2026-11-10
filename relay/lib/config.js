// every setting the relay reads from the environment, in one place; nothing here is ever logged
const env = (k, d = undefined) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);

export const config = {
  port: Number(env('PORT', 8787)),
  supabaseUrl: env('SUPABASE_URL'),
  supabaseAnonKey: env('SUPABASE_ANON_KEY'),
  supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
  engine: env('RELAY_ENGINE', 'assemblyai'),
  keys: { assemblyai: env('ASSEMBLYAI_API_KEY'), deepgram: env('DEEPGRAM_API_KEY'), anthropic: env('ANTHROPIC_API_KEY') },
  openaiModel: env('RELAY_OPENAI_MODEL', 'gpt-4o-mini'),
  // caps: one connection may carry 4 hours of audio; 20 seconds without a frame ends it
  maxSessionSeconds: Number(env('RELAY_MAX_SESSION_SECONDS', 4 * 3600)),
  idleMs: Number(env('RELAY_IDLE_MS', 20000)),
  helloMs: 10000,
  // billing (billing.js): the Stripe secret, the webhook signing secret, the seat and pack price ids, where Checkout returns to
  // platform connections (connect.js): the Zoom app's client credentials for the token exchange and its webhook secret token
  connect: { zoom: { clientId: env('ZOOM_CLIENT_ID'), clientSecret: env('ZOOM_CLIENT_SECRET'), webhookSecret: env('ZOOM_WEBHOOK_SECRET') } },
  stripe: { key: env('STRIPE_SECRET_KEY'), webhookSecret: env('STRIPE_WEBHOOK_SECRET'), seatPrice: env('STRIPE_SEAT_PRICE'), packPrice: env('STRIPE_PACK_PRICE'), returnUrl: env('BILLING_RETURN_URL', 'https://quorum.watch').replace(/\/+$/, '') },
};

export const HOURS_PER_SEAT = 20;
export const HOURS_PER_PACK = 20;

export function checkConfig(c = config) {
  const missing = ['supabaseUrl', 'supabaseAnonKey', 'supabaseServiceRoleKey'].filter((k) => !c[k]);
  if (missing.length) throw new Error(`relay: missing ${missing.map((k) => k.replace(/([A-Z])/g, '_$1').toUpperCase()).join(', ')}`);
  if (!c.keys.assemblyai && !c.keys.deepgram) throw new Error('relay: set ASSEMBLYAI_API_KEY or DEEPGRAM_API_KEY');
  if (!['assemblyai', 'deepgram'].includes(c.engine)) throw new Error(`relay: RELAY_ENGINE must be assemblyai or deepgram, got ${c.engine}`);
  if (!c.keys[c.engine]) throw new Error(`relay: RELAY_ENGINE is ${c.engine} but its key is not set`);
}
