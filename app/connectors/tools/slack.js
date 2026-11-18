// Slack read tools with the person's own user token: message search, the channels they are in, a channel's history and
// a thread. Direct messages are never read: channels come from users.conversations with public and private channel
// types only, and search results from a DM are dropped.
import { ProviderError, readJson, request } from './http.js';

const API = 'https://slack.com/api/';
const RECONNECT = 'Slack needs to be connected again. In Quorum, open Settings > Connectors > Slack, choose Disconnect, then Connect.';
const SCOPES = 'Slack needs to be connected again so Quorum can read messages with the permissions it now asks for. In Quorum, open Settings > Connectors > Slack, choose Disconnect, then Connect.';
const USER_TTL = 60 * 60 * 1000;

function slackError(code) {
  if (code === 'missing_scope') return new ProviderError(SCOPES, { code: 'reauth' });
  if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(code)) return new ProviderError(RECONNECT, { code: 'reauth' });
  if (code === 'channel_not_found' || code === 'not_in_channel') return new ProviderError('That channel is not one of the Slack channels you are in.', { code });
  if (code === 'thread_not_found') return new ProviderError('That Slack thread was not found.', { code });
  if (code === 'ratelimited') return new ProviderError('Slack is limiting requests right now. Try again in a minute.', { code: 'rate_limited' });
  return new ProviderError(`Slack refused the request (${code ?? 'no reason given'}).`, { code });
}

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
export const tsTime = (ts) => (ts ? new Date(Number(String(ts).split('.')[0]) * 1000).toISOString() : null);
// a Slack ts as given, or an ISO date as a ts
export function toTs(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(String(v))) return String(v);
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) throw new ProviderError('oldest must be an ISO date or a Slack ts.');
  return String(Math.floor(t / 1000));
}
// a direct or group message: flagged as one, a D id, an mpdm- name, or a private conversation Slack says is neither a
// channel nor a group (the fields are checked only when Slack sends them)
const isDm = (c) => !!(c?.is_im || c?.is_mpim || /^D/.test(String(c?.id ?? '')) || /^mpdm-/.test(String(c?.name ?? ''))
  || (c?.is_private && c?.is_channel === false && c?.is_group === false));

// users: a Map the caller keeps between calls, id -> { name, at }
export function createSlack({ token, fetchImpl, wait, users = new Map(), now = Date.now }) {
  async function call(method, params = {}) {
    const u = new URL(method, API);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    const r = await request('Slack', u.toString(), { headers: { authorization: `Bearer ${token}` } }, { fetchImpl, wait });
    const data = await readJson(r);
    if (!data) throw new ProviderError(`Slack answered ${r.status}. Try again.`);
    if (!data.ok) throw slackError(data.error);
    return data;
  }

  async function userName(id) {
    if (!id) return null;
    const hit = users.get(id);
    if (hit && now() - hit.at < USER_TTL) return hit.name;
    let name = id;
    try {
      const u = (await call('users.info', { user: id })).user;
      name = u?.profile?.display_name || u?.real_name || u?.name || id;
    } catch (e) { if (e.code === 'reauth' || e.code === 'rate_limited') throw e; }
    users.set(id, { name, at: now() });
    return name;
  }

  // <@U123> mentions as @name, <#C1|general> as #general, <https://x|label> as label (https://x)
  async function plain(text) {
    const s = String(text ?? '');
    const ids = [...new Set([...s.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
    const names = new Map();
    for (const id of ids) names.set(id, await userName(id));
    return s
      .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${names.get(id)}`)
      .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:[^>]+)>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }

  async function message(m) {
    return {
      ts: m.ts, time: tsTime(m.ts), user: m.user ? await userName(m.user) : m.username ?? m.bot_profile?.name ?? null, text: await plain(m.text),
      ...(m.reply_count ? { replies: m.reply_count } : {}), ...(m.thread_ts && m.thread_ts !== m.ts ? { threadTs: m.thread_ts } : {}),
      ...(m.files?.length ? { files: m.files.map((f) => f.name ?? f.title).filter(Boolean) } : {}),
    };
  }

  async function memberChannels() {
    const out = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const d = await call('users.conversations', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200, cursor });
      out.push(...(d.channels ?? []).filter((c) => !isDm(c)));
      cursor = d.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return out;
  }

  async function channelOf(ref) {
    const want = String(ref ?? '').trim().replace(/^#/, '');
    if (!want) throw new ProviderError('channel is required: an id from slack_channels or a #name.');
    const c = (await memberChannels()).find((x) => x.id === want || x.name === want.toLowerCase());
    if (!c) throw slackError('not_in_channel');
    return c;
  }

  return {
    async search({ query, limit, page }) {
      const q = String(query ?? '').trim();
      if (!q) throw new ProviderError('query is required.');
      const d = await call('search.messages', { query: q, count: clamp(limit, 1, 50, 20), page: clamp(page, 1, 100, 1) });
      const matches = (d.messages?.matches ?? []).filter((m) => !isDm(m.channel));
      const results = [];
      for (const m of matches) results.push({ channel: m.channel?.name ? `#${m.channel.name}` : null, channelId: m.channel?.id ?? null, ...(await message(m)), link: m.permalink ?? null });
      const p = d.messages?.paging ?? {};
      return { total: d.messages?.total ?? results.length, page: p.page ?? 1, pages: p.pages ?? 1, results };
    },
    async channels({ query } = {}) {
      const q = String(query ?? '').trim().toLowerCase();
      const list = (await memberChannels()).filter((c) => !q || String(c.name).includes(q));
      return { channels: list.map((c) => ({ id: c.id, name: `#${c.name}`, private: !!c.is_private, members: c.num_members ?? null, topic: c.topic?.value || null })) };
    },
    async history({ channel, limit, oldest }) {
      const c = await channelOf(channel);
      const d = await call('conversations.history', { channel: c.id, limit: clamp(limit, 1, 200, 50), oldest: toTs(oldest) });
      const messages = [];
      for (const m of d.messages ?? []) messages.push(await message(m));
      return { channel: `#${c.name}`, channelId: c.id, more: !!d.has_more, messages };
    },
    async thread({ channel, ts }) {
      if (!ts) throw new ProviderError('ts is required: the ts of the first message.');
      const c = await channelOf(channel);
      const d = await call('conversations.replies', { channel: c.id, ts: String(ts), limit: 200 });
      const messages = [];
      for (const m of d.messages ?? []) messages.push(await message(m));
      return { channel: `#${c.name}`, channelId: c.id, more: !!d.has_more, messages };
    },
  };
}
