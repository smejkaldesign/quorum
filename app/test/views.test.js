import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createViews, parseLine } from '../views.js';

let dir, note;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'quorum-views-')); note = path.join(dir, 'plan.md'); writeFileSync(note, '# Plan\n'); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('views', () => {
  it('starts at zero and counts people and agents separately', () => {
    const v = createViews(path.join(dir, 'views.jsonl'));
    expect(v.of(note)).toEqual({ total: 0, human: 0, agent: 0, tokens: 0, lastHumanAt: null, lastAgentAt: null, agents: [] });
    v.record({ file: note, who: 'human', via: 'quorum', bytes: 400 });
    v.record({ file: note, who: 'agent', via: 'claude-code', bytes: 4000 });
    v.record({ file: note, who: 'agent', via: 'claude-code', bytes: 4000 });
    v.record({ file: note, who: 'agent', via: 'codex', bytes: 800 });
    const r = v.of(note);
    expect([r.total, r.human, r.agent]).toEqual([4, 1, 3]);
    expect(r.tokens).toBe(2200);
    expect(r.agents).toEqual([{ via: 'claude-code', count: 2 }, { via: 'codex', count: 1 }]);
    expect(r.lastAgentAt).toBeTruthy();
  });
  it('picks up lines other processes append, and skips lines it cannot read', () => {
    const log = path.join(dir, 'shared.jsonl');
    const v = createViews(log);
    v.record({ file: note, who: 'human', via: 'quorum' });
    appendFileSync(log, `${JSON.stringify({ t: '2026-11-09T20:00:00Z', file: note, who: 'agent', via: 'cli', bytes: 40 })}\nnot json\n{"file":1}\n`);
    expect(v.of(note).total).toBe(2);
    expect(v.of(note).agents).toEqual([{ via: 'cli', count: 1 }]);
  });
  it('parses only lines that name a file and a reader', () => {
    expect(parseLine('{"file":"/a.md","who":"robot"}')).toBeNull();
    expect(parseLine('{"file":"/a.md","who":"agent"}')).toMatchObject({ via: 'agent', bytes: 0 });
  });
});
