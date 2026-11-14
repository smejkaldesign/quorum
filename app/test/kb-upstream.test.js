// Quorum's edits to synced KB notes kept as suggestions (ee/kbUpstream.js): the line diff, the three-way merge, what a
// sync does with each note, the upstream store, and the admin handlers. The database is a fake.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const { baseRow, commonLines, diffView, hunks, merge3, mergeOnto, normHash, planNote, sameNote, stripVolatile, suggestionFor, syncUpstream, withVolatileOf, CHANGED } = await import('../ee/kbUpstream.js');
const { createKnowledgeBases } = await import('../ee/knowledgeBases.js');

const sha = (t) => createHash('sha256').update(t).digest('hex');
const FM = '---\nvisibility: public\nkb_source: https://github.com/o/r/blob/main/Plan.md\n---\n';
const BASE = `${FM}# Plan\n\nShip the beta.\n\nAsk the team.\n\nWrite the docs.\n`;
const row = (base, suggestions = []) => ({ note_id: 'N1', base_hash: sha(base), base_norm: normHash(base), base_body: base, suggestions });
const synced = (text, at) => text.replace('---\n#', `kb_synced_at: ${at}\n---\n#`);

describe('line diff', () => {
  it('finds the shared lines and the changed blocks', () => {
    expect(commonLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([[0, 0], [2, 2]]);
    expect(hunks(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ start: 1, end: 2, lines: ['x'] }]);
    expect(hunks(['a'], ['a', 'b'])).toEqual([{ start: 1, end: 1, lines: ['b'] }]);
    expect(hunks([], [])).toEqual([]);
  });

  it('finds the longest run of shared lines in mixed edits', () => {
    const a = 'a b c d e f g h'.split(' ');
    const b = 'x a c d y f h z'.split(' ');
    const pairs = commonLines(a, b);
    expect(pairs.map(([i]) => a[i])).toEqual(['a', 'c', 'd', 'f', 'h']);
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
  });

  it('gives up past the edit limit, and keeps only a frontier per step', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(commonLines(a, b, 10)).toBeNull();
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const changed = big.map((l, i) => (i % 3 === 0 ? `${l} changed` : l));
    const pairs = commonLines(big, changed);
    expect(pairs).toHaveLength(2000);
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

  it('merges a frontmatter key added at the end of the block past the keys sync moved, and keeps the new ones', () => {
    const base = BASE;
    const ours = base.replace('Plan.md\n---', 'Plan.md\nowner: Ana\n---');
    const theirs = synced(BASE, '2026-11-13').replace('Ship the beta.', 'Ship it.');
    // without leaving the sync's keys out, both sides add a line at the end of the frontmatter
    expect(merge3(base, ours, theirs).clean).toBe(false);
    const text = mergeOnto(base, ours, theirs);
    expect(text).toContain('owner: Ana');
    expect(text).toContain('Ship it.');
    expect(text).toContain('kb_synced_at: 2026-11-13');
    expect(suggestionFor({ base: synced(BASE, 'old'), edited: synced(ours, 'old'), upstream: theirs })).toMatchObject({ state: 'ready' });
  });

  it('puts the sync\'s keys of another text back at the end of the frontmatter', () => {
    expect(withVolatileOf(BASE, synced(BASE, 'x'))).toBe(synced(BASE, 'x'));
    expect(withVolatileOf('# Plan\n', synced(BASE, 'x'))).toBe('---\nkb_synced_at: x\n---\n# Plan\n');
  });
});

describe('what a sync does with a note', () => {
  const edited = BASE.replace('Write the docs.\n', 'Write the docs.\n\n- [[Ana]]\n');
  const now = () => '2026-11-13T12:00:00.000Z';

  it('no agent edit: the source is written, nothing is suggested', () => {
    expect(planNote({ row: row(BASE), current: BASE, upstream: BASE.replace('beta', 'release'), now })).toEqual({ write: true, edited: false, suggestions: [], fresh: 0 });
  });

  it('source unchanged: the edit stays and nothing is written, even when only the sync\'s keys moved', () => {
    expect(planNote({ row: row(BASE), current: edited, upstream: BASE, now })).toEqual({ write: false, edited: true, suggestions: [], fresh: 0 });
    expect(planNote({ row: row(BASE), current: edited, upstream: synced(BASE, 'later'), now }).write).toBe(false);
  });

  it('clean apply: the source is written and the edit is a ready suggestion', () => {
    const upstream = BASE.replace('Ship the beta.', 'Ship the beta in May.');
    const p = planNote({ row: row(BASE), current: edited, upstream, now });
    expect(p).toMatchObject({ write: true, edited: true, fresh: 1 });
    expect(p.suggestions).toHaveLength(1);
    expect(p.suggestions[0]).toMatchObject({ state: 'ready', agent: edited, base: BASE, at: now() });
    expect(p.suggestions[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(p.suggestions[0].body).toContain('Ship the beta in May.');
    expect(p.suggestions[0].body).toContain('- [[Ana]]');
  });

  it('conflict: the edit is kept as a stale suggestion with the old base', () => {
    const current = BASE.replace('Ask the team.', 'Ask Ana.');
    const p = planNote({ row: row(BASE), current, upstream: BASE.replace('Ask the team.', 'Ask the board.'), now });
    expect(p.suggestions).toEqual([expect.objectContaining({ state: 'stale', body: current, agent: current, base: BASE })]);
  });

  it('no base recorded yet: the source is written, as before', () => {
    expect(planNote({ row: null, current: edited, upstream: BASE, now })).toEqual({ write: true, edited: false, suggestions: [], fresh: 0 });
  });

  it('an earlier suggestion is merged again and kept beside a new edit, never dropped', () => {
    const e1 = BASE.replace('Ask the team.', 'Ask Ana.');
    const upstream1 = BASE.replace('Ask the team.', 'Ask the board.');
    const first = planNote({ row: row(BASE), current: e1, upstream: upstream1, now });
    expect(first.suggestions.map((s) => s.state)).toEqual(['stale']);
    // the note is now the source's text; a second edit comes before the source changes again
    const e2 = upstream1.replace('Write the docs.\n', 'Write the docs.\n\n- [[Bo]]\n');
    const upstream2 = upstream1.replace('Ship the beta.', 'Ship it.');
    const second = planNote({ row: row(upstream1, first.suggestions), current: e2, upstream: upstream2, now });
    expect(second.fresh).toBe(1);
    expect(second.suggestions).toHaveLength(2);
    expect(second.suggestions[0]).toMatchObject({ id: first.suggestions[0].id, state: 'stale' });
    expect(second.suggestions[1].state).toBe('ready');
    expect(second.suggestions[1].body).toContain('Ship it.');
    expect(second.suggestions[1].body).toContain('- [[Bo]]');
  });

  it('drops an earlier suggestion only when the source already holds its change', () => {
    const e1 = BASE.replace('Ask the team.', 'Ask Ana.');
    const pending = suggestionFor({ base: BASE, edited: e1, upstream: BASE.replace('Ship the beta.', 'Ship it.') });
    const p = planNote({ row: row(BASE, [{ ...pending, id: 'a', at: 't' }]), current: BASE, upstream: e1, now });
    expect(p.suggestions).toEqual([]);
  });

  it('an edit the source already made is no suggestion', () => {
    expect(suggestionFor({ base: BASE, edited, upstream: edited })).toBeNull();
  });

  it('ignores the keys sync and pull set on their own', () => {
    const pulled = BASE.replace('---\n#', 'kb_checked_at: x\nteam_kb: KB1\n---\n#');
    expect(sameNote(BASE, pulled)).toBe(true);
    expect(stripVolatile(pulled)).toBe(BASE);
    expect(normHash(pulled)).toBe(normHash(BASE));
    expect(baseRow('N1', BASE)).toEqual({ note_id: 'N1', base_hash: sha(BASE), base_norm: normHash(BASE), base_body: BASE, suggestions: [] });
  });
});

describe('the upstream store', () => {
  function fakeClient({ rows = [], notes = [], fail = null } = {}) {
    const reads = [];
    const from = (table) => {
      const ops = [];
      const b = {};
      for (const op of ['select', 'eq', 'in']) b[op] = (...a) => { ops.push([op, ...a]); return b; };
      b.then = (res, rej) => {
        const [, cols] = ops.find((o) => o[0] === 'select');
        const [, , ids] = ops.find((o) => o[0] === 'in');
        reads.push([table, cols, ids.length]);
        if (fail === table) return Promise.resolve({ data: null, error: { message: 'timeout', code: '57014' } }).then(res, rej);
        const data = table === 'notes' ? notes.filter((n) => ids.includes(n.id)) : rows.filter((r) => ids.includes(r.note_id));
        return Promise.resolve({ data: structuredClone(data), error: null }).then(res, rej);
      };
      return b;
    };
    return { reads, client: () => ({ from }) };
  }
  const edited = `${BASE}- edit\n`;

  it('reads hashes first, then the texts of moved notes only', async () => {
    const c = fakeClient({ rows: [row(BASE), { ...row(BASE), note_id: 'N2' }], notes: [{ id: 'N2', body: edited }] });
    const up = syncUpstream({ client: c.client, ws: () => 'W' });
    await up.prepare([{ id: 'N1', hash: sha(BASE) }, { id: 'N2', hash: sha(edited) }, { id: 'N3', hash: 'x' }]);
    expect(c.reads).toEqual([['kb_note_upstream', 'note_id, base_hash, base_norm, suggestions', 3], ['notes', 'id, body', 1], ['kb_note_upstream', 'note_id, base_body', 1]]);
    expect(up.plan({ id: 'N1' }, BASE)).toMatchObject({ write: true, edited: false });
    expect(up.plan({ id: 'N2' }, BASE)).toMatchObject({ write: false, edited: true });
    expect(up.plan({ id: 'N3' }, BASE)).toMatchObject({ write: true, suggestions: [] });
  });

  it('turns itself off when a read fails, so the sync runs as before', async () => {
    const logs = [];
    const c = fakeClient({ rows: [row(BASE)], fail: 'kb_note_upstream' });
    const up = syncUpstream({ client: c.client, ws: () => 'W', log: (...a) => logs.push(a.join(' ')) });
    await up.prepare([{ id: 'N1', hash: 'moved' }]);
    expect(up.off).toBe(true);
    expect(up.plan({ id: 'N1' }, BASE)).toMatchObject({ write: true, suggestions: [] });
    expect(await up.write('KB1', [{ note_id: 'N1' }])).toBeNull();
    expect(logs[0]).toMatch(/read failed, syncing without suggestions/);
  });
});

function fakeDb({ note, upstream = null, table = true, rpcError = null }) {
  const rpcs = [];
  const answer = (data, error = null) => Promise.resolve({ data, error });
  const from = (t) => {
    const b = {};
    for (const op of ['select', 'eq', 'is', 'order', 'range', 'in']) b[op] = () => b;
    b.limit = () => {
      if (t === 'notes') return answer(note ? [{ ...note }] : []);
      if (!table) return answer(null, { message: 'relation "public.kb_note_upstream" does not exist', code: '42P01' });
      return answer(upstream ? [structuredClone(upstream)] : []);
    };
    return b;
  };
  const rpc = async (name, args) => { rpcs.push([name, args]); return { data: null, error: rpcError }; };
  const account = { client: () => ({ from, rpc }), state: () => ({ signedIn: true, userId: 'me', workspace: { id: 'W', role: 'member' } }) };
  return { rpcs, handlers: createKnowledgeBases({ account }).handlers };
}

describe('suggestion handlers', () => {
  const upstreamText = BASE.replace('Ship the beta.', 'Ship the beta in May.');
  const ready = { id: 's1', state: 'ready', body: `${upstreamText}\n- [[Ana]]\n`, agent: 'a', base: BASE, at: '2026-11-13T10:00:00Z' };
  const stale = { id: 's2', state: 'stale', body: 'old', agent: `${BASE}- old\n`, base: BASE, at: '2026-11-12T10:00:00Z' };
  const note = { id: 'N1', kb_id: 'KB1', body: upstreamText, hash: sha(upstreamText) };
  const up = (list) => ({ note_id: 'N1', base_body: upstreamText, suggestions: list });

  it('shows an admin each suggestion with a diff, and the note\'s hash', async () => {
    const { handlers } = fakeDb({ note, upstream: up([ready, stale]) });
    const r = await handlers['kb-suggestion']('N1');
    expect(r).toMatchObject({ edited: false, noteHash: note.hash });
    expect(r.suggestions.map((s) => [s.id, s.state, s.at])).toEqual([['s1', 'ready', ready.at], ['s2', 'stale', stale.at]]);
    expect(r.suggestions[0].lines.filter((l) => l.op === '+').map((l) => l.text)).toEqual(['', '- [[Ana]]']);
    expect(r.suggestions[1].lines.filter((l) => l.op === '+').map((l) => l.text)).toEqual(['- old']);
  });

  it('shows a reader nothing, and an older database nothing', async () => {
    expect(await fakeDb({ note, upstream: null }).handlers['kb-suggestion']('N1')).toEqual({ edited: false, noteHash: note.hash, suggestions: [] });
    expect(await fakeDb({ note, upstream: up([ready]), table: false }).handlers['kb-suggestion']('N1')).toEqual({ edited: false, noteHash: note.hash, suggestions: [] });
  });

  it('applies a ready suggestion to Quorum\'s copy through the database function, with the hash the page saw', async () => {
    const db = fakeDb({ note, upstream: up([ready]) });
    const r = await db.handlers['kb-suggestion-apply']('N1', 's1', note.hash);
    expect(r).toMatchObject({ ok: true, title: 'Plan' });
    expect(r.body).toContain('- [[Ana]]');
    const [[name, args]] = db.rpcs;
    expect(name).toBe('kb_suggestion_apply');
    expect(args).toMatchObject({ note_id: 'N1', suggestion_id: 's1', hash: sha(args.body), expected_hash: note.hash });
    expect(args.body).toContain('- [[Ana]]');
    expect(args.frontmatter).toMatchObject({ visibility: 'public', kb_source: 'https://github.com/o/r/blob/main/Plan.md' });
  });

  it('refuses when the note changed since the page read it, here or in the database', async () => {
    const db = fakeDb({ note, upstream: up([ready]) });
    expect(await db.handlers['kb-suggestion-apply']('N1', 's1', 'old-hash')).toEqual({ error: CHANGED, changed: true });
    expect(db.rpcs).toEqual([]);
    const raced = fakeDb({ note, upstream: up([ready]), rpcError: { message: 'This note changed since you opened it. Open it again to see the suggestion against the new text', code: 'P0001' } });
    expect(await raced.handlers['kb-suggestion-apply']('N1', 's1', note.hash)).toEqual({ error: CHANGED, changed: true });
  });

  it('keeps an edit made after the suggestion when applying, and refuses when the two clash', async () => {
    const later = { ...note, body: upstreamText.replace('# Plan', '# Plan\n\nOwner: Bo.') };
    later.hash = sha(later.body);
    const db = fakeDb({ note: later, upstream: up([ready]) });
    expect((await db.handlers['kb-suggestion-apply']('N1', 's1', later.hash)).ok).toBe(true);
    expect(db.rpcs[0][1].body).toContain('Owner: Bo.');
    expect(db.rpcs[0][1].body).toContain('- [[Ana]]');
    const clashing = { ...note, body: `${upstreamText}\n- [[Cy]]\n` };
    const clash = fakeDb({ note: clashing, upstream: up([ready]) });
    expect((await clash.handlers['kb-suggestion-apply']('N1', 's1')).error).toMatch(/changed after the suggestion/);
    expect(clash.rpcs).toEqual([]);
  });

  it('refuses to apply a stale suggestion or a missing one, and dismisses by id', async () => {
    const db = fakeDb({ note, upstream: up([stale]) });
    expect((await db.handlers['kb-suggestion-apply']('N1', 's2', note.hash)).error).toMatch(/older version/);
    expect(await db.handlers['kb-suggestion-apply']('N1', 'nope', note.hash)).toMatchObject({ changed: true });
    expect(await db.handlers['kb-suggestion-dismiss']('N1', 's2')).toEqual({ ok: true });
    expect(db.rpcs).toEqual([['kb_suggestion_dismiss', { note_id: 'N1', suggestion_id: 's2' }]]);
    expect((await db.handlers['kb-suggestion-dismiss']('N1')).error).toBeTruthy();
  });
});
