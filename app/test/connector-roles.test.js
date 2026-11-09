import { describe, expect, it } from 'vitest';
import { canServe, PROVIDER_IDS, providersFor, rolesFor, serving, validRoles } from '../ee/src/connectorRoles.ts';
import { cleanDraft, testConnector } from '../ee/connectors.js';

describe('which providers serve which roles', () => {
  it('matches the product table: speech, model and voice providers', () => {
    expect(providersFor('speech')).toEqual(['assemblyai', 'deepgram', 'elevenlabs', 'openai', 'google']);
    for (const role of ['summary', 'notes', 'agent']) expect(providersFor(role)).toEqual(['openai', 'anthropic', 'google', 'openai_compatible']);
    expect(providersFor('voice')).toEqual(['elevenlabs', 'openai']);
  });

  it('gives every provider at least one role and no role outside the five', () => {
    for (const p of PROVIDER_IDS) {
      expect(rolesFor(p).length).toBeGreaterThan(0);
      for (const r of rolesFor(p)) expect(['speech', 'summary', 'notes', 'agent', 'voice']).toContain(r);
    }
    expect(canServe('anthropic', 'speech')).toBe(false);
    expect(canServe('deepgram', 'notes')).toBe(false);
  });

  it('drops roles a provider cannot do when cleaning a pick', () => {
    expect(validRoles('anthropic', ['speech', 'notes', 'voice'])).toEqual(['notes']);
    expect(validRoles('elevenlabs', ['speech', 'voice', 'agent'])).toEqual(['speech', 'voice']);
  });

  it('lists only the connectors that were given a role and whose provider can do it', () => {
    const list = [
      { id: 'a', provider: 'anthropic', roles: ['summary', 'notes'] },
      { id: 'b', provider: 'deepgram', roles: ['speech'] },
      { id: 'c', provider: 'deepgram', roles: ['speech', 'notes'] },
      { id: 'd', provider: 'openai', roles: ['notes'] },
    ];
    expect(serving(list, 'notes').map((c) => c.id)).toEqual(['a', 'd']);
    expect(serving(list, 'speech').map((c) => c.id)).toEqual(['b', 'c']);
    expect(serving(list, 'voice')).toEqual([]);
  });
});

describe('the main-process side', () => {
  it('cleans a draft: known provider, trimmed label, base URL only for the compatible provider, roles from the set', () => {
    const d = cleanDraft({ provider: 'openai', label: '  Team key ', baseUrl: 'https://x', roles: ['notes', 'nope', 'notes'], secret: ' sk-1 ' });
    expect(d).toEqual({ provider: 'openai', label: 'Team key', base_url: null, roles: ['notes'], secret: 'sk-1' });
    expect(cleanDraft({ provider: 'openai_compatible', baseUrl: ' https://llm.example.com/v1 ' }).base_url).toBe('https://llm.example.com/v1');
    expect(cleanDraft({ provider: 'mystery' })).toEqual({ error: 'That provider is not supported.' });
  });

  it('tests a key with one read-only request and reads the answer, never echoing the key', async () => {
    const calls = [];
    const fake = (status) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status }; };
    expect(await testConnector({ provider: 'anthropic', secret: 'sk-ant-test' }, fake(200))).toEqual({ ok: true });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect(calls[0].init.headers['x-api-key']).toBe('sk-ant-test');
    const bad = await testConnector({ provider: 'deepgram', secret: 'nope' }, fake(401));
    expect(bad.error).toBe('Deepgram did not accept that key.');
    expect(JSON.stringify(bad)).not.toContain('nope');
    expect(await testConnector({ provider: 'openai_compatible', baseUrl: 'ftp://x', secret: 'k' }, fake(200))).toEqual({ error: 'Enter the base URL, starting with https://.' });
    expect(await testConnector({ provider: 'openai', secret: '' }, fake(200))).toEqual({ error: 'Paste the provider key first.' });
    const down = await testConnector({ provider: 'openai', secret: 'k' }, async () => { throw new Error('offline'); });
    expect(down.error).toMatch(/could not reach OpenAI/);
  });
});
