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
  // personal connectors (oauth.js): the client pairs of Quorum's own OAuth apps for the providers whose code exchange
  // needs a secret, the address this relay answers on (its callback URLs are built from it), and any extra redirect
  // URIs a self-hosted or development relay accepts, comma separated
  oauth: {
    notion: { clientId: env('NOTION_CLIENT_ID'), clientSecret: env('NOTION_CLIENT_SECRET') },
    slack: { clientId: env('SLACK_CLIENT_ID'), clientSecret: env('SLACK_CLIENT_SECRET') },
    github: { clientId: env('GITHUB_CLIENT_ID'), clientSecret: env('GITHUB_CLIENT_SECRET') },
  },
  publicUrl: env('RELAY_PUBLIC_URL', 'https://relay.quorum.watch').replace(/\/+$/, ''),
  oauthExtraRedirects: env('OAUTH_EXTRA_REDIRECT_URIS', '').split(',').map((s) => s.trim()).filter(Boolean),
  stripe: { key: env('STRIPE_SECRET_KEY'), webhookSecret: env('STRIPE_WEBHOOK_SECRET'), seatPrice: env('STRIPE_SEAT_PRICE'), packPrice: env('STRIPE_PACK_PRICE'), returnUrl: env('BILLING_RETURN_URL', 'https://quorum.watch').replace(/\/+$/, '') },
  // beta access (platform.js): the browser origins allowed to call the request intake and the code email, the Resend key
  // and sender for that email, the owner's address for the new-signup notice, and the download link it carries
  corsOrigins: env('CORS_ORIGINS', 'https://quorum.watch,https://www.quorum.watch,https://admin.quorum.watch').split(',').map((s) => s.trim()).filter(Boolean),
  mail: { resendKey: env('RESEND_API_KEY'), from: env('MAIL_FROM', 'Quorum <noreply@quorum.watch>'), replyTo: env('MAIL_REPLY_TO'), notifyTo: env('MAIL_NOTIFY_TO', 'eric@smejkal.design'), downloadUrl: env('DOWNLOAD_URL', 'https://github.com/smejkaldesign/quorum/releases/latest/download/Quorum-Cloud-arm64.dmg') },
  // the owner's passkey (passkeys.js): the WebAuthn relying party id, the registrable domain the admin app lives under
  passkey: { rpId: env('PASSKEY_RP_ID', 'quorum.watch') },
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
