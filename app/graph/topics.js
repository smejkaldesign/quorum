// Named communities for one vault's memory graph: detection in a worker thread (communityWorker.js) a few seconds after
// the graph changes, names with no model (communities.js nameCommunity), and, only when the person turned it on, better
// names and summary drafts from their own model source. The drafts wait in community_info for the topic summary rule
// (rules/topicSummaries.js), which proposes them in Needs review; nothing here writes to the vault.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { detectCommunities, nameCommunity, readGraph } from './communities.js';
import { CALL_OVERHEAD_TOKENS, MEMORY_MODELS, costLabel, dollars, tokensOf } from '../memoryModels.js';
import { MAX_NEW, MIN_NOTES } from '../rules/topicSummaries.js';

// the worker and the code it imports are unpacked from app.asar (package.json asarUnpack), so a worker thread loads them
// from real files; scripts/check-package.mjs fails the build when they are missing
export const workerPath = (file = fileURLToPath(new URL('./communityWorker.js', import.meta.url))) => {
  const unpacked = file.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return unpacked !== file && existsSync(unpacked) ? unpacked : file;
};
// detection in a worker thread on its own read-only connection, so a large vault never holds up the window
export const inWorker = (file) => new Promise((resolve, reject) => {
  const w = new Worker(workerPath(), { workerData: { file } });
  w.once('message', (m) => { resolve(m); w.terminate(); });
  w.once('error', reject);
  w.once('exit', (code) => { if (code) reject(new Error(`community worker exited ${code}`)); });
});
// detection in this process, for the tests and for one cycle when a worker cannot start on a small vault
export const inProcess = (store) => async () => {
  const t0 = performance.now();
  const input = readGraph(store.db());
  const t1 = performance.now();
  return { ok: true, ...detectCommunities(input), readMs: Math.round(t1 - t0), ms: Math.round(performance.now() - t1) };
};

const sig = (parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
// the model names this many communities in one call
export const NAME_TOP = 20;
// a worker that cannot start falls back to this process only up to this many nodes (about 50 ms at 4,000); a larger
// vault skips detection that cycle and tries the worker again next time
export const MAX_IN_PROCESS = 5000;
// model calls for topics in one day, names and drafts together
export const DAILY_CALLS = 30;
// a community keeps its id while at least this share of its members stay together
const KEEP_ID = 0.5;
const NOTE_CHARS = 1500;
const DRAFT_NOTES = 12;
const NAME_OUT_TOKENS = 15;
const DRAFT_OUT_TOKENS = 600;

const NAME_SYSTEM = 'You name topics in a person\'s notes. Each topic below is a group of notes and entities that link to each other, listed with its strongest members, shared tags and folder. Give each topic a short plain name of 1 to 4 words that says what it is about, in the words the notes use. Answer with JSON only: an object from each topic id to its name.';
const DRAFT_SYSTEM = 'You write a short summary of one topic from a person\'s notes, for the person and for AI tools that read their vault. Use only what the notes say. After each statement, cite the note it comes from with its link exactly as given, such as [[projects/Orca]]. Write plain literal sentences, at most 250 words, with no figures of speech and no em dashes. Start with "## Summary"; add "## Open questions" only when the notes leave something undecided. Answer with the markdown only.';

// a name as the model wrote it, made safe for a file name and a heading
export const cleanName = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/\s*[—–]\s*/g, ', ').replace(/^["'`\s]+|["'`.,;:\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 60).trim();
// the model's summary with no frontmatter and no em dashes
export const cleanDraft = (s) => String(s ?? '').replace(/^```(?:markdown|md)?\n([\s\S]*?)\n```\s*$/, '$1').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/\s*[—–]\s*/g, ', ').trim();

// ids that last: a new community takes the id of the old one it shares most members with (Jaccard at least KEEP_ID),
// so a summary keeps its community when the hub changes; any other gets an id from a hash of its hub, which names no
// note. prev: [{ id, members: Set }]
export function stableIds(list, prev) {
  const taken = new Set();
  return list.map((c) => {
    const mine = new Set(c.members.map((m) => m.id));
    let best = null;
    let bestJ = KEEP_ID;
    for (const p of prev) {
      if (taken.has(p.id)) continue;
      let both = 0;
      for (const id of mine) if (p.members.has(id)) both++;
      const j = both / (mine.size + p.members.size - both || 1);
      if (j >= bestJ && (j > bestJ || !best || p.id < best)) { best = p.id; bestJ = j; }
    }
    const id = best ?? `c:${sig([c.hub]).slice(0, 10)}`;
    taken.add(id);
    return { ...c, id };
  });
}

// store: the graph store (graph/store.js); run(file): detection, in a worker by default; mayRead(rel): whether a note
// may be named or read for topics (no confidential or read-guarded note); model: { enabled(), ask(prompt, system) ->
// text, textOf(rel) -> text or null } for the person's model source; cap(): model calls a day; onChange(): after
// communities, names or drafts change
export function createTopics({ store, run = null, model = null, mayRead = () => true, cap = () => DAILY_CALLS, onChange = () => {}, log = () => {}, now = Date.now, delayMs = 10000, maxInProcess = MAX_IN_PROCESS }) {
  const state = { phase: 'idle', at: null, ms: null, count: 0, modularity: null, error: null, model: { running: false, at: null, error: null } };
  let timer = null;
  let running = null;
  let again = false;
  let closed = false;
  const worker = run ?? ((file) => inWorker(file));
  // a node a topic may show by name: one with no note, or a note it may read
  const shown = (id) => { const n = store.node(id); return n && (!n.rel || mayRead(n.rel)) ? n : null; };

  const detect = async () => {
    try { return await worker(store.path); } catch (err) {
      const nodes = store.db().prepare('select count(*) as n from nodes').get().n;
      if (nodes > maxInProcess) throw new Error(`the community worker could not start (${String(err?.message ?? err)}); skipped for ${nodes} nodes`, { cause: err });
      log('topics', 'worker failed, detecting in process this time', String(err?.message ?? err));
      return inProcess(store)();
    }
  };

  async function refresh() {
    if (closed) return state;
    if (running) { again = true; return running; }
    running = (async () => {
      state.phase = 'running';
      const t0 = now();
      try {
        const r = await detect();
        if (!r?.ok) throw new Error(r?.error ?? 'community detection failed');
        if (closed) return state;
        const prev = store.communities().map((c) => ({ id: c.id, members: new Set(store.communityMembers(c.id).map((m) => m.node)) }));
        const list = stableIds(r.communities, prev).map((c) => ({
          id: c.id, size: c.size, hub: c.hub, members: c.members, name: nameCommunity(c, shown),
          props: {
            tags: c.tags, folder: c.folder, weight: c.weight,
            nameSig: sig(c.members.slice(0, 10).map((m) => m.id).sort()),
            sourceSig: sig(c.members.map((m) => store.node(m.id)?.rel).filter(Boolean).sort().map((rel) => `${rel}@${store.fileHash(rel) ?? ''}`)),
          },
        }));
        store.setCommunities(list);
        store.meta('communities_at', now());
        store.meta('communities_q', r.modularity);
        Object.assign(state, { phase: 'ready', at: now(), ms: now() - t0, detectMs: r.ms, readMs: r.readMs, count: list.length, modularity: r.modularity, error: null });
        log('topics', `${list.length} communities in ${state.ms}ms (detect ${r.ms}ms)`);
        onChange('communities');
        if (model?.enabled?.()) modelPass().catch((err) => log('topics model', String(err?.message ?? err)));
      } catch (err) {
        Object.assign(state, { phase: 'error', error: String(err?.message ?? err) });
        log('topics', state.error);
      }
      return state;
    })().finally(() => {
      running = null;
      if (again && !closed) { again = false; schedule(0); }
    });
    return running;
  }

  function schedule(ms = delayMs) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refresh(); }, ms);
    timer.unref?.();
  }

  // ---- the person's model: names and summary drafts, only when they turned it on ----
  // the notes of a community the model may read, strongest first
  const sourcesOf = (c) => [...new Set(store.communityMembers(c.id).map((m) => store.node(m.node)?.rel).filter(Boolean))].filter((rel) => mayRead(rel));
  const topOf = (c) => store.communityMembers(c.id).map((m) => shown(m.node)).filter(Boolean).slice(0, 8);
  // a community is asked once per set of strongest members (nameTriedSig) and a draft once per set of sources
  // (draftTriedSig), whatever the answer was, so a failed or empty answer is not asked again until the notes change
  const namesNeeded = () => store.communities().filter((c) => c.size >= 3 && c.namedBy !== 'model' && c.props?.nameTriedSig !== c.props?.nameSig && topOf(c).length).slice(0, NAME_TOP);
  const draftsNeeded = () => store.communities().filter((c) => c.size >= 3 && sourcesOf(c).length >= MIN_NOTES).slice(0, MAX_NEW)
    .filter((c) => c.props?.draft?.sig !== c.props?.sourceSig && c.props?.draftTriedSig !== c.props?.sourceSig);
  const namePrompt = (list) => list.map((c) => [
    `${c.id}`, `  members: ${topOf(c).map((n) => `${n.name} (${n.kind})`).join(', ')}`,
    c.props?.tags?.length ? `  tags: ${c.props.tags.join(', ')}` : null, c.props?.folder ? `  folder: ${c.props.folder}` : null,
  ].filter(Boolean).join('\n')).join('\n');
  const draftPrompt = (c) => {
    const notes = sourcesOf(c).slice(0, DRAFT_NOTES).map((rel) => {
      const t = model.textOf?.(rel);
      return typeof t === 'string' && t.trim() ? `<note link="[[${rel.replace(/\.md$/i, '')}]]">\n${t.slice(0, NOTE_CHARS)}\n</note>` : null;
    }).filter(Boolean);
    return { text: `Topic: ${c.name}\n\n${notes.join('\n\n')}`, notes: notes.length };
  };

  // model calls today, kept in the store so a restart does not reset them
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const spent = () => { try { const v = JSON.parse(store.meta('topics_calls') ?? '{}'); return v.day === today() ? v.n : 0; } catch { return 0; } };
  const spend = () => { if (spent() >= cap()) return false; store.meta('topics_calls', JSON.stringify({ day: today(), n: spent() + 1 })); return true; };

  // what turning the model on would cost now: one call for the names, one for each summary draft, at API rates
  function estimate() {
    const names = namesNeeded();
    const drafts = draftsNeeded();
    const nameChars = names.length ? NAME_SYSTEM.length + namePrompt(names).length : 0;
    const draftChars = drafts.reduce((s, c) => s + DRAFT_SYSTEM.length + (model?.textOf ? draftPrompt(c).text.length : sourcesOf(c).length * NOTE_CHARS), 0);
    const calls = (names.length ? 1 : 0) + drafts.length;
    const input = tokensOf(nameChars + draftChars) + calls * CALL_OVERHEAD_TOKENS;
    const output = names.length * NAME_OUT_TOKENS + drafts.length * DRAFT_OUT_TOKENS;
    const usd = dollars(MEMORY_MODELS.draft, input, output);
    return { calls, names: names.length, summaries: drafts.length, inputTokens: input, outputTokens: output, cost: usd, costLabel: costLabel(usd), left: Math.max(0, cap() - spent()) };
  }

  let modelRun = null;
  async function modelPass() {
    if (modelRun || closed || !model?.ask) return modelRun;
    modelRun = (async () => {
      state.model.running = true;
      let changed = false;
      try {
        const names = namesNeeded();
        if (names.length && spend()) {
          // the members each name was asked for: a name lands only on a community that still has them
          const asked = new Map(names.map((c) => [c.id, c.props?.nameSig]));
          for (const c of names) store.updateCommunity(c.id, { props: { nameTriedSig: c.props?.nameSig } });
          const text = String(await model.ask(namePrompt(names), NAME_SYSTEM) ?? '');
          let parsed = {};
          try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { log('topics model', 'names were not JSON'); }
          for (const c of names) {
            const name = cleanName(parsed?.[c.id]);
            const cur = store.communityInfo(c.id);
            if (!name || closed || !cur || cur.props?.nameSig !== asked.get(c.id)) continue;
            if (store.updateCommunity(c.id, { name, namedBy: 'model', props: { ruleName: cur.name } })) changed = true;
          }
        }
        for (const c of draftsNeeded()) {
          if (closed || !model.enabled()) break;
          const p = draftPrompt(c);
          if (p.notes < MIN_NOTES) continue;
          if (!spend()) { log('topics model', `daily cap of ${cap()} calls reached`); break; }
          store.updateCommunity(c.id, { props: { draftTriedSig: c.props?.sourceSig } });
          const text = cleanDraft(await model.ask(p.text, DRAFT_SYSTEM));
          // the draft holds only for the sources it was written from
          const cur = store.communityInfo(c.id);
          if (text && cur && cur.props?.sourceSig === c.props?.sourceSig && store.updateCommunity(c.id, { props: { draft: { sig: c.props.sourceSig, text, at: now() } } })) changed = true;
        }
        state.model.error = null;
      } catch (err) {
        state.model.error = String(err?.message ?? err);
        log('topics model', state.model.error);
      } finally {
        state.model.running = false;
        state.model.at = now();
        modelRun = null;
      }
      if (changed && !closed) onChange('model');
    })();
    return modelRun;
  }

  return {
    refresh,
    schedule,
    estimate,
    modelPass,
    status: () => ({ ...state, model: { ...state.model, on: !!model?.enabled?.(), ready: model?.ready ? !!model.ready() : !!model?.ask } }),
    close: () => { closed = true; clearTimeout(timer); },
  };
}
