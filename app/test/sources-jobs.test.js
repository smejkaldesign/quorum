import { describe, expect, it } from 'vitest';
import { createJobs } from '../sources/jobs.js';

describe('createJobs', () => {
  it('publishes progress and the finished state, one run per id at a time', async () => {
    const events = [];
    let t = 1000;
    const jobs = createJobs({ emit: (j) => events.push({ status: j.status, done: j.done, total: j.total }), now: () => (t += 1) });
    let release;
    const gate = new Promise((r) => { release = r; });
    const p1 = jobs.run('granola', 'Importing', async (progress) => { progress({ total: 2 }); await gate; progress({ done: 2 }); return { imported: 2 }; });
    const p2 = jobs.run('granola', 'Importing', async () => 'second');
    expect(p2).toBe(p1);
    expect(jobs.running('granola')).toBe(true);
    release();
    expect(await p1).toEqual({ imported: 2 });
    expect(jobs.snapshot('granola')).toMatchObject({ status: 'done', done: 2, total: 2, result: { imported: 2 } });
    expect(events.map((e) => e.status)).toEqual(['running', 'running', 'running', 'done']);
  });
  it('records a failure and lets the next run start', async () => {
    const jobs = createJobs();
    await expect(jobs.run('x', 'Sync', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(jobs.snapshot('x')).toMatchObject({ status: 'failed', error: 'offline' });
    expect(await jobs.run('x', 'Sync', async () => 'ok')).toBe('ok');
  });
});
