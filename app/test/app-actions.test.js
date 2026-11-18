// The Memory health and Knowledge tools as the app runs them for an AI tool (appActions.js): each calls the handler the
// app's button calls, write tools are refused while Quorum is read only, approve, dismiss, undo and knowledge base
// writes need the AI setting, and the MCP client is the actor while a tool runs. The handlers are stubs here.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDecisionLog } from '../decisionLog.js';
import { READ_ONLY, gateOff, actorLabel, agentActor, createAppActions, currentActor, outsideActor } from '../appActions.js';
import { APP_TOOLS } from '../cli/appTools.mjs';

const row = (id, kind, extra = {}) => ({
  id, at: Date.parse('2026-11-10T10:00:00Z'), unread: true, review: { kind, key: id.split(':').pop() }, summary: { line: `Fix ${id}` },
  target: { abs: `/v/${id.split(':').pop()}.md`, rel: `notes/${id.split(':').pop()}.md`, title: id.split(':').pop() }, detail: { title: `Title ${id}`, problem: 'A broken link', recommend: 'Relink it' }, ...extra,
});
const ROWS = [row('r:link:alpha', 'link'), row('r:find:beta', 'finding'), row('r:ignore:gamma', 'ignore'), row('r:link:acme', 'link'), row('r:link:secret', 'link', { target: { abs: '/v/p/secret.md', rel: '02-personal/secret.md', title: 'secret' } })];

function setup({ settings = { memoryAgentActions: true }, handlers = {}, kbHosted = null, kbSync = null } = {}) {
  const calls = [];
  const toasts = [];
  const base = {
    'activity-feed': () => ({ items: ROWS }),
    'activity-review': (items) => ({ done: items.map((i) => i.abs), failed: [] }),
    'activity-mark': (rows) => rows.length,
    'fix-runs': () => [{ id: 'fix:alpha:1', key: 'alpha', target: 'alpha', status: 'queued', queuedAt: 1, batch: null, by: 'Claude Code' }],
    'fix-plan-apply': (ids) => ({ run: { id: 'batch:9', batch: 'batch:9', kind: 'batch', target: '1 memory fix', status: 'queued', queuedAt: 1, items: [{ id: ids[0] }] }, note: null }),
    'fix-cancel': () => 2,
    'fix-undo': () => 'Undid the fix. “alpha” is back in Needs review',
    'memory-catchup-start': () => ({ running: true, done: 0, total: 3 }),
    'memory-catchup-status': () => ({ running: false, last: null }),
    ...handlers,
  };
  const call = async (name, ...args) => { calls.push({ name, args, actor: currentActor() }); return base[name](...args); };
  const actions = createAppActions({
    call, settings: () => settings, kbHosted: () => kbHosted, kbSync: () => kbSync, toast: (t) => toasts.push(t),
    accounts: () => [{ id: 'slack', name: 'Slack', configured: true, connected: true, account: 'Acme Co', error: null }, { id: 'notion', name: 'Notion', configured: true, connected: false }],
    readTools: () => ['slack_search', 'slack_thread'],
    isExcluded: (t) => /acme/i.test(t), redact: (t) => t.replace(/Acme/g, '[withheld]'), withheld: (rel) => rel.startsWith('02-personal/'),
  });
  return { actions, calls, toasts };
}

describe('reading Needs review', () => {
  it('lists the items the person would see, leaving out withheld notes and opted-out customers', async () => {
    const { actions, calls } = setup({ settings: { access: 'read' } });
    const r = await actions.run('review_items', { limit: 10 }, 'claude-code');
    expect(calls[0]).toMatchObject({ name: 'activity-feed', args: [{ review: true, kinds: ['memory-health'], sort: 'recent', offset: 0, limit: 1e6 }] });
    expect(r.items.map((i) => i.id)).toEqual(['r:link:alpha', 'r:find:beta', 'r:ignore:gamma']);
    expect(r.items[0]).toEqual({ id: 'r:link:alpha', kind: 'link', title: 'Title r:link:alpha', note: 'notes/alpha.md', problem: 'A broken link', approve: 'Relink it', unread: true, at: '2026-11-10T10:00:00.000Z', fixing: false });
    expect((await actions.run('review_items', { kind: 'finding' })).items.map((i) => i.id)).toEqual(['r:find:beta']);
    await expect(actions.run('review_item', { id: 'r:link:secret' })).rejects.toThrow('Not in Needs review: r:link:secret');
  });
});

describe('the read-only setting and the AI setting', () => {
  it('refuses every write while Quorum is read only, and still reads', async () => {
    const { actions, calls } = setup({ settings: { access: 'read', memoryAgentActions: true } });
    for (const t of APP_TOOLS.filter((x) => x.write)) await expect(actions.run(t.name, { ids: ['r:link:alpha'], id: 'x', batch: 'b', name: 'n', kb: 'k', url: 'u' })).rejects.toThrow(READ_ONLY);
    expect(calls).toEqual([]);
    expect((await actions.run('fix_runs', {})).runs).toHaveLength(1);
  });
  it('refuses approve, dismiss, undo and knowledge base writes until the person turns the setting on, and allows mark read', async () => {
    const { actions, calls } = setup({ settings: {} });
    for (const name of ['review_approve', 'review_dismiss', 'fix_undo', 'kb_create', 'kb_attach_github']) await expect(actions.run(name, { ids: ['r:link:alpha'], id: 'fix:1', name: 'KB', kb: 'k', url: 'u' })).rejects.toThrow('AI tools cannot ');
    await expect(actions.run('kb_create', { name: 'KB' })).rejects.toThrow('AI tools cannot create knowledge bases yet. In Quorum, turn on Settings > Memory > Let AI tools change memory and knowledge bases, then try again.');
    expect(gateOff('undo memory fixes')).toContain('cannot undo memory fixes');
    expect(calls).toEqual([]);
    expect(await actions.run('review_mark_read', { ids: ['r:link:alpha'] })).toEqual({ marked: 1 });
    expect(calls.map((c) => c.name)).toEqual(['activity-feed', 'activity-mark']);
    expect(calls[1].args).toEqual([[{ id: 'r:link:alpha', abs: '/v/alpha.md' }], false]);
    expect(APP_TOOLS.filter((t) => t.gated).map((t) => t.name)).toEqual(['review_approve', 'review_dismiss', 'fix_undo', 'kb_create', 'kb_attach_github']);
  });
});

describe('approving through the buttons\' handlers', () => {
  it('approves one item the way its Approve button does, as the MCP client', async () => {
    const { actions, calls, toasts } = setup();
    const r = await actions.run('review_approve', { ids: ['r:link:alpha'] }, 'claude-code');
    const review = calls.find((c) => c.name === 'activity-review');
    expect(review.args).toEqual([[{ kind: 'link', abs: '/v/alpha.md', key: 'alpha' }], 'approve']);
    expect(review.actor).toBe('claude-code');
    expect(r.run).toMatchObject({ id: 'fix:alpha:1', status: 'queued', by: 'Claude Code' });
    expect(toasts).toEqual(['Claude Code approved “Title r:link:alpha”']);
  });
  it('approves several as one bulk batch with Cancel, and answers a proposed rule on its own', async () => {
    const { actions, calls } = setup();
    const r = await actions.run('review_approve', { ids: ['r:link:alpha', 'r:find:beta', 'r:ignore:gamma'] }, 'codex');
    const plan = calls.find((c) => c.name === 'fix-plan-apply');
    expect(plan.args).toEqual([['r:link:alpha', 'r:find:beta'], [], {}, []]);
    expect(plan.actor).toBe('codex');
    expect(calls.find((c) => c.name === 'activity-review').args).toEqual([[{ kind: 'ignore', abs: '/v/gamma.md', key: 'gamma' }], 'approve']);
    expect(r).toMatchObject({ approved: ['r:link:alpha', 'r:ignore:gamma'], left: ['r:find:beta'], run: { id: 'batch:9', batch: 'batch:9' } });
    expect(await actions.run('fix_cancel', { batch: 'batch:9' })).toEqual({ cancelled: 2 });
    expect(calls.at(-1)).toMatchObject({ name: 'fix-cancel', args: ['batch:9'] });
  });
  it('passes on the reason an item could not be approved', async () => {
    const { actions } = setup({ handlers: { 'activity-review': () => ({ done: [], failed: [{ abs: '/v/alpha.md', error: 'This fix needs a review on its own. Open it and approve it there' }] }) } });
    await expect(actions.run('review_approve', { ids: ['r:link:alpha'] })).rejects.toThrow('needs a review on its own');
  });
  it('dismisses and undoes through the same handlers', async () => {
    const { actions, calls, toasts } = setup();
    expect(await actions.run('review_dismiss', { ids: ['r:find:beta'] }, 'claude-code')).toEqual({ dismissed: 1, failed: [] });
    expect(calls.find((c) => c.name === 'activity-review').args[1]).toBe('dismiss');
    expect((await actions.run('fix_undo', { id: 'fix:alpha:1' }, 'claude-code')).message).toContain('back in Needs review');
    expect(calls.at(-1)).toMatchObject({ name: 'fix-undo', args: ['fix:alpha:1'], actor: 'claude-code' });
    expect(toasts.at(-1)).toBe('Claude Code: Undid the fix. “alpha” is back in Needs review');
    await actions.run('fix_cancel', { batch: 'b' }, '');
    await actions.run('memory_check_start', {}, 'cli');
    expect(toasts.slice(-2)).toEqual(['An AI tool cancelled a batch of memory fixes', 'The quorum command started Check everything now']);
  });
});

describe('who acted', () => {
  it('is the MCP client while a tool runs, and nobody once the work is handed to the fix queue', async () => {
    let inside = null, queued = null;
    const { actions } = setup({ handlers: { 'fix-cancel': () => { inside = currentActor(); queued = outsideActor(() => currentActor()); return 1; } } });
    await actions.run('fix_cancel', { batch: 'b' }, 'claude-code');
    expect([inside, queued, currentActor()]).toEqual(['claude-code', 'you', 'you']);
  });
  it('lands in the decision log as the client when a record takes the default actor', async () => {
    const log = createDecisionLog(mkdtempSync(path.join(tmpdir(), 'qact-')));
    const record = (decision, actor = currentActor()) => log.record('/v', { ruleId: 'link', ruleVersion: 1, key: 'alpha', target: 'alpha', decision, actor });
    const { actions } = setup({ handlers: { 'fix-cancel': () => { record('approved'); return 1; } } });
    await actions.run('fix_cancel', { batch: 'b' }, 'claude-code');
    record('undone');
    expect(log.list('/v').map((r) => [r.decision, r.actor])).toEqual([['approved', 'claude-code'], ['undone', 'you']]);
  });
  it('names clients the way the window shows them', () => {
    expect([actorLabel('claude-code'), actorLabel('codex'), actorLabel('cursor-agent'), actorLabel('you'), actorLabel('auto')]).toEqual(['Claude Code', 'Codex', 'Cursor Agent', 'you', 'Quorum']);
    expect([agentActor('claude-code'), agentActor(''), agentActor('you'), agentActor('Bad Name!')]).toEqual(['claude-code', 'agent', 'agent', 'badname']);
  });
});

describe('knowledge bases and connectors', () => {
  it('says knowledge bases need Quorum Cloud, and creates one through the Knowledge handler', async () => {
    await expect(setup().actions.run('kb_create', { name: 'Handbook' })).rejects.toThrow('Quorum Cloud');
    const made = [];
    const kbHosted = { handlers: { 'kb-hosted-create': async (name, team) => { made.push([name, team]); return name === 'x'.repeat(121) ? { error: 'That name is too long.' } : { kb: { id: 'kb1', name } }; } } };
    const { actions, toasts } = setup({ kbHosted });
    expect(await actions.run('kb_create', { name: 'Handbook', team: 't1' }, 'claude-code')).toEqual({ kb: { id: 'kb1', name: 'Handbook' } });
    await expect(actions.run('kb_create', { name: 'x'.repeat(121) })).rejects.toThrow('That name is too long.');
    expect(made[0]).toEqual(['Handbook', 't1']);
    expect(toasts[0]).toBe('Claude Code created the knowledge base “Handbook”');
  });
  it('attaches a repository and lists attachments through the sync handlers', async () => {
    const seen = [];
    const kbSync = { handlers: {
      'kb-sync-attach-github': async (req) => { seen.push(req); return req.url.includes('cancel') ? { canceled: true } : { attachment: { id: 'a1' } }; },
      'kb-sync-list': async (kbId) => ({ attachments: [{ id: 'a1', kb: kbId }] }),
    } };
    const { actions } = setup({ kbSync, settings: { memoryAgentActions: false } });
    expect(await actions.run('kb_list_attachments', { kb: 'kb1' })).toEqual({ attachments: [{ id: 'a1', kb: 'kb1' }] });
    await expect(actions.run('kb_attach_github', { kb: 'kb1', url: 'https://github.com/a/b' })).rejects.toThrow(gateOff('attach GitHub repositories to knowledge bases'));
    const on = setup({ kbSync }).actions;
    expect(await on.run('kb_attach_github', { kb: 'kb1', url: 'https://github.com/a/b', branch: 'main' })).toEqual({ attachment: { id: 'a1' } });
    expect(seen[0]).toEqual({ kbId: 'kb1', folderId: null, url: 'https://github.com/a/b', branch: 'main' });
    await expect(on.run('kb_attach_github', { kb: 'kb1', url: 'https://github.com/cancel/b' })).rejects.toThrow('sign-in was cancelled');
  });
  it('reports each account with its read tools, with opted-out names withheld', async () => {
    const r = await setup().actions.run('connector_status', {});
    expect(r.accounts).toEqual([
      { id: 'slack', name: 'Slack', available: true, connected: true, account: '[withheld] Co', connectedAt: null, error: null, readTools: ['slack_search', 'slack_thread'] },
      { id: 'notion', name: 'Notion', available: true, connected: false, account: null, connectedAt: null, error: null, readTools: [] },
    ]);
  });
});
