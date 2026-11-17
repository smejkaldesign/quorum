// Contradiction detection on a synthetic vault (test/fixtures/contradictions). Every note, name and number is made up.
// claims.json is what the fake model answers per note (the fake finds each quote's line in the prompt it gets);
// judge.json is the fake judge's label per pair; expected.json lists the findings the pipeline should make.
// Covered: true contradictions (Atlas, Beacon, Juliet), different times (Comet), a scope split (Delta), a refinement
// (Echo), the same fact in other words (Foxtrot), an explicit superseded marker (Golf), an authority inversion (Hotel),
// an undated pair (India), a confidential note (Kilo) and a claim whose quote does not match its note (Lima).
// No test calls a real model.
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createResolver, parseNote } from '../linkparse.js';
import { buildPlan, checkFirst, effects } from '../batchPlan.js';
import { findingItem, itemLine } from '../reviewItems.js';
import { authorityOf, indexNote, modalityOf, noteDate } from '../contradictionIndex.js';
import { WHOLE_NOTE, checkClaims, checkClaimsBatch, claimPrompt, excerptOf, quoteMatches, structuredClaims } from '../contradictionClaims.js';
import { JUDGE_SYSTEM, judgePrompt } from '../contradictionResolve.js';
import { MAX_PAIRS_PER_GROUP, acronymOf, attributeKey, normKey, pairClaims, resolveSubject, sameValue, subjectIndex } from '../contradictionPairs.js';
import { JUDGE_BATCH, JUDGE_BATCH_SYSTEM, annotateLine, autoCriteria, checkJudge, checkJudgeBatch, judgeBatchPrompt, resolvePair, ruleBar, unannotateLine, wilson } from '../contradictionResolve.js';
import { BATCH_CHARS, BATCH_NOTES, createContradictionAgent, judgeBatches, judgeRank, packBatches } from '../contradictionAgent.js';
import { analyze, run } from '../rules/contradictions.js';
import { gateItem } from '../qualityGate.js';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/contradictions');
const CLAIMS = JSON.parse(readFileSync(path.join(DIR, 'claims.json'), 'utf8'));
const JUDGE = JSON.parse(readFileSync(path.join(DIR, 'judge.json'), 'utf8'));
const EXPECTED = JSON.parse(readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

const walk = (dir, base = '') => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f), `${base}${f}/`) : [`${base}${f}`]));
const note = (rel, text) => ({ rel, text, note: parseNote(rel, text), mtime: 0, size: text.length, inbound: 0, outbound: 0 });
function vault() {
  const root = path.join(DIR, 'vault');
  const notes = walk(root).filter((r) => r.endsWith('.md')).sort().map((rel) => note(rel, readFileSync(path.join(root, rel), 'utf8')));
  const byRel = new Map(notes.map((n) => [n.rel, n]));
  const resolve = createResolver(notes.map((n) => n.rel), (rel) => byRel.get(rel)?.note.aliases ?? []);
  return { notes, byRel, resolve };
}

// the fake model: an extraction prompt gets the claims.json entries of its note, each with the line its quote sits on;
// a judge prompt gets the label from judge.json and a quote from each excerpt
const sent = [];
async function fakeModel(prompt) {
  sent.push(prompt);
  // a judge prompt holds one or more pairs, each with its id
  if (prompt.includes('<pair id="')) {
    const verdicts = prompt.split('<pair id="').slice(1).map((block) => {
      const [, ra, la, qa, rb, lb, qb] = block.match(/Claim A in (\S+) \(line (\d+)\): "(.*)"\nClaim B in (\S+) \(line (\d+)\): "(.*)"/);
      const label = JUDGE[[ra, rb].sort().join('|')] ?? 'same';
      return { pair: block.slice(0, block.indexOf('"')), label, quotes: [{ path: ra, line: +la, text: qa }, { path: rb, line: +lb, text: qb }], reason: 'test' };
    });
    return JSON.stringify({ verdicts });
  }
  const claims = [];
  for (const block of prompt.split('<note path="').slice(1)) {
    const rel = block.slice(0, block.indexOf('"'));
    const lines = block.split('\n').slice(1);
    for (const c of CLAIMS[rel] ?? []) {
      const hit = lines.find((l) => l.includes(c.quote));
      const line = hit ? Number(hit.split(':')[0]) : 1;
      claims.push({ path: rel, ...c, line, line_end: line });
    }
  }
  return `Here are the claims.\n${JSON.stringify({ claims })}`;
}

const confidentialText = (text) => /^confidential:\s*(?!false|none|no\b)\S/m.test(text);
function agent(extra = {}) {
  return createContradictionAgent({ file: path.join(mkdtempSync(path.join(tmpdir(), 'contra-')), 'state.json'), model: fakeModel, enabled: () => true, cap: () => 1000, readable: (rel, text) => !confidentialText(text), ...extra });
}
// sweeps and ticks until the agent has nothing left to do, as the app does over many minutes
async function settle(ctx, a) {
  for (let round = 0; round < 6; round++) {
    run(ctx);
    let n = 0;
    while (!(await a.tick()).skipped) n++;
    if (!n) break;
  }
  return run(ctx);
}
const BAR_OK = { ok: true };
const pairName = (f) => `${f.notes[0]}|${f.notes[1]}`;

describe('stage 1 index', () => {
  it('reads authority, dates, decisions and superseded markers', () => {
    expect(authorityOf('decisions/x.md')).toBe(1);
    expect(authorityOf('a/x.md', { type: 'decision' })).toBe(1);
    expect(authorityOf('projects/x.md')).toBe(2);
    expect(authorityOf('meetings/x.md')).toBe(3);
    expect(authorityOf('memory/sessions/x.md')).toBe(4);
    expect(authorityOf('00-inbox/x.md')).toBe(5);
    expect(noteDate('a/2026-03-04-x.md', {})).toEqual({ date: '2026-03-04', source: 'name' });
    expect(noteDate('a/x.md', { date: '2026-02-30' })).toEqual({ date: null, source: null });
    expect(modalityOf('We decided to use SQLite')).toBe('decided');
    expect(modalityOf('We decided against SQLite')).toBe('rejected');
    expect(modalityOf('We might use SQLite')).toBe('proposed');
    const ix = indexNote(note('projects/golf2.md', '---\nstatus: superseded\nsuperseded_by: "[[golf-v2]]"\n---\n# Golf\n\nWe decided on REST on 2026-01-02.\nThis replaces [[golf-v0]].\n'));
    expect(ix.superseded).toBe(true);
    expect(ix.supersededBy).toEqual(['golf-v2']);
    expect(ix.decisions.map((d) => d.line)).toEqual([7]);
    expect(ix.dates).toEqual([{ line: 7, date: '2026-01-02' }]);
    expect(ix.replaces).toEqual(['golf-v0']);
    expect(ix.worth).toBe(true);
    expect(indexNote(note('notes/plain.md', '# Plain\n\nOk.\n')).worth).toBe(false);
    // a sentence with no decision phrase, date, status or marker stays out; a frontmatter date brings it in
    expect(indexNote(note('notes/plain2.md', '# Plain\n\nThe team likes tea in the morning.\n')).worth).toBe(false);
    expect(indexNote(note('notes/plain3.md', '---\ndate: 2026-01-01\n---\nThe team likes tea in the morning.\n')).worth).toBe(true);
  });
});

describe('stage 2 claims', () => {
  // a long note: filler around one decision line, one dated line and a frontmatter status
  const filler = (from, n) => Array.from({ length: n }, (_, i) => `Filler line ${from + i} about the weather and nothing else at all.`);
  const longNote = () => {
    const body = ['---', 'status: active', 'type: project', '---', '# Orion', '', ...filler(7, 40), 'We decided Orion will ship on Fridays.', ...filler(48, 40), 'On 2026-04-01 the Orion launch moved.', ...filler(89, 40)];
    return note('projects/orion.md', body.join('\n'));
  };

  it('sends a long note as the lines stage 1 found, with their numbers in the note and one line on either side', () => {
    const n = longNote();
    expect(n.text.length).toBeGreaterThan(WHOLE_NOTE);
    const ex = excerptOf(n);
    const rows = ex.split('\n');
    expect(rows).toContain('2: status: active');
    expect(rows).toContain('5: # Orion');
    expect(rows).toContain('47: We decided Orion will ship on Fridays.');
    expect(rows).toContain('46: Filler line 46 about the weather and nothing else at all.');
    expect(rows).toContain('48: Filler line 48 about the weather and nothing else at all.');
    expect(rows).not.toContain('45: Filler line 45 about the weather and nothing else at all.');
    expect(rows).toContain('88: On 2026-04-01 the Orion launch moved.');
    expect(rows).toContain('...');
    expect(ex.length).toBeLessThan(n.text.length / 5);
    // a quote from the excerpt is checked against the note's own line
    const r = checkClaims(n, JSON.stringify({ claims: [{ subject: 'Orion', attribute: 'release day', value: 'Fridays', quote: 'We decided Orion will ship on Fridays.', line: 47 }] }), 'haiku');
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]).toMatchObject({ line: 47, extractor: 'model:haiku' });
    // a line number the excerpt does not hold fails the check as before
    expect(checkClaims(n, JSON.stringify({ claims: [{ subject: 'Orion', attribute: 'release day', value: 'Fridays', quote: 'We decided Orion will ship on Fridays.', line: 30 }] })).claims).toHaveLength(0);
  });

  it('sends a short note whole, and a long note with no marker by its first lines', () => {
    const short = note('projects/a.md', '# A\n\nA runs on SQLite.\n');
    expect(excerptOf(short)).toBe('1: # A\n3: A runs on SQLite.');
    const plain = note('notes/plain.md', ['# Plain', '', ...filler(3, 80)].join('\n'));
    const rows = excerptOf(plain).split('\n');
    expect(rows[0]).toBe('1: # Plain');
    expect(rows.length).toBeLessThan(20);
  });

  it('keeps the instructions in the system prompt, so every call starts with the same text', () => {
    const a = claimPrompt([note('projects/a.md', '# A\n\nA runs on SQLite.\n')]);
    const b = claimPrompt([note('projects/b.md', '# B\n\nB runs on Postgres.\n'), note('projects/c.md', '# C\n\nC.\n')]);
    expect(a.system).toBe(b.system);
    expect(a.prompt.startsWith('<note path="projects/a.md"')).toBe(true);
    const pair = { a: { rel: 'a.md', line: 3, lineEnd: 3, quote: 'Atlas uses X.', date: null }, b: { rel: 'b.md', line: 3, lineEnd: 3, quote: 'Atlas uses Y.', date: null } };
    const j = judgePrompt(pair, [{ rel: 'a.md', text: '# A\n\nAtlas uses X.\n' }, { rel: 'b.md', text: '# B\n\nAtlas uses Y.\n' }]);
    expect(j.system).toBe(JUDGE_SYSTEM);
    expect(j.prompt.startsWith('Claim A in a.md (line 3)')).toBe(true);
  });

  it('reads frontmatter keys and key: value lines with no model', () => {
    const c = structuredClaims(note('decisions/2026-05-01-x.md', '---\ntype: decision\nowner: Ops\n---\n# X\n\n- [[juliet]] status: paused\n- **Region:** eu-west-1 since 2026-05-03\n- https: example\n\n```\nkey: value\n```\n'));
    expect(c.map((x) => [x.extractor, x.subject, x.attribute, x.value, x.line, x.modality])).toEqual([
      ['frontmatter', null, 'owner', 'Ops', 3, 'decided'],
      ['regex', 'juliet', 'status', 'paused', 7, 'decided'],
      ['regex', null, 'Region', 'eu-west-1 since 2026-05-03', 8, 'decided'],
    ]);
    expect(c[2]).toMatchObject({ date: '2026-05-03', dateSource: 'text' });
    expect(c[1]).toMatchObject({ date: '2026-05-01', dateSource: 'name', subjectLink: true });
  });

  it('reads several notes in one call and checks each claim against the note its path names', () => {
    const a = note('projects/a.md', '# A\n\nA runs on SQLite.\n');
    const b = note('projects/b.md', '# B\n\nB runs on Postgres.\n');
    const p = claimPrompt([a, b]).prompt;
    expect(p).toContain('<note path="projects/a.md" title="A">\n1: # A');
    expect(p).toContain('<note path="projects/b.md" title="B">\n1: # B');
    const reply = JSON.stringify({ claims: [
      { path: 'projects/a.md', subject: 'A', attribute: 'database', value: 'SQLite', quote: 'A runs on SQLite.', line: 3 },
      { path: 'projects/b.md', subject: 'B', attribute: 'database', value: 'Postgres', quote: 'B runs on Postgres.', line: 3 },
      { path: 'projects/b.md', subject: 'A', attribute: 'database', value: 'SQLite', quote: 'A runs on SQLite.', line: 3 },
      { path: 'projects/c.md', subject: 'C', attribute: 'database', value: 'x', quote: 'C runs on x here.', line: 1 },
    ] });
    const r = checkClaimsBatch([a, b], reply, 'sonnet');
    expect(r.byRel.get('projects/a.md').claims.map((c) => c.value)).toEqual(['SQLite']);
    expect(r.byRel.get('projects/b.md')).toMatchObject({ dropped: 1 });
    expect(r.byRel.get('projects/b.md').claims.map((c) => c.value)).toEqual(['Postgres']);
    expect(r.stray).toBe(1);
    expect(checkClaimsBatch([a, b], 'nothing').why).toMatch(/did not answer/);
  });

  it('packs notes into calls by priority up to the budget', () => {
    // chars: the length of each note's excerpt
    const e = (rel, rank, chars) => ({ rel, rank, text: 'x', chars });
    const batches = packBatches([e('c', 3, 10000), e('a', 1, 10000), e('b', 2, 10000), e('d', 4, 10000), e('e', 5, 100)]);
    expect(batches.map((b) => b.map((x) => x.rel))).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    // a note over the budget still gets its own call
    expect(packBatches([e('big', 1, 90000)]).length).toBe(1);
    expect(packBatches(Array.from({ length: BATCH_NOTES * 2 + 5 }, (_, i) => e(`n${i}`, 1, 10))).length).toBe(3);
    expect(BATCH_CHARS).toBeLessThanOrEqual(48000);
  });

  it('keeps model claims whose quotes match their lines and drops the rest', () => {
    const n = note('projects/m.md', '# M\n\nM runs on SQLite since 2026-02-01.\nM costs $5.\n');
    const reply = JSON.stringify({ claims: [
      { subject: 'M', attribute: 'database', value: 'SQLite', quote: 'M runs on SQLite since 2026-02-01.', line: 3, date: '2026-02-01', modality: 'stated' },
      { subject: 'M', attribute: 'cost', value: '$6', quote: 'M costs $6.', line: 4 },
      { subject: 'M', attribute: 'cost', value: '$5', quote: 'M costs $5.', line: 3 },
      { subject: 'M', attribute: 'engine', value: 'SQLite', quote: 'M runs on SQLite', line: 3, date: '2026-09-09' },
      { subject: '', attribute: 'a', value: 'b', quote: 'M runs on SQLite', line: 3 },
      // a real quote with a value the line does not hold, as text in another note could ask for
      { subject: 'M', attribute: 'status', value: 'cancelled', quote: 'M runs on SQLite', line: 3 },
      { subject: 'M', attribute: 'cost', value: '$9', quote: 'M costs $5.', line: 4 },
    ] });
    const { claims, dropped } = checkClaims(n, reply, 'sonnet');
    expect(dropped).toBe(5);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ date: '2026-02-01', dateSource: 'text', extractor: 'model:sonnet', line: 3 });
    // a date the quoted lines do not hold is not taken
    expect(claims[1]).toMatchObject({ date: null, dateSource: null });
    expect(checkClaims(n, 'no json').why).toMatch(/did not answer/);
    expect(quoteMatches(n.text, 3, 3, 'SQLite')).toBe(false);
    expect(claimPrompt(n).prompt).toContain('3: M runs on SQLite since 2026-02-01.');
  });
});

describe('stage 3 pairing', () => {
  it('maps subjects through titles, aliases, links, acronyms and similarity', () => {
    const sx = subjectIndex([{ rel: 'products/nimbus-cloud-edition.md', title: 'Nimbus Cloud Edition', aliases: ['Nimbus Hosted'] }, { rel: 'projects/beacon.md', title: 'Beacon', aliases: [] }]);
    const at = (subject, extra = {}) => resolveSubject({ rel: 'x.md', subject, ...extra }, sx, (t) => (t === 'beacon' ? 'projects/beacon.md' : null));
    expect(at('Nimbus Cloud Edition')).toEqual({ id: 'products/nimbus-cloud-edition.md', how: 'alias' });
    expect(at('nimbus hosted')).toEqual({ id: 'products/nimbus-cloud-edition.md', how: 'alias' });
    expect(at('NCE')).toEqual({ id: 'products/nimbus-cloud-edition.md', how: 'acronym' });
    expect(at('Nimbus Cloud Editions')).toEqual({ id: 'products/nimbus-cloud-edition.md', how: 'alias' });
    expect(at('Nimbus Clowd Edition')).toEqual({ id: 'products/nimbus-cloud-edition.md', how: 'fuzzy' });
    expect(at('beacon', { subjectLink: true })).toEqual({ id: 'projects/beacon.md', how: 'exact' });
    expect(at('Zephyr')).toEqual({ id: 'text:zephyr', how: 'exact' });
    expect(normKey('[[The Atlas Plans]]')).toBe('atla plan');
    expect(acronymOf('nimbus cloud edition')).toBe('nce');
    expect(attributeKey('Pricing')).toEqual({ id: 'price', how: 'alias' });
    expect(sameValue('the platform team', 'platform team')).toBe(true);
    expect(sameValue('$49 per seat', '$25 per seat')).toBe(false);
  });

  it('pairs claims across notes with the same subject and attribute and a different value', () => {
    const base = { extractor: 'regex', polarity: '+', modality: 'stated', authority: 2, scope: null, self: false };
    const claims = [
      { ...base, rel: 'a.md', quote: 'a1', subject: 'Atlas', attribute: 'price', value: '$49' },
      { ...base, rel: 'b.md', quote: 'b1', subject: 'atlas', attribute: 'pricing', value: '$25' },
      { ...base, rel: 'c.md', quote: 'c1', subject: 'Atlas', attribute: 'cost', value: '$49' },
      { ...base, rel: 'a.md', quote: 'a2', subject: 'Atlas', attribute: 'price', value: '$30' },
    ];
    const { pairs } = pairClaims(claims, subjectIndex([]));
    expect(pairs.map((p) => [p.a.quote, p.b.quote].sort().join('-')).sort()).toEqual(['a1-b1', 'a2-b1', 'a2-c1', 'b1-c1']);
    expect(pairs.every((p) => p.attribute === 'price')).toBe(true);
  });

  it('bounds the work in a group many notes share and pairs the newest claim first', () => {
    const base = { extractor: 'regex', polarity: '+', modality: 'stated', authority: 2, scope: null, self: false, line: 1 };
    const claims = Array.from({ length: 3000 }, (_, i) => ({ ...base, rel: `n${i}.md`, quote: `q${i}`, subject: 'Atlas', attribute: 'price', value: `$${i}`, date: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}` }));
    claims.push({ ...base, rel: 'newest.md', quote: 'qn', subject: 'Atlas', attribute: 'price', value: '$9999', date: '2026-06-01' });
    const t = performance.now();
    const { pairs } = pairClaims(claims, subjectIndex([]));
    expect(performance.now() - t).toBeLessThan(2000);
    expect(pairs.length).toBe(MAX_PAIRS_PER_GROUP);
    expect(pairs.every((p) => p.a.rel === 'newest.md' || p.b.rel === 'newest.md')).toBe(true);
  });
});

describe('stage 4 resolve and stage 5 fixes', () => {
  const ix = () => ({ links: [], supersededLines: [], replaces: [], superseded: false, supersededBy: [] });
  const claim = (over) => ({ rel: 'a.md', line: 3, lineEnd: 3, quote: 'Atlas uses X.', subject: 'Atlas', attribute: 'tool', value: 'X', polarity: '+', modality: 'stated', date: '2026-01-01', dateSource: 'frontmatter', scope: null, authority: 2, extractor: 'regex', inFrontmatter: false, ...over });
  const lineOf = () => 'Atlas uses X.';
  it('applies the rules in order', () => {
    const p = (a, b, extra = {}) => ({ key: 'k', a: claim(a), b: claim({ rel: 'b.md', value: 'Y', quote: 'Atlas uses Y.', ...b }), subject: 'atlas', attribute: 'tool', match: 'alias', ...extra });
    expect(resolvePair(p({ quote: 'Atlas uses X (superseded by [[b]]).' }, {}), { ix, lineOf }).rule).toBe('R1');
    expect(resolvePair(p({ scope: 'staging' }, { scope: 'production' }), { ix, lineOf }).rule).toBe('R4');
    expect(resolvePair(p({ extractor: 'model:x' }, {}), { ix, lineOf }).pending).toBe('judge');
    expect(resolvePair(p({ extractor: 'model:x' }, {}), { ix, lineOf, judge: 'same' }).closed).toBe(true);
    expect(resolvePair(p({}, {}, { refinement: true }), { ix, lineOf }).rule).toBe('R5');
    expect(resolvePair(p({ date: null, dateSource: null }, {}), { ix, lineOf }).rule).toBe('R7');
    expect(resolvePair(p({}, {}), { ix, lineOf }).rule).toBe('R7');
    expect(resolvePair(p({}, { date: '2026-03-01', authority: 5 }), { ix, lineOf }).rule).toBe('R6');
    expect(resolvePair(p({}, { date: '2026-03-01', modality: 'proposed' }), { ix, lineOf }).rule).toBe('R6');
    const r2 = resolvePair(p({}, { date: '2026-03-01', modality: 'decided' }), { ix, lineOf });
    expect(r2).toMatchObject({ rule: 'R2', fix: { kind: 'annotate', line: 3, text: 'Atlas uses X.', add: ' (superseded by [[b]] on 2026-03-01)' } });
    const r3 = resolvePair(p({ date: '2026-04-01' }, { date: '2026-03-01' }), { ix, lineOf });
    expect(r3).toMatchObject({ rule: 'R3', older: { rel: 'b.md' }, fix: { add: ' (as of 2026-03-01)' } });
    expect(resolvePair(p({ inFrontmatter: true }, { date: '2026-03-01', modality: 'decided' }), { ix, lineOf }).fix).toBeNull();
  });

  it('adds text to one line, refuses a changed line, and takes the text back off', () => {
    const fix = { line: 2, text: 'Atlas uses X.', add: ' (as of 2026-01-01)' };
    const out = annotateLine('# A\r\nAtlas uses X.\r\nEnd\r\n', fix);
    expect(out).toBe('# A\r\nAtlas uses X. (as of 2026-01-01)\r\nEnd\r\n');
    expect(unannotateLine(out, fix)).toBe('# A\r\nAtlas uses X.\r\nEnd\r\n');
    expect(() => annotateLine('# A\nAtlas uses Z.\n', fix)).toThrow(/changed/);
    // a Markdown line break stays after the added text, and the other lines keep their own endings
    const mixed = '# A\nAtlas uses X.  \r\nEnd\n';
    const hard = { ...fix, text: 'Atlas uses X.  ' };
    expect(annotateLine(mixed, hard)).toBe('# A\nAtlas uses X. (as of 2026-01-01)  \r\nEnd\n');
    expect(unannotateLine(annotateLine(mixed, hard), hard)).toBe(mixed);
  });

  it('checks the judge reply: a label and a matching quote from each note', () => {
    const p = { a: claim({}), b: claim({ rel: 'b.md' }) };
    const notes = [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'b.md', text: '#\n\nAtlas uses Y.\n' }];
    const reply = (label, qb = 'Atlas uses Y.') => JSON.stringify({ label, quotes: [{ path: 'a.md', line: 3, text: 'Atlas uses X.' }, { path: 'b.md', line: 3, text: qb }] });
    expect(checkJudge(p, notes, reply('contradiction')).label).toBe('contradiction');
    expect(checkJudge(p, notes, reply('maybe')).why).toMatch(/label/);
    expect(checkJudge(p, notes, reply('contradiction', 'Atlas uses Z.')).why).toMatch(/quote/);
  });

  it('judges several pairs in one call and keeps only the verdicts whose quotes check', () => {
    const p1 = { key: 'k1', a: claim({}), b: claim({ rel: 'b.md' }) };
    const p2 = { key: 'k2', a: claim({}), b: claim({ rel: 'c.md' }) };
    const notes1 = [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'b.md', text: '#\n\nAtlas uses Y.\n' }];
    const notes2 = [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'c.md', text: '#\n\nAtlas uses Z.\n' }];
    const items = [{ id: 'p1', p: p1, notes: notes1 }, { id: 'p2', p: p2, notes: notes2 }];
    const ask = judgeBatchPrompt(items);
    expect(ask.system).toBe(JUDGE_BATCH_SYSTEM);
    expect(ask.prompt.split('<pair id="')).toHaveLength(3);
    const v = (pair, path, text) => ({ pair, label: 'contradiction', quotes: [{ path: 'a.md', line: 3, text: 'Atlas uses X.' }, { path, line: 3, text }], reason: 'r' });
    const r = checkJudgeBatch(items, JSON.stringify({ verdicts: [v('p1', 'b.md', 'Atlas uses Y.'), v('p2', 'c.md', 'Atlas uses Q.')] }));
    expect(r.byId.get('p1').label).toBe('contradiction');
    expect(r.byId.get('p2').why).toMatch(/quote/);
    expect(checkJudgeBatch(items, JSON.stringify({ verdicts: [v('p1', 'b.md', 'Atlas uses Y.')] })).byId.get('p2').why).toMatch(/no verdict/);
    expect(checkJudgeBatch(items, 'no json').why).toMatch(/verdicts/);
  });

  it('packs pairs into judge calls, strongest first: decision records, different dates, decided claims', () => {
    const pair = (key, a, b) => ({ p: { key, a: claim({ ...a }), b: claim({ rel: 'b.md', ...b }) }, notes: [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'b.md', text: '#\n\nAtlas uses Y.\n' }] });
    const weak = pair('weak', { authority: 3, date: null, modality: 'stated' }, { authority: 3, date: null, modality: 'stated' });
    const dated = pair('dated', { authority: 3, date: '2026-01-01', modality: 'stated' }, { authority: 3, date: '2026-03-01', modality: 'stated' });
    const record = pair('record', { authority: 1, date: '2026-01-01', modality: 'decided' }, { authority: 2, date: '2026-03-01', modality: 'stated' });
    expect(judgeRank(record.p)).toBeLessThan(judgeRank(dated.p));
    expect(judgeRank(dated.p)).toBeLessThan(judgeRank(weak.p));
    const many = Array.from({ length: JUDGE_BATCH + 3 }, (_, i) => pair(`w${i}`, { authority: 3 }, { authority: 3 }));
    const batches = judgeBatches([weak, ...many, dated, record]);
    expect(batches[0].slice(0, 2).map((x) => x.p.key)).toEqual(['record', 'dated']);
    expect(batches[0]).toHaveLength(JUDGE_BATCH);
    expect(batches.flat()).toHaveLength(many.length + 3);
  });

  it('stores the verdicts a batched reply settles and holds back only the pairs it did not', async () => {
    const notes1 = [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'b.md', text: '#\n\nAtlas uses Y.\n' }];
    const notes2 = [{ rel: 'a.md', text: '#\n\nAtlas uses X.\n' }, { rel: 'c.md', text: '#\n\nAtlas uses Z.\n' }];
    const p1 = { key: 'k1', a: claim({}), b: claim({ rel: 'b.md' }) };
    const p2 = { key: 'k2', a: claim({}), b: claim({ rel: 'c.md' }) };
    const seen = [];
    const a = agent({ model: async (prompt) => {
      seen.push(prompt.split('<pair id="').length - 1);
      const id = prompt.includes('b.md (line') && prompt.indexOf('b.md (line') < prompt.indexOf('c.md (line') ? 'p1' : 'p2';
      return JSON.stringify({ verdicts: [{ pair: id, label: 'contradiction', quotes: [{ path: 'a.md', line: 3, text: 'Atlas uses X.' }, { path: 'b.md', line: 3, text: 'Atlas uses Y.' }], reason: 'r' }] });
    } });
    a.provider.begin();
    expect(a.provider.judgeOf(p1, notes1)).toBeNull();
    expect(a.provider.judgeOf(p2, notes2)).toBeNull();
    const res = await a.tick({ uncapped: true });
    expect(seen).toEqual([2]);
    expect(res).toMatchObject({ judged: ['k1'], judgeDropped: ['k2'] });
    a.provider.begin();
    expect(a.provider.judgeOf(p1, notes1)).toBe('contradiction');
    // the pair the reply did not settle waits a day, as a failed call does
    expect(a.provider.judgeOf(p2, notes2)).toBeNull();
    expect(a.pendingCalls()).toBe(0);
  });

  it('measures the bar from the decision log over the auto slice', () => {
    expect(wilson(150, 150)).toBeGreaterThan(0.97);
    expect(wilson(147, 150)).toBeLessThan(0.95);
    const rec = (i, decision, slice = true) => ({ ruleId: 'note.contradiction', key: `k${i}`, decision, at: i, evidence: { facts: slice ? ['auto-slice'] : [] } });
    expect(ruleBar(Array.from({ length: 160 }, (_, i) => rec(i, 'approved'))).ok).toBe(true);
    expect(ruleBar(Array.from({ length: 149 }, (_, i) => rec(i, 'approved'))).ok).toBe(false);
    expect(ruleBar([...Array.from({ length: 160 }, (_, i) => rec(i, 'auto')), rec(161, 'undone'), rec(162, 'undone')]).ok).toBe(false);
    expect(ruleBar(Array.from({ length: 160 }, (_, i) => rec(i, 'approved', false))).n).toBe(0);
  });

  it('auto-approves only when every criterion holds', () => {
    const older = claim({});
    const newer = claim({ rel: 'decisions/b.md', date: '2026-03-01', modality: 'decided', authority: 1, quote: 'Atlas uses Y.' });
    const p = { a: older, b: newer, subject: 'projects/atlas.md', attribute: 'tool', match: 'alias' };
    const res = resolvePair(p, { ix, lineOf });
    const ctx = { textOf: (rel) => (rel === 'a.md' ? '#\n\nAtlas uses X.\n' : '#\n\nAtlas uses Y.\n'), confidential: () => false, person: () => false, bar: BAR_OK };
    const failing = (over = {}, pp = p) => autoCriteria(pp, res, { ...ctx, ...over }).filter((c) => !c.ok).map((c) => c.id);
    expect(failing()).toEqual([]);
    expect(failing({ bar: { ok: false } })).toEqual(['bar']);
    expect(failing({ confidential: (rel) => rel === 'a.md' })).toEqual(['not-sensitive']);
    expect(failing({ person: () => true })).toEqual(['not-sensitive']);
    expect(failing({ textOf: () => 'changed' })).toEqual(['verbatim']);
    expect(failing({}, { ...p, match: 'fuzzy' })).toEqual(['match']);
    expect(failing({}, { ...p, a: { ...older, value: '$5 a seat' } })).toEqual(['not-sensitive']);
    // a project note the model calls decided, with no decision phrase on its line, is no decision
    const said = claim({ rel: 'projects/b.md', value: 'Y', date: '2026-03-01', modality: 'decided', quote: 'Atlas uses Y.', extractor: 'model:sonnet' });
    const p2 = { ...p, b: said };
    const res2 = resolvePair(p2, { ix, lineOf, judge: 'contradiction' });
    expect(res2.rule).toBe('R2');
    const ids = (text) => autoCriteria(p2, res2, { ...ctx, textOf: (rel) => (rel === 'a.md' ? '#\n\nAtlas uses X.\n' : text) }).filter((c) => !c.ok).map((c) => c.id);
    expect(ids('#\n\nAtlas uses Y.\n')).toEqual(['decision']);
    expect(ids('#\n\nWe decided Atlas uses Y.\n')).toEqual([]);
  });
});

describe('the pipeline on the synthetic vault', () => {
  it('finds what expected.json lists, and nothing else', async () => {
    const { notes, resolve } = vault();
    sent.length = 0;
    const a = agent();
    const ctx = { notes, resolve, tags: [], folders: {}, contradictions: { provider: a.provider, bar: BAR_OK } };
    const found = await settle(ctx, a);
    const got = Object.fromEntries(found.map((f) => [pairName(f), { rule: f.facts[0].slice(5), auto: f.autoFix }]));
    expect(Object.keys(got).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [k, v] of Object.entries(EXPECTED)) expect(got[k], k).toEqual({ rule: v.rule, auto: v.auto });
    // the confidential note never reached the model, and the notes went in calls of at most BATCH_NOTES
    expect(sent.some((s) => s.includes('projects/kilo.md'))).toBe(false);
    const calls = sent.filter((s) => s.includes('<note path='));
    const read = calls.reduce((n, s) => n + s.split('<note path=').length - 1, 0);
    expect(calls.length).toBe(Math.ceil(read / BATCH_NOTES));
    // projects/india.md has no date, decision or status; it is read because it links to a note that is
    expect(sent.some((s) => s.includes('<note path="projects/india.md" '))).toBe(true);
    expect(sent.some((s) => s.includes('<note path="products/nimbus-cloud-edition.md" '))).toBe(true);
    // both quotes show on the item
    const beacon = found.find((f) => f.notes[0] === 'projects/beacon.md');
    expect(beacon.evidence[0]).toBe('Older: projects/beacon.md line 7 (2026-02-01): “Beacon stores its data in Postgres.”');
    expect(beacon.evidence[1]).toContain('We decided Beacon will store its data in SQLite.');
    expect(beacon.fix).toEqual({ kind: 'annotate', line: 7, text: 'Beacon stores its data in Postgres.', add: ' (superseded by [[decisions/2026-04-10-beacon-database]] on 2026-04-10)' });
  });

  it('keeps everything in review until the rule meets the bar', async () => {
    const { notes, resolve } = vault();
    const a = agent();
    const found = await settle({ notes, resolve, tags: [], folders: {}, contradictions: { provider: a.provider, bar: { ok: false } } }, a);
    expect(found.length).toBe(Object.keys(EXPECTED).length);
    expect(found.some((f) => f.autoFix)).toBe(false);
    // a fix waits under Check these first; a pair Quorum cannot settle has no fix, and Approve keeps both notes
    const items = found.map(findingItem);
    expect(items.filter((i) => i.ops[0].op !== 'keep').every((i) => checkFirst(i))).toBe(true);
    expect(items.filter((i) => i.ops[0].op === 'keep').map((i) => i.notes[0]).sort()).toEqual(['decisions/2026-01-20-hotel-queue.md', 'projects/india.md']);
  });

  it('reads structured claims with no model when drafting is off', () => {
    const { notes, resolve } = vault();
    const found = run({ notes, resolve, tags: [], folders: {} });
    expect(found.map(pairName)).toEqual(['projects/juliet.md|decisions/2026-05-01-juliet-pause.md']);
    expect(found[0].autoFix).toBe(false);
    const stats = analyze({ notes, resolve });
    expect(stats.claims.every((c) => !c.extractor.startsWith('model'))).toBe(true);
  });

  it('stops at the daily cap, waits while the person types, and drops a claim whose quote fails', async () => {
    const { notes, resolve } = vault();
    let calls = 0;
    const capped = agent({ cap: () => 2, model: (...x) => { calls++; return fakeModel(...x); } });
    await settle({ notes, resolve, contradictions: { provider: capped.provider } }, capped);
    expect(calls).toBe(2);
    expect((await capped.tick()).skipped).toBe('cap');
    const typing = agent({ idleMs: () => 1000 });
    run({ notes, resolve, contradictions: { provider: typing.provider } });
    expect((await typing.tick()).skipped).toBe('typing');
    const a = agent();
    const ctx = { notes, resolve, contradictions: { provider: a.provider } };
    await settle(ctx, a);
    const lima = analyze(ctx).claims.filter((c) => c.rel === 'projects/lima.md');
    expect(lima).toEqual([]);
  });

  it('makes one model call per note and per pair while sweeps run during each call', async () => {
    const { notes, resolve } = vault();
    // each id the model is asked about, with how many times: a note path per claim batch, a pair key per judge call
    const asked = new Map();
    const count = (id) => asked.set(id, (asked.get(id) ?? 0) + 1);
    let release = null;
    const slow = async (prompt, system) => {
      // a judge call names each of its pairs by their two claim lines
      const pairs = prompt.split('<pair id="').slice(1);
      if (pairs.length) for (const b of pairs) count(`judge:${b.split('\n').slice(1, 3).join('|')}`);
      else for (const block of prompt.split('<note path="').slice(1)) count(`claims:${block.slice(0, block.indexOf('"'))}`);
      await new Promise((r) => { release = r; });
      return fakeModel(prompt, system);
    };
    const a = agent({ model: slow });
    const ctx = { notes, resolve, tags: [], folders: {}, contradictions: { provider: a.provider, bar: BAR_OK } };
    // a catch-up: the sweep after one call runs while the next call waits on the model, and the next tick takes what
    // that sweep queued. A sweep runs only when the queues are empty otherwise, as the pass reads the vault again
    run(ctx);
    let idle = 0;
    for (let round = 0; round < 60 && idle < 2; round++) {
      const pending = a.tick({ uncapped: true });
      await new Promise((r) => setTimeout(r, 0));
      run(ctx);
      release?.();
      release = null;
      if ((await pending).skipped) { idle++; run(ctx); } else idle = 0;
    }
    expect(asked.size).toBeGreaterThan(0);
    expect([...asked.keys()].some((k) => k.startsWith('judge:'))).toBe(true);
    expect([...asked].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('gives a cancelled call its place under the cap back and asks for the notes again', async () => {
    const { notes, resolve } = vault();
    let cancel = true;
    const starts = [];
    const a = agent({ cap: () => 1, model: (...x) => (cancel ? Promise.reject(Object.assign(new Error('Cancelled'), { cancelled: true })) : fakeModel(...x)) });
    const ctx = { notes, resolve, contradictions: { provider: a.provider } };
    run(ctx);
    expect(await a.tick({ onStart: (w) => starts.push(w) })).toMatchObject({ cancelled: expect.any(Array) });
    expect(starts).toEqual([{ kind: 'claims', notes: expect.any(Number) }]);
    expect(a.status().used).toBe(0);
    cancel = false;
    run(ctx);
    expect(await a.tick()).toMatchObject({ extracted: expect.any(Array) });
    expect(a.status().used).toBe(1);
    expect((await a.tick()).skipped).toBe('cap');
  });

  it('blocks a failed call for a day, then forgets it', async () => {
    const { notes, resolve } = vault();
    let t = Date.UTC(2026, 5, 1, 12);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'contra-')), 'state.json');
    const a = agent({ file, now: () => t, model: () => Promise.reject(new Error('boom')) });
    const ctx = { notes, resolve, contradictions: { provider: a.provider } };
    run(ctx);
    expect(await a.tick()).toMatchObject({ dropped: expect.any(Array) });
    const failed = () => Object.keys(JSON.parse(readFileSync(file, 'utf8')).failed).length;
    expect(failed()).toBeGreaterThan(0);
    run(ctx);
    expect(failed()).toBeGreaterThan(0);
    t += 25 * 3600000;
    run(ctx);
    expect(failed()).toBe(0);
  });

  it('routes items through the quality gate: every item shows under Check these first, with or without a fix', async () => {
    const { notes, resolve } = vault();
    const a = agent();
    const found = await settle({ notes, resolve, tags: [], folders: {}, contradictions: { provider: a.provider, bar: BAR_OK } }, a);
    const verdicts = found.map((f) => [f.facts[0], gateItem(findingItem(f)).bucket]);
    expect(new Set(verdicts.filter(([r]) => r === 'rule:R2' || r === 'rule:R3' || r === 'rule:R5').map(([, b]) => b))).toEqual(new Set(['check']));
    expect(new Set(verdicts.filter(([r]) => r === 'rule:R6' || r === 'rule:R7').map(([, b]) => b))).toEqual(new Set(['check']));
    expect(gateItem(findingItem(found.find((f) => f.facts[0] === 'rule:R7'))).reasons).toEqual(['low-precision']);
    // this vault's approvals lift the kind to shown
    expect(gateItem(findingItem(found.find((f) => f.facts[0] === 'rule:R2')), { tally: { approved: 30, auto: 0, archived: 0, undone: 0 } }).bucket).toBe('show');
  });

  it('plans the fix as one add-only line edit through the batch planner', () => {
    const { notes, resolve } = vault();
    const [f] = run({ notes, resolve, tags: [], folders: {}, contradictions: { bar: BAR_OK } });
    const item = { ...findingItem(f), hashes: {} };
    expect(item.ops).toEqual([{ op: 'annotate', rel: 'projects/juliet.md', line: 7, text: '- Status: active', add: ' (superseded by [[decisions/2026-05-01-juliet-pause]] on 2026-05-01)' }]);
    expect(itemLine(item)).toBe('Add “(superseded by [[decisions/2026-05-01-juliet-pause]] on 2026-05-01)” to line 7 of “projects/juliet.md”');
    expect(effects(item.ops[0]).writes).toEqual([{ rel: 'projects/juliet.md', region: 'line:7' }]);
    expect(checkFirst(item)).toBeNull();
    const plan = buildPlan([item]);
    expect(plan.ok).toEqual([item.id]);
    const text = notes.find((n) => n.rel === 'projects/juliet.md').text;
    expect(annotateLine(text, item.ops[0]).split('\n')[6]).toBe('- Status: active (superseded by [[decisions/2026-05-01-juliet-pause]] on 2026-05-01)');
  });
});
