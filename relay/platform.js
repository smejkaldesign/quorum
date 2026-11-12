// Beta access for Quorum Cloud, both halves through the relay so neither page carries a Supabase key: a visitor on
// quorum.watch asks for access (POST /v1/access-requests, written with the service role, rate limited by address),
// and the platform owner in the admin app sends the code the request turned into (POST /v1/platform/send-code, the
// owner's session checked against Supabase Auth, the mail sent through Resend). The request intake is public; the
// code email is refused for anyone but a platform owner.
import { bearer, RelayError, verifyToken } from './lib/auth.js';
import { readJson } from './summary.js';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CODE = /^[A-Z2-9]{8}$/;

const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(body)); };
const failJson = (res, err, log, what, extra = {}) => {
  const status = err instanceof RelayError ? err.status : 500;
  log(`${what}_failed`, { status, message: err.message });
  json(res, status, { error: err instanceof RelayError ? err.message : 'Something went wrong. Try again.', code: err.code ?? 'server' }, extra);
};

// the browser pages that may call these two routes; any other origin gets no CORS headers and the browser refuses the answer
export function corsHeaders(origin, allowed = []) {
  if (!origin || !allowed.includes(origin)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '600', vary: 'origin' };
}

// the request as the database wants it: a real email, the optional fields trimmed and bounded, the source one word
export function cleanRequest(b = {}) {
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new RelayError('bad_request', 'Enter a full email address.', 400);
  const name = String(b.name ?? '').trim().slice(0, 120) || null;
  const note = String(b.note ?? '').trim().slice(0, 1000) || null;
  const source = (String(b.source ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40)) || 'site';
  return { email, name, note, source };
}

// a few requests an hour per address: enough for a person, little for a script
export function createLimiter({ max = 5, windowMs = 3600000, now = Date.now } = {}) {
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(t); hits.set(key, list);
      if (hits.size > 10000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
      return true;
    },
  };
}

export const clientAddress = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

const limiter = createLimiter();

export async function handleAccessRequest(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    const b = await readJson(req, 16 * 1024);
    // a filled honeypot field is a bot; it gets the same answer as a person and nothing is written
    if (String(b.website ?? '').trim()) return json(res, 200, { ok: true }, cors);
    if (!limiter.allow(clientAddress(req))) throw new RelayError('rate_limit', 'Too many requests from this connection. Try again in an hour.', 429);
    const r = cleanRequest(b);
    const { data, error } = await clients.db.rpc('access_request_create', { email: r.email, name: r.name, note: r.note, source: r.source });
    if (error) throw new RelayError('server', /email address/i.test(error.message) ? 'Enter a full email address.' : 'The request could not be saved. Try again.', /email address/i.test(error.message) ? 400 : 500);
    log('access_requested', { domain: r.email.split('@')[1], source: r.source, already: data?.already === true });
    json(res, 200, { ok: true, already: data?.already === true }, cors);
    // the owner hears about a new signup by email; a failure here changes nothing for the visitor
    if (data?.already !== true && config.mail?.resendKey && config.mail.notifyTo) {
      const m = signupNotice({ to: config.mail.notifyTo, email: r.email, name: r.name, note: r.note, source: r.source });
      sendMail(config, fetchImpl, m).then((ok) => log(ok ? 'signup_notified' : 'signup_notify_refused', { domain: r.email.split('@')[1] })).catch((err) => log('signup_notify_failed', { message: err.message }));
    }
  } catch (err) { failJson(res, err, log, 'access_request', cors); }
}

// one message to the owner per new request: who asked, from where, and the note if they left one
export function signupNotice({ to, email, name, note, source }) {
  const lines = [`New beta signup: ${email}`, '', name ? `Name: ${name}` : null, `From: ${source}`, note ? `Note: ${note}` : null, '', 'Approve or decline it in the admin app.'].filter((l) => l !== null);
  return { to, subject: `New beta signup: ${email}`, text: lines.join('\n'), html: null };
}

async function sendMail(config, fetchImpl, m) {
  const r = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${config.mail.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.mail.from, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(config.mail.replyTo ? { reply_to: config.mail.replyTo } : {}) }),
  });
  return r.ok;
}

// the one email the owner sends: which plan the person is approved for, the code, where to download, what to do
// with it, and when it runs out. A free code points at the open-source release; a cloud code at the Cloud build.
export const OPEN_SOURCE_DOWNLOAD = 'https://github.com/smejkaldesign/quorum/releases/latest';
export function codeEmail({ email, name, code, expiresAt, downloadUrl, plan = 'cloud', product = 'Quorum' }) {
  const pretty = `${code.slice(0, 4)}-${code.slice(4, 8)}`;
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : null;
  const hello = name ? `Hi ${String(name).split(/\s+/)[0]},` : 'Hi,';
  const cloud = plan === 'cloud';
  const tier = cloud ? `${product} Cloud` : `${product} Free`;
  const link = cloud ? downloadUrl : OPEN_SOURCE_DOWNLOAD;
  const edition = cloud ? `${product} Cloud for Mac` : `${product} for Mac (open source)`;
  const lines = [
    hello, '',
    `You are approved for ${tier}. Your access code is:`, '', `    ${pretty}`, '',
    `1. Download ${edition}: ${link}`,
    cloud ? '2. Open it, choose Sign in, and enter this email address.' : '2. Open it and enter this email address when the app asks.',
    cloud ? '3. Enter the access code when asked, then the 6-digit code from the sign-in email.' : '3. Enter the access code when asked.',
    '',
    until ? `The access code works once and lasts until ${until}.` : 'The access code works once.',
    '', `Reply to this email if anything gets in the way.`, '', `${product}`,
  ];
  const text = lines.join('\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font: 16px/1.5 -apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, system-ui, sans-serif; color: #111; max-width: 520px">
<p>${esc(hello)}</p>
<p>You are approved for ${esc(tier)}. Your access code is:</p>
<p style="font: 600 28px/1.2 ui-monospace, 'SF Mono', Menlo, monospace; letter-spacing: 0.08em; margin: 18px 0">${esc(pretty)}</p>
<ol style="padding-left: 20px">
<li><a href="${esc(link)}">Download ${esc(edition)}</a></li>
<li>${cloud ? 'Open it, choose <strong>Sign in</strong>, and enter this email address.' : 'Open it and enter this email address when the app asks.'}</li>
<li>${cloud ? 'Enter the access code when asked, then the 6-digit code from the sign-in email.' : 'Enter the access code when asked.'}</li>
</ol>
<p style="color: #555">${until ? `The access code works once and lasts until ${esc(until)}.` : 'The access code works once.'}</p>
<p>Reply to this email if anything gets in the way.</p>
<p>${esc(product)}</p>
</div>`;
  return { subject: `You're approved for ${tier}`, text, html, to: email, plan: cloud ? 'cloud' : 'free' };
}

async function requireOwner({ anon, db }, token) {
  const user = await verifyToken(anon, token);
  const { data, error } = await db.from('platform_owners').select('user_id').eq('user_id', user.userId).maybeSingle();
  if (error) throw new RelayError('server', 'The owner role could not be read.', 500);
  if (!data) throw new RelayError('forbidden', 'Only the platform owner can do that.', 403);
  return user;
}

export async function handleSendCode(req, res, { clients, config, log = () => {}, fetchImpl = fetch }) {
  const cors = corsHeaders(req.headers.origin, config.corsOrigins);
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  try {
    if (req.method !== 'POST') throw new RelayError('bad_request', 'POST only.', 405);
    await requireOwner(clients, bearer(req.headers.authorization));
    if (!config.mail?.resendKey) throw new RelayError('mail', 'Mail is not set up on this relay. Copy the code and send it yourself.', 503);
    const b = await readJson(req, 16 * 1024);
    const email = String(b.email ?? '').trim().toLowerCase();
    const code = String(b.code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (!EMAIL.test(email)) throw new RelayError('bad_request', 'Enter a full email address.', 400);
    if (!CODE.test(code)) throw new RelayError('bad_request', 'That is not an access code.', 400);
    const mail = codeEmail({ email, name: b.name ?? null, code, expiresAt: b.expiresAt ?? null, downloadUrl: config.mail.downloadUrl, plan: b.plan === 'cloud' ? 'cloud' : 'free' });
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${config.mail.resendKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.mail.from, to: [email], subject: mail.subject, text: mail.text, html: mail.html, ...(config.mail.replyTo ? { reply_to: config.mail.replyTo } : {}) }),
    });
    if (!r.ok) { log('code_mail_refused', { status: r.status }); throw new RelayError('mail', 'The email could not be sent. Copy the code and send it yourself.', 502); }
    log('code_sent', { domain: email.split('@')[1], plan: mail.plan });
    json(res, 200, { ok: true, sent: true }, cors);
  } catch (err) { failJson(res, err, log, 'send_code', cors); }
}
