import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { agyArgs, agyText, codexArgs, codexText, parseAgyJson, parseCodexEvents, runnersStatus } from '../runners.js';

const fakeSpawn = (behave) => (bin, args, opts) => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.stdin = { end: (s) => { proc.input = s; } };
  proc.kill = () => {};
  proc.bin = bin; proc.args = args; proc.opts = opts;
  setTimeout(() => behave(proc), 0);
  return proc;
};

const CODEX_OUT = [
  '{"type":"thread.started","thread_id":"t1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"## Summary\\n\\nThe team agreed."}}',
  '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
].join('\n');

describe('parsers', () => {
  it('takes the last completed agent message from Codex and the response from Antigravity', () => {
    expect(parseCodexEvents(CODEX_OUT)).toBe('## Summary\n\nThe team agreed.');
    expect(parseCodexEvents('{"type":"turn.started"}')).toBeNull();
    expect(() => parseCodexEvents('{"type":"error","message":"not logged in"}')).toThrow('not logged in');
    expect(parseAgyJson('{"conversation_id":"c","status":"SUCCESS","response":"OK\\n","num_turns":1}')).toBe('OK');
    expect(() => parseAgyJson('{"status":"ERROR","error":"quota"}')).toThrow('quota');
    expect(() => parseAgyJson('nope')).toThrow(/no JSON/);
  });
});

describe('codexText', () => {
  it('runs codex exec read-only in a temp folder with the instructions and the prompt on stdin', async () => {
    let seen = null;
    const spawnImpl = fakeSpawn((proc) => { seen = proc; proc.stdout.emit('data', CODEX_OUT); proc.emit('close', 0); });
    const deltas = [];
    const text = await codexText({ prompt: 'Summarize this.', system: 'Be brief.', onDelta: (t) => deltas.push(t), spawnImpl });
    expect(text).toBe('## Summary\n\nThe team agreed.');
    expect(seen.bin).toBe('codex');
    expect(seen.args).toEqual(codexArgs());
    expect(seen.args).toContain('read-only');
    expect(seen.input).toContain('Instructions:\nBe brief.');
    expect(seen.input).toContain('Do not read files');
    expect(seen.input.endsWith('Summarize this.')).toBe(true);
    expect(seen.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(deltas).toEqual([text]);
  });
  it('turns a failure into the first stderr line', async () => {
    const spawnImpl = fakeSpawn((proc) => { proc.stderr.emit('data', 'codex: not logged in\nrun codex login'); proc.emit('close', 1); });
    await expect(codexText({ prompt: 'x', spawnImpl })).rejects.toThrow('codex: not logged in');
  });
});

describe('agyText', () => {
  it('passes the combined prompt as the argument and reads the json response', async () => {
    let seen = null;
    const spawnImpl = fakeSpawn((proc) => { seen = proc; proc.stdout.emit('data', '{"status":"SUCCESS","response":"Three decisions.\\n"}'); proc.emit('close', 0); });
    const text = await agyText({ prompt: 'List decisions.', system: 'Be literal.', spawnImpl });
    expect(text).toBe('Three decisions.');
    expect(seen.bin).toBe('agy');
    expect(seen.args).toEqual(agyArgs(seen.args[1]));
    expect(seen.args).toContain('--sandbox');
    expect(seen.opts.cwd).toBeTruthy();
    expect(seen.args[1]).toContain('Be literal.');
    expect(seen.args[1].endsWith('List decisions.')).toBe(true);
    expect(seen.input).toBeUndefined();
  });
  it('names a missing binary plainly', async () => {
    const spawnImpl = fakeSpawn((proc) => { const e = new Error('spawn agy ENOENT'); e.code = 'ENOENT'; proc.emit('error', e); });
    await expect(agyText({ prompt: 'x', spawnImpl })).rejects.toThrow('agy is not installed on this Mac.');
  });
});

describe('runnersStatus', () => {
  it('reports each runner from the PATH lookup and caches the answer for a minute', async () => {
    let calls = 0;
    const which = async (bin) => { calls += 1; return bin === 'codex' ? '0.120.0' : null; };
    const a = await runnersStatus({ which, now: 1_000_000 });
    expect(a).toEqual({ codex: { installed: true, version: '0.120.0' }, antigravity: { installed: false, version: null } });
    await runnersStatus({ which, now: 1_000_000 + 30000 });
    expect(calls).toBe(2);
    await runnersStatus({ which, now: 1_000_000 + 61000 });
    expect(calls).toBe(4);
  });
});
