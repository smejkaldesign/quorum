// Meeting prep in the main process: the cache of what Quorum wrote, the prep note for one event, and the
// prepare-ahead pass. main.js passes in the vault, the model call, the calendar and the opt-out checks; the tests pass
// fakes. The cache in Quorum's data folder holds only the event id, the invite stamp, the note's vault path, the hash
// of what Quorum wrote and the failure count, so a note the person edited or deleted is never written over or back
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { similarTitle } from './meetingPlatforms.js';
import { setFrontmatterKey } from './frontmatter.js';
import { PREP_SYSTEM, gatherPrep, inPrepWindow, inviteStamp, inviteesOf, isPrepRel, joinLink, optedOut, parsePrep, prepPrompt, prepRel, renderPrep, wantsPrep } from './meetingPrep.js';

export const PLATFORM_NAMES = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams', webex: 'Webex' };
// model calls one prepare-ahead pass makes at most; the rest wait for the next pass
export const PASS_CAP = 6;
// after a failed reply the pass waits 20 minutes, then doubles the wait each time, up to 6 hours
export const backoffMs = (fails) => Math.min(6 * 3600000, 20 * 60000 * 2 ** Math.max(0, fails - 1));
export const prepHash = (t) => createHash('sha256').update(String(t)).digest('hex').slice(0, 16);
const bodyOf = (t) => String(t ?? '').replace(/^---\n[\s\S]*?\n---\n?/, '');

export function createPrepCache(file) {
  let data = {};
  try { if (existsSync(file)) data = JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { data = {}; }
  const save = () => { try { writeFileSync(file, JSON.stringify(data)); } catch { /* the next write tries again */ } };
  return {
    get: (id) => data[id] ?? null,
    entries: () => Object.values(data),
    // set replaces the entry (a note written clears failures and a dismissal); update merges into it
    set(id, v) { data[id] = { ...v, at: new Date().toISOString() }; save(); },
    update(id, v) { data[id] = { ...data[id], ...v }; save(); },
    // entries for events more than a week gone are dropped
    prune(now = Date.now()) { let n = 0; for (const [k, v] of Object.entries(data)) if (new Date(v.start ?? 0).getTime() < now - 7 * 86400000) { delete data[k]; n += 1; } if (n) save(); },
  };
}

// the wiki link targets of a prep note, mapped to files on disk, so the page opens each source in Quorum
export function prepLinks(vault, text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const abs = path.join(vault, `${m[1]}.md`);
    if (abs.startsWith(vault + path.sep) && existsSync(abs)) out[m[1]] = abs;
  }
  return out;
}

// The prep note a filed meeting note links back to: the newest note Quorum wrote for an event with a similar title that
// started within 30 minutes of the meeting, and that is still on disk (exists(rel)). A deleted one is not linked
export function prepNoteFor(entries, { title, start }, exists = () => true) {
  const at = new Date(start ?? '').getTime();
  if (!title || !Number.isFinite(at)) return null;
  const hit = entries
    .filter((x) => x?.rel && x.title && !x.dismissed && Math.abs(new Date(x.start ?? '').getTime() - at) <= 30 * 60000 && similarTitle(x.title, title) && exists(x.rel))
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))[0];
  return hit ? hit.rel : null;
}
// a filed meeting note with its link back to the prep note: one prep_note line in its frontmatter, nothing else changed.
// The link is the note's name only, so no vault folder reaches a note that syncs; prep names carry an event hash
export function withPrepLink(text, rel) {
  const name = String(rel ?? '').split('/').pop().replace(/\.md$/i, '').replace(/[[\]|]/g, ' ').trim();
  return name ? setFrontmatterKey(text, 'prep_note', JSON.stringify(`[[${name}]]`)) : text;
}

// d: { on(), conf(), brain() -> { vault, agentDoc() } | null, snapshot(), search(q, n), meetings(), isMe(a),
// mentionsOptOut(text), onNeverList(email), isExcluded(text), redact(text), modelReady(), runModel(prompt, system),
// events(days), listed(event, platform), folders(vault) -> { daily, meetings }, owner(), about(), write(abs, text), cache,
// log(...), now() }
export function createPrepRunner(d) {
  const now = () => (d.now ? d.now() : Date.now());
  const running = new Map();
  let calls = 0;

  async function run(e, { generate = false, force = false, auto = false }) {
    if (!d.on()) return { status: 'off' };
    const b = d.brain();
    if (!b) return { status: 'no-vault' };
    const invitees = inviteesOf(e, { isMe: d.isMe });
    if (d.mentionsOptOut(e.title) || d.mentionsOptOut(e.notes) || optedOut(invitees, { onNeverList: d.onNeverList, isExcluded: d.isExcluded }).length) return { status: 'opted-out' };
    const stamp = inviteStamp(e, invitees);
    const kept = d.cache.get(e.id) ?? {};
    const keptAbs = kept.rel ? path.join(b.vault, kept.rel) : null;
    const keptText = keptAbs && existsSync(keptAbs) ? readFileSync(keptAbs, 'utf8') : null;
    const edited = keptText != null && !!kept.hash && prepHash(keptText) !== kept.hash;
    const answer = (status) => ({ status, markdown: bodyOf(keptText), rel: kept.rel, file: keptAbs, links: prepLinks(b.vault, keptText), edited });
    const held = (status) => (keptText != null ? answer('changed') : { status });
    // a note Quorum wrote and the person deleted stays deleted until they ask for one
    if (kept.rel && keptText == null && !kept.dismissed) d.cache.update(e.id, { dismissed: true });
    if ((kept.dismissed || (kept.rel && keptText == null)) && !force) return { status: 'dismissed' };
    // an edited note is never written over: it shows as it is, and Prepare again writes a new note beside it
    if (keptText != null && !force && (kept.stamp === stamp || edited)) return answer(kept.stamp === stamp ? 'ready' : 'changed');
    const meetings = d.meetings();
    const known = new Set(meetings.flatMap((m) => (m.people ?? []).map((p) => String(p).toLowerCase())));
    if (!force && !wantsPrep(invitees, known, d.conf())) return held('skipped');
    if (!generate && !force) return held('stale');
    // the prepare-ahead pass waits out a failed reply for the same invite
    if (auto && kept.failStamp === stamp && now() < (kept.retryAt ?? 0)) return held('failed');
    if (!d.modelReady()) return held('no-model');
    const fail = () => {
      const fails = kept.failStamp === stamp ? (kept.fails ?? 0) + 1 : 1;
      d.cache.update(e.id, { failStamp: stamp, fails, retryAt: now() + backoffMs(fails), start: e.start });
      return held('failed');
    };
    calls += 1;
    try {
      // earlier prep notes are never a source: by their folder and name, or by their type
      const notes = d.snapshot().filter((n) => !n.cut && !isPrepRel(n.rel) && !/^---\n[\s\S]*?^type:\s*meeting-prep\b/m.test(n.text ?? ''))
        .map((n) => ({ rel: n.rel, title: n.note?.title ?? null, text: n.text }));
      const topic = String(e.title ?? '');
      let hits = d.search(topic, 8);
      const fewer = topic.split(/\s+/).filter((w) => w.length > 3).sort((x, y) => y.length - x.length).slice(0, 2).join(' ');
      if (!hits.length && fewer) hits = d.search(fewer, 8);
      const gathered = gatherPrep({ event: e, invitees, notes, meetings, topicRels: hits.map((h) => h.rel), now: now() });
      const prompt = d.redact(prepPrompt({ event: e, gathered, instructions: b.agentDoc?.() ?? '', owner: d.owner?.() ?? 'the user', about: d.about?.() ?? '' }));
      const reply = d.redact(String(await d.runModel(prompt, PREP_SYSTEM) ?? ''));
      const parsed = parsePrep(reply, gathered.sources);
      if (!parsed) return fail();
      const { join, platform } = joinLink(e);
      const at = new Date(e.start);
      const when = `${at.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}, ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      const text = renderPrep({ event: e, gathered, parsed, join, platformName: platform ? PLATFORM_NAMES[platform] : null, when });
      // Quorum's own unedited note keeps its path; otherwise the first name no file holds, so a file Quorum did not
      // write, or one the person edited, is never replaced
      const f = d.folders(b.vault) ?? {};
      let rel = keptText != null && !edited ? kept.rel : null;
      for (let n = 1; !rel && n < 20; n++) { const r = prepRel({ daily: f.daily ?? null, meetings: f.meetings ?? null, event: e, n }); if (!existsSync(path.join(b.vault, r))) rel = r; }
      const abs = rel ? path.join(b.vault, rel) : '';
      if (!rel || !abs.startsWith(b.vault + path.sep)) return held('failed');
      mkdirSync(path.dirname(abs), { recursive: true });
      d.write(abs, text);
      d.cache.set(e.id, { stamp, rel, hash: prepHash(text), start: e.start, title: e.title });
      return { status: 'ready', markdown: bodyOf(text), rel, file: abs, links: prepLinks(b.vault, text), edited: false };
    } catch (err) { d.log?.('meeting prep', err?.message); return fail(); }
  }

  // The prep note for one calendar event (the raw event, with its invitees). generate writes it when it is missing or
  // the invite changed; force writes it even for an event the filter skips, one the person deleted, or beside an
  // edited one; auto is the prepare-ahead pass. One run per event at a time: a second call gets the running one
  function prepFor(e, opts = {}) {
    const key = String(e?.id ?? '');
    if (running.has(key)) return running.get(key);
    const p = run(e, opts);
    if (!opts.generate && !opts.force) return p;
    const held = p.finally(() => running.delete(key));
    running.set(key, held);
    return held;
  }

  // Prepare ahead: the calls inside the window that pass the filter get their note written, one at a time, up to
  // PASS_CAP model calls a pass, so opening one is instant. A pass already running is the one that finishes
  let passing = false;
  async function prepAhead() {
    if (passing || !d.on() || !d.modelReady() || !d.brain()) return;
    passing = true;
    try {
      d.cache.prune(now());
      const t = now(), { ahead } = d.conf();
      const { events } = await d.events(2);
      const start = calls;
      for (const e of events) {
        if (!inPrepWindow(e, t, ahead) || d.isExcluded(e.title) || !d.listed(e, joinLink(e).platform)) continue;
        if (!d.on() || calls - start >= PASS_CAP) break;
        await prepFor(e, { generate: true, auto: true });
      }
    } catch (err) { d.log?.('meeting prep ahead', err?.message); } finally { passing = false; }
  }

  return { prepFor, prepAhead, calls: () => calls };
}
