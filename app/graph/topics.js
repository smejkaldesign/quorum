// Named communities for one vault's memory graph: detection in a worker thread (communityWorker.js) a few seconds after
// the graph changes, names with no model (communities.js nameCommunity), and, only when the person turned it on, better
// names and summary drafts from their own model source. The drafts wait in community_info for the topic summary rule
// (rules/topicSummaries.js), which proposes them in Needs review; nothing here writes to the vault.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { detectCommunities, nameCommunity, readGraph } from './communities.js';
import { CALL_OVERHEAD_TOKENS, MEMORY_MODELS, costLabel, dollars, tokensOf } from '../memoryModels.js';
import { MAX_NEW, MIN_NOTES } from '../rules/topicSummaries.js';

const WORKER = fileURLToPath(new URL('./communityWorker.js', import.meta.url));
// detection in a worker thread on its own read-only connection, so a large vault never holds up the window
export const inWorker = (file) => new Promise((resolve, reject) => {
  const w = new Worker(WORKER, { workerData: { file } });
  w.once('message', (m) => { resolve(m); w.terminate(); });
  w.once('error', reject);
  w.once('exit', (code) => { if (code) reject(new Error(`community worker exited ${code}`)); });
});
// detection in this process, for the tests and when a worker cannot start
export const inProcess = (store) => async () => {
  const t0 = performance.now();
  const input = readGraph(store.db());
  const t1 = performance.now();
  return { ok: true, ...detectCommunities(input), readMs: Math.round(t1 - t0), ms: Math.round(performance.now() - t1) };
};

const sig = (parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
// the model names this many communities in one call
export const NAME_TOP = 20;
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

// store: the graph store (graph/store.js); run(file): detection, in a worker by default; model: { enabled(), ask(prompt,
// system) -> text, textOf(rel) } for the person's model source; onChange(): after communities, names or drafts change
export function createTopics({ store, run = null, model = null, onChange = () => {}, log = () => {}, now = Date.now, delayMs = 10000 }) {
  const state = { phase: 'idle', at: null, ms: null, count: 0, modularity: null, error: null, model: { running: false, at: null, error: null } };
  let timer = null;
  let running = null;
  let again = false;
  let closed = false;
  let worker = run ?? ((file) => inWorker(file));

  const detect = async () => {
    try { return await worker(store.path); } catch (err) {
      // a packaged app that cannot start the worker runs the same code here; about 50 ms on a 4,000 note vault
      log('topics', 'worker failed, detecting in process', String(err?.message ?? err));
      worker = inProcess(store);
      return worker();
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
        const nodeOf = (id) => store.node(id);
        const list = r.communities.map((c) => ({
          id: c.id, size: c.size, hub: c.hub, members: c.members, name: nameCommunity(c, nodeOf),
          props: {
            tags: c.tags, folder: c.folder, weight: c.weight,
            nameSig: sig(c.members.slice(0, 10).map((m) => m.id).sort()),
            sourceSig: sig(c.members.map((m) => nodeOf(m.id)?.rel).filter(Boolean).sort().map((rel) => `${rel}@${store.fileHash(rel) ?? ''}`)),
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
  const namesNeeded = () => store.communities().filter((c) => c.size >= 3 && c.namedBy !== 'model').slice(0, NAME_TOP);
  const sourcesOf = (c) => [...new Set(store.communityMembers(c.id).map((m) => store.node(m.node)?.rel).filter(Boolean))];
  const draftsNeeded = () => store.communities().filter((c) => c.size >= 3 && sourcesOf(c).length >= MIN_NOTES).slice(0, MAX_NEW).filter((c) => c.props?.draft?.sig !== c.props?.sourceSig);
  const namePrompt = (list) => list.map((c) => {
    const top = store.communityMembers(c.id).slice(0, 8).map((m) => { const n = store.node(m.node); return n ? `${n.name} (${n.kind})` : m.node; });
    return [`${c.id}`, `  members: ${top.join(', ')}`, c.props?.tags?.length ? `  tags: ${c.props.tags.join(', ')}` : null, c.props?.folder ? `  folder: ${c.props.folder}` : null].filter(Boolean).join('\n');
  }).join('\n');
  const draftPrompt = (c) => {
    const notes = sourcesOf(c).slice(0, DRAFT_NOTES).map((rel) => {
      const t = model.textOf?.(rel);
      return typeof t === 'string' && t.trim() ? `<note link="[[${rel.replace(/\.md$/i, '')}]]">\n${t.slice(0, NOTE_CHARS)}\n</note>` : null;
    }).filter(Boolean);
    return { text: `Topic: ${c.name}\n\n${notes.join('\n\n')}`, notes: notes.length };
  };

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
    return { calls, names: names.length, summaries: drafts.length, inputTokens: input, outputTokens: output, cost: usd, costLabel: costLabel(usd) };
  }

  let modelRun = null;
  async function modelPass() {
    if (modelRun || closed || !model?.ask) return modelRun;
    modelRun = (async () => {
      state.model.running = true;
      let changed = false;
      try {
        const names = namesNeeded();
        if (names.length) {
          const text = String(await model.ask(namePrompt(names), NAME_SYSTEM) ?? '');
          let parsed = {};
          try { parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { log('topics model', 'names were not JSON'); }
          for (const c of names) {
            const name = cleanName(parsed?.[c.id]);
            if (name && !closed && store.updateCommunity(c.id, { name, namedBy: 'model', props: { ruleName: c.name } })) changed = true;
          }
        }
        for (const c of draftsNeeded()) {
          if (closed || !model.enabled()) break;
          const p = draftPrompt(c);
          if (p.notes < MIN_NOTES) continue;
          const text = cleanDraft(await model.ask(p.text, DRAFT_SYSTEM));
          if (text && store.updateCommunity(c.id, { props: { draft: { sig: c.props?.sourceSig, text, at: now() } } })) changed = true;
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
    status: () => ({ ...state, model: { ...state.model, on: !!model?.enabled?.() } }),
    close: () => { closed = true; clearTimeout(timer); },
  };
}
