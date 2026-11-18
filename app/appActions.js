// The Memory health and Knowledge tools (cli/appTools.mjs) as the running app runs them for an AI tool over the control
// socket. Each tool calls the handler the app's own button calls (call(name, ...args) is that ipcMain handler), so a fix
// goes through the fix journal, saves versions and has Undo, a bulk Approve is one batch with Cancel, and the window
// updates as it would after a click. Plain Node, so the tests drive it with stubbed handlers.
//
// Safety: a write tool is refused while Quorum is set to read only. Approve, dismiss, undo and the knowledge base writes
// also need Settings > Memory, Let AI tools change memory and knowledge bases (settings.memoryAgentActions, off by
// default). While a tool runs, its MCP client is the actor (currentActor), so the decision log records it and the fix
// shows "Approved by Claude Code".
import { AsyncLocalStorage } from 'node:async_hooks';
import { AGENT_SETTING, appTool } from './cli/appTools.mjs';
import { deepMap, strings } from './connectors/tools/index.js';

const acting = new AsyncLocalStorage();
export const currentActor = () => acting.getStore()?.actor ?? 'you';
// work that outlives the tool call (the fix queue) runs as nobody in particular, so it never takes the caller's name
export const outsideActor = (fn) => acting.exit(fn);
// the MCP client's name as the CLI sends it (lowercase words joined by hyphens), as mcp:<name>. The prefix keeps a tool's
// actor apart from Quorum's own (you, auto, quorum, cli) whatever the client calls itself; a reserved or empty name is
// mcp:agent
const RESERVED = new Set(['you', 'auto', 'quorum', 'cli', 'agent', 'mcp']);
export function agentActor(via) {
  const v = String(via ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 40);
  return `mcp:${v && !RESERVED.has(v) ? v : 'agent'}`;
}
const NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', agent: 'an AI tool' };
export function actorLabel(actor) {
  if (!actor || actor === 'you') return 'you';
  if (actor === 'auto') return 'Quorum';
  const name = String(actor).replace(/^mcp:/, '');
  return NAMES[name] ?? name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export const READ_ONLY = 'Quorum is set to read only, so AI tools cannot change anything. Change Access to Read and write in Quorum under Settings > AI tools.';
// the refusal names what was blocked and the switch that allows it
export const gateOff = (blocked) => `AI tools cannot ${blocked} yet. In Quorum, turn on Settings > Memory > ${AGENT_SETTING}, then try again.`;
export const DRAFTS_OFF = 'Check everything now runs the memory agent, which is off. In Quorum, turn on Settings > Memory > Let the agent draft fixes, then try again.';
const CLOUD = 'Knowledge bases are part of Quorum Cloud, and this copy of Quorum has none or is signed out.';
const TALLY_MS = 5000;
const PLANNED = new Set(['link', 'finding', 'past-fix']);
const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
const iso = (t) => (t ? new Date(t).toISOString() : null);
const q = (t) => `“${t}”`;

const brief = (r) => ({
  id: r.id, kind: r.review.kind, title: r.detail?.title ?? r.target?.title ?? '', note: r.target?.rel || null,
  problem: r.detail?.problem ?? null, approve: r.detail?.recommend ?? r.detail?.solution ?? null, unread: !!r.unread, at: iso(r.at), fixing: !!r.fixRun,
});
const runBrief = (r) => ({
  id: r.id, batch: r.batch ?? null, kind: r.kind ?? 'link', target: r.target, status: r.status, outcome: r.outcome ?? null, error: r.error ?? null,
  items: r.items?.length ?? null, by: r.by ?? null, queuedAt: iso(r.queuedAt), endedAt: iso(r.endedAt), undo: r.status === 'success' && !r.undoneAt && r.undoable !== false,
});

// call(name, ...args): the app's ipcMain handler of that name. settings(): the app's settings. kbHosted(), kbSync():
// the Cloud knowledge base handlers, or null. accounts(): accounts.list(). readTools(): the connector read tools that
// are listed now. toast(text): a toast in the window. isExcluded, redact: the opted-out customer filter; withheld(rel):
// a note in a withheld folder
export function createAppActions({ call, settings, kbHosted = () => null, kbSync = () => null, accounts = () => [], readTools = () => [], toast = () => {}, isExcluded = () => false, redact = (t) => t, withheld = () => false, log = () => {}, now = Date.now }) {
  const shown = (r) => !withheld(String(r.target?.rel ?? '')) && !isExcluded(strings([r.target?.title, r.target?.rel, r.detail?.title, r.detail?.problem]).join('\n'));
  const reviewRows = async () => ((await call('activity-feed', { review: true, kinds: ['memory-health'], sort: 'recent', offset: 0, limit: 1e6 }))?.items ?? []).filter((r) => r.review && shown(r));
  async function rowsFor(ids) {
    const want = [...new Set((Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean))];
    if (!want.length) throw new Error('ids is required: item ids from review_items.');
    const byId = new Map((await reviewRows()).map((r) => [r.id, r]));
    const missing = want.filter((id) => !byId.has(id));
    if (missing.length) throw new Error(`Not in Needs review: ${missing.join(', ')}. List the items again with review_items.`);
    return want.map((id) => byId.get(id));
  }
  const answer = (r) => ({ kind: r.review.kind, abs: r.target?.abs ?? '', key: r.review.key });
  const failedOf = (res) => (res?.failed ?? []).map((f) => f.error);
  const say = (text, key = null) => { try { toast(text, key); } catch {} };
  // approvals and archives from one actor a few seconds apart show as one toast that counts them all
  const tallies = new Map();
  const count = (verb, n, one, tail = '') => {
    const key = `${currentActor()}:${verb}`;
    const t = tallies.get(key);
    const total = t && now() - t.at < TALLY_MS ? t.total + n : n;
    tallies.set(key, { total, at: now() });
    say(total === 1 && one ? `${who()} ${verb} ${one}` : `${who()} ${verb} ${total} ${total === 1 ? 'item' : 'items'} in Needs review${tail}`, key);
  };
  // the actor at the start of a toast, capitalized: An AI tool approved, The quorum command started
  const who = () => { const l = actorLabel(currentActor()); return l.charAt(0).toUpperCase() + l.slice(1); };
  const kbOr = (get) => { const k = get(); if (!k) throw new Error(CLOUD); return k.handlers; };
  const kbResult = (r) => { if (r?.error) throw new Error(r.error); if (r?.canceled) throw new Error('The GitHub sign-in was cancelled, so nothing was attached.'); return r; };

  const tools = {
    async review_items({ kind, unread, query, limit, offset } = {}) {
      const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const list = (await reviewRows()).filter((r) => (!kind || r.review.kind === kind) && (!unread || r.unread) && words.every((w) => strings([r.summary, r.detail?.title, r.detail?.problem, r.target?.rel]).join(' ').toLowerCase().includes(w)));
      const start = clamp(offset, 0, 1e6, 0);
      const page = list.slice(start, start + clamp(limit, 1, 100, 25));
      return { total: list.length, more: start + page.length < list.length, items: page.map(brief) };
    },
    async review_item({ id }) {
      const [r] = await rowsFor([id]);
      return { ...brief(r), solution: r.detail?.solution ?? null, value: r.detail?.value ?? null, details: r.details ?? r.detail?.meta ?? null };
    },
    async review_approve({ ids }) {
      const rows = await rowsFor(ids);
      const busy = rows.filter((r) => r.fixRun);
      if (busy.length) throw new Error(`Already being fixed: ${busy.map((r) => r.id).join(', ')}.`);
      if (rows.length === 1) {
        const res = await call('activity-review', [answer(rows[0])], 'approve');
        const failed = failedOf(res);
        if (failed.length) throw new Error(failed[0]);
        const run = (await call('fix-runs')).find((x) => (x.key === rows[0].review.key || x.items?.some((i) => i.id === rows[0].id)) && (x.status === 'queued' || x.status === 'running' || x.status === 'success'));
        count('approved', 1, q(brief(rows[0]).title));
        return { approved: [rows[0].id], run: run ? runBrief(run) : null };
      }
      // several: the bulk Approve, one batch with one Undo and Cancel; a proposed rule has no fix to plan and is answered on its own
      const planned = rows.filter((r) => PLANNED.has(r.review.kind));
      const others = rows.filter((r) => !PLANNED.has(r.review.kind));
      const out = { approved: [], run: null, left: [] };
      if (planned.length) {
        const { run } = await call('fix-plan-apply', planned.map((r) => r.id), [], {}, []);
        if (!run) throw new Error('Nothing in these items can run as a batch. Approve them one at a time to see why.');
        const inRun = new Set((run.items ?? []).map((i) => i.id));
        out.run = runBrief(run);
        out.approved.push(...planned.filter((r) => inRun.has(r.id)).map((r) => r.id));
        out.left.push(...planned.filter((r) => !inRun.has(r.id)).map((r) => r.id));
      }
      if (others.length) {
        const res = await call('activity-review', others.map(answer), 'approve');
        const bad = new Set((res?.failed ?? []).map((f) => f.abs));
        for (const r of others) (bad.has(r.target?.abs ?? '') ? out.left : out.approved).push(r.id);
      }
      count('approved', out.approved.length, null);
      return out;
    },
    async review_dismiss({ ids }) {
      const rows = await rowsFor(ids);
      const res = await call('activity-review', rows.map(answer), 'dismiss');
      const failed = failedOf(res);
      if (failed.length === rows.length) throw new Error(failed[0]);
      count('archived', rows.length - failed.length, null, ' without fixing them');
      return { dismissed: rows.length - failed.length, failed };
    },
    async review_mark_read({ ids, unread }) {
      const rows = await rowsFor(ids);
      return { marked: await call('activity-mark', rows.map((r) => ({ id: r.id, abs: r.target?.abs ?? '' })), unread === true) };
    },
    async memory_check_start() {
      // the button turns on Let the agent draft fixes when it is off; a tool never changes that setting for the person
      if (settings()?.memoryDrafts !== true) throw new Error(DRAFTS_OFF);
      const r = await call('memory-catchup-start');
      say(`${who()} started Check everything now`);
      return r;
    },
    memory_check_status: () => call('memory-catchup-status'),
    async fix_runs({ limit } = {}) {
      return { runs: (await call('fix-runs')).slice(0, clamp(limit, 1, 100, 20)).map(runBrief) };
    },
    async fix_cancel({ batch }) {
      // a tool may stop its own batch; one the person, Quorum or another tool started needs the setting
      const live = (await call('fix-runs')).filter((r) => r.batch === String(batch ?? '') && (r.status === 'queued' || r.status === 'running'));
      if (!live.length) throw new Error('Nothing in that batch is queued or running.');
      if (live.some((r) => r.actor !== currentActor()) && settings()?.memoryAgentActions !== true) throw new Error(gateOff('cancel a batch it did not start'));
      const n = await call('fix-cancel', String(batch ?? ''));
      if (!n) throw new Error('Nothing in that batch is queued or running.');
      say(`${who()} cancelled a batch of memory fixes`);
      return { cancelled: n };
    },
    async fix_undo({ id }) {
      const text = await call('fix-undo', String(id ?? ''));
      say(`${who()} ${String(text).charAt(0).toLowerCase()}${String(text).slice(1)}`);
      return { undone: String(id), message: text };
    },
    async kb_create({ name, team }) {
      const r = kbResult(await kbOr(kbHosted)['kb-hosted-create'](name, team ?? null));
      say(`${who()} created the knowledge base ${q(r.kb?.name ?? name)}`);
      return r;
    },
    async kb_attach_github({ kb, url, branch }) {
      const r = kbResult(await kbOr(kbSync)['kb-sync-attach-github']({ kbId: kb, folderId: null, url, branch }));
      say(`${who()} attached a GitHub repository to a knowledge base`);
      return r;
    },
    async kb_list_attachments({ kb }) { return kbResult(await kbOr(kbSync)['kb-sync-list'](kb)); },
    async connector_status() {
      const tools = readTools();
      return { accounts: accounts().map((a) => ({ id: a.id, name: a.name, available: !!a.configured, connected: !!a.connected, account: a.account ?? null, connectedAt: a.connectedAt ?? null, error: a.error ?? null, readTools: tools.filter((t) => t.startsWith(`${a.id}_`)) })) };
    },
  };

  async function run(name, args = {}, via = null) {
    const def = appTool(name);
    if (!def || !tools[name]) throw new Error(`Unknown tool ${name}`);
    const s = settings() ?? {};
    if (def.write && s.access === 'read') throw new Error(READ_ONLY);
    if (def.gated && s.memoryAgentActions !== true) throw new Error(gateOff(def.blocked));
    const actor = agentActor(via);
    return acting.run({ actor }, async () => {
      try {
        const r = await tools[name](args && typeof args === 'object' ? args : {});
        if (def.write) log('ai action', name, actor);
        return deepMap(r, redact);
      } catch (e) {
        log('ai action refused', name, actor);
        throw e;
      }
    });
  }
  return { run };
}
