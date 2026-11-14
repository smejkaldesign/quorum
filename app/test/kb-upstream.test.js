// Quorum's edits to synced KB notes kept as suggestions (ee/kbUpstream.js): the line diff, the three-way merge, what a
// sync does with each note, and the admin handlers. The database is a fake.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const { commonLines, diffView, hunks, merge3, resyncPlan, sameNote, stripVolatile, suggestionFor, upstreamRow } = await import('../ee/kbUpstream.js');
const { createKnowledgeBases } = await import('../ee/knowledgeBases.js');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const FM = '---\nvisibility: public\nkb_source: https://github.com/o/r/blob/main/Plan.md\n---\n';
const BASE = `${FM}# Plan\n\nShip the beta.\n\nAsk the team.\n\nWrite the docs.\n`;
const row = (base, extra = {}) => ({ note_id: 'N1', base_hash: sha(base), base_body: base, suggestion_state: null, suggestion_body: null, suggestion_agent: null, suggestion_base: null, ...extra });

describe('line diff', () => {
  it('finds the shared lines and the changed blocks', () => {
    expect(commonLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([[0, 0], [2, 2]]);
    expect(hunks(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ start: 1, end: 2, lines: ['x'] }]);
    expect(hunks(['a'], ['a', 'b'])).toEqual([{ start: 1, end: 1, lines: ['b'] }]);
    expect(hunks([], [])).toEqual([]);
  });

  it('gives up past the edit limit', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(commonLines(a, b, 10)).toBeNull();
    expect(merge3(a.join('\n'), b.join('\n'), a.join('\n')).clean).toBe(true);
  });

  it('folds long unchanged runs in the view', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const v = diffView(before, after);
    expect(v[0]).toEqual({ op: '~', text: '7' });
    expect(v.filter((l) => l.op === '-')).toEqual([{ op: '-', text: 'line 10' }]);
    expect(v.filter((l) => l.op === '+')).toEqual([{ op: '+', text: 'line ten' }]);
    expect(v.at(-1)).toEqual({ op: '~', text: '6' });
  });
});

describe('three-way merge', () => {
  it('puts a clean edit onto the new source', () => {
    const ours = BASE.replace('Write the docs.\n', 'Write the docs.\n\n## Meetings\n\n- [[Ana]]\n');
    const theirs = BASE.replace('Ship the beta.', 'Ship the beta on Friday.');
    const m = merge3(BASE, ours, theirs);
    expect(m.clean).toBe(true);
    expect(m.text).toContain('Ship the beta on Friday.');
    expect(m.text).toContain('- [[Ana]]');
  });

  it('applies both edits when they only meet at a boundary', () => {
    const ours = BASE.replace('Ask the team.', 'Ask the team.\n- [[Bo]]');
    const theirs = BASE.replace('Write the docs.', 'Write the guide.');
    expect(merge3(BASE, ours, theirs)).toMatchObject({ clean: true });
  });

  it('reports a conflict when both change the same lines, or both insert at the same place', () => {
    expect(merge3(BASE, BASE.replace('Ask the team.', 'Ask Ana.'), BASE.replace('Ask the team.', 'Ask the board.')).clean).toBe(false);
    expect(merge3(BASE, `${BASE}- a\n`, `${BASE}- b\n`).clean).toBe(false);
  });

  it('counts the same change on both sides once', () => {
    const same = BASE.replace('Ask the team.', 'Ask Ana.');
    expect(merge3(BASE, same, same)).toEqual({ clean: true, text: same });
  });
});

describe('what a sync does with a note', () => {
  const edited = BASE.replace('Write the docs.\n', 'Write the docs.\n\n- [[Ana]]\n');

  it('no agent edit: the source is written, nothing is suggested', () => {
    expect(resyncPlan({ base: row(BASE), current: BASE, upstream: BASE.replace('beta', 'release') })).toEqual({ write: true, edited: false, suggestion: null });
  });

  it('source unchanged: Quorum\'s edit stays and nothing is written', () => {
    expect(resyncPlan({ base: row(BASE), current: edited, upstream: BASE })).toEqual({ write: false, edited: true, suggestion: undefined });
    // only the sync's own keys moved: still unchanged
    const resynced = BASE.replace('---\n#', 'kb_synced_at: 2026-11-13T10:00:00.000Z\n---\n#');
    expect(resyncPlan({ base: row(BASE), current: edited, upstream: resynced }).write).toBe(false);
  });

  it('clean apply: the source is written and the edit is a ready suggestion', () => {
    const upstream = BASE.replace('Ship the beta.', 'Ship the beta in May.');
    const p = resyncPlan({ base: row(BASE), current: edited, upstream });
    expect(p.write).toBe(true);
    expect(p.suggestion).toMatchObject({ state: 'ready', agent: edited, base: BASE });
    expect(p.suggestion.body).toContain('Ship the beta in May.');
    expect(p.suggestion.body).toContain('- [[Ana]]');
  });

  it('conflict: the edit is kept as a stale suggestion with the old base', () => {
    const current = BASE.replace('Ask the team.', 'Ask Ana.');
    const p = resyncPlan({ base: row(BASE), current, upstream: BASE.replace('Ask the team.', 'Ask the board.') });
    expect(p).toMatchObject({ write: true, edited: true, suggestion: { state: 'stale', body: current, agent: current, base: BASE } });
  });

  it('no base recorded yet: the source is written, as before', () => {
    expect(resyncPlan({ base: null, current: edited, upstream: BASE })).toEqual({ write: true, edited: false, suggestion: null });
  });

  it('a suggestion from an earlier sync is merged again against a newer source', () => {
    const newer = BASE.replace('Ship the beta.', 'Ship it.');
    const base = row(BASE.replace('Ask the team.', 'Ask everyone.'), { suggestion_state: 'stale', suggestion_body: edited, suggestion_agent: edited, suggestion_base: BASE });
    const p = resyncPlan({ base, current: base.base_body, upstream: newer });
    expect(p.suggestion).toMatchObject({ state: 'ready' });
    expect(p.suggestion.body).toContain('Ship it.');
    expect(p.suggestion.body).toContain('- [[Ana]]');
  });

  it('an edit the source already made is no suggestion', () => {
    expect(suggestionFor({ base: BASE, edited, upstream: edited })).toBeNull();
  });

  it('ignores the keys sync and pull set on their own', () => {
    const pulled = BASE.replace('---\n#', 'kb_checked_at: x\nteam_kb: KB1\n---\n#');
    expect(sameNote(BASE, pulled)).toBe(true);
    expect(stripVolatile(pulled)).toBe(BASE);
    expect(upstreamRow('N1', BASE, undefined, row(BASE, { suggestion_state: 'ready', suggestion_body: 'b', suggestion_agent: 'a', suggestion_base: 'c' })))
      .toMatchObject({ base_body: BASE, base_hash: sha(BASE), suggestion_state: 'ready', suggestion_body: 'b' });
  });
});

function fakeDb({ note, upstream = null, table = true }) {
  const rpcs = [];
  const answer = (data, error = null) => Promise.resolve({ data, error });
  const from = (t) => {
    const b = {};
    for (const op of ['select', 'eq', 'is', 'order', 'range', 'in']) b[op] = () => b;
    b.limit = () => {
      if (t === 'notes') return answer(note ? [{ ...note }] : []);
      if (!table) return answer(null, { message: 'relation "public.kb_note_upstream" does not exist', code: '42P01' });
      return answer(upstream ? [{ ...upstream }] : []);
    };
    return b;
  };
  const rpc = async (name, args) => { rpcs.push([name, args]); return { data: null, error: null }; };
  const account = { client: () => ({ from, rpc }), state: () => ({ signedIn: true, userId: 'me', workspace: { id: 'W', role: 'member' } }) };
  return { rpcs, handlers: createKnowledgeBases({ account }).handlers };
}

describe('suggestion handlers', () => {
  const upstreamText = BASE.replace('Ship the beta.', 'Ship the beta in May.');
  const ready = { ...row(upstreamText), suggestion_state: 'ready', suggestion_body: `${upstreamText}\n- [[Ana]]\n`, suggestion_agent: 'a', suggestion_base: BASE, suggested_at: '2026-11-13T10:00:00+00:00' };
  const note = { id: 'N1', kb_id: 'KB1', body: upstreamText, frontmatter: {} };

  it('shows an admin the ready suggestion as a diff from the note as it is now', async () => {
    const { handlers } = fakeDb({ note, upstream: ready });
    const r = await handlers['kb-suggestion']('N1');
    expect(r.edited).toBe(false);
    expect(r.suggestion).toMatchObject({ state: 'ready', at: '2026-11-13T10:00:00+00:00' });
    expect(r.suggestion.lines.filter((l) => l.op === '+').map((l) => l.text)).toEqual(['', '- [[Ana]]']);
  });

  it('shows a reader nothing, and an older database nothing', async () => {
    expect(await fakeDb({ note, upstream: null }).handlers['kb-suggestion']('N1')).toEqual({ edited: false, suggestion: null });
    expect(await fakeDb({ note, upstream: ready, table: false }).handlers['kb-suggestion']('N1')).toEqual({ edited: false, suggestion: null });
  });

  it('applies a ready suggestion to Quorum\'s copy through the database function', async () => {
    const db = fakeDb({ note, upstream: ready });
    const r = await db.handlers['kb-suggestion-apply']('N1');
    expect(r).toMatchObject({ ok: true, title: 'Plan' });
    expect(r.body).toContain('- [[Ana]]');
    const [[name, args]] = db.rpcs;
    expect(name).toBe('kb_suggestion_apply');
    expect(args).toMatchObject({ note_id: 'N1', body: ready.suggestion_body, hash: sha(ready.suggestion_body), suggested_at: ready.suggested_at });
    expect(args.frontmatter).toMatchObject({ visibility: 'public', kb_source: 'https://github.com/o/r/blob/main/Plan.md' });
  });

  it('keeps an edit made after the suggestion when applying, and refuses when the two clash', async () => {
    const later = { ...note, body: upstreamText.replace('# Plan', '# Plan\n\nOwner: Bo.') };
    const db = fakeDb({ note: later, upstream: ready });
    const r = await db.handlers['kb-suggestion-apply']('N1');
    expect(r.ok).toBe(true);
    expect(db.rpcs[0][1].body).toContain('Owner: Bo.');
    expect(db.rpcs[0][1].body).toContain('- [[Ana]]');
    const clash = fakeDb({ note: { ...note, body: `${upstreamText}\n- [[Cy]]\n` }, upstream: ready });
    expect((await clash.handlers['kb-suggestion-apply']('N1')).error).toMatch(/changed after the suggestion/);
    expect(clash.rpcs).toEqual([]);
  });

  it('refuses to apply a stale suggestion and dismisses either kind', async () => {
    const stale = { ...ready, suggestion_state: 'stale', suggestion_body: 'old', suggestion_agent: 'old', suggestion_base: BASE };
    const db = fakeDb({ note, upstream: stale });
    expect((await db.handlers['kb-suggestion']('N1')).suggestion.state).toBe('stale');
    expect((await db.handlers['kb-suggestion-apply']('N1')).error).toMatch(/older version/);
    expect(await db.handlers['kb-suggestion-dismiss']('N1')).toEqual({ ok: true });
    expect(db.rpcs).toEqual([['kb_suggestion_dismiss', { note_id: 'N1' }]]);
  });
});
