import { describe, expect, it } from 'vitest';
import {
  CATALOG, KEY_PROVIDER_IDS, PROVIDER_IDS, ROLE_IDS, canServe, cleanConnectors, cleanProviders, modelFor, needsBaseUrl, needsKey,
  providerFor, providersFor, providersFromSource, rolesFor, sourceFromProviders, validRoles,
} from '../connectors/catalog.js';
import { testConnector } from '../connectors/keys.js';
import { googleDelta, googleReply, modelLabel, openaiDelta, openaiReply } from '../models.js';
import { PROVIDERS as HOSTED } from '../ee/src/connectorRoles.ts';

describe('the connector catalog', () => {
  it('gives every provider a name, at least one role from the five, a valid auth and docs', () => {
    expect(PROVIDER_IDS).toEqual(['apple', 'assemblyai', 'deepgram', 'elevenlabs', 'openai', 'anthropic', 'google', 'claude-code', 'ollama', 'openai_compatible']);
    for (const p of CATALOG) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.roles.length).toBeGreaterThan(0);
      for (const r of p.roles) expect(ROLE_IDS).toContain(r);
      expect(['none', 'key', 'key+url', 'signin']).toContain(p.auth);
      expect(p.docs).toMatch(/^https:\/\//);
      if (needsKey(p.id)) { expect(typeof p.test).toBe('function'); expect(p.keyHint.length).toBeGreaterThan(0); }
    }
  });

  it('filters providers by role and roles by provider', () => {
    expect(providersFor('speech')).toEqual(['apple', 'assemblyai', 'deepgram', 'elevenlabs', 'openai', 'google']);
    expect(providersFor('voice')).toEqual(['elevenlabs', 'openai']);
    expect(providersFor('agent')).toEqual(['openai', 'anthropic', 'google', 'claude-code', 'ollama', 'openai_compatible']);
    expect(rolesFor('apple')).toEqual(['speech']);
    expect(canServe('anthropic', 'speech')).toBe(false);
    expect(validRoles('elevenlabs', ['speech', 'notes', 'voice'])).toEqual(['speech', 'voice']);
    expect(needsBaseUrl('openai_compatible')).toBe(true);
    expect(needsKey('ollama')).toBe(false);
  });

  it('is the list the hosted Admin page shows: exactly the key providers, in catalog order', () => {
    expect(Object.keys(HOSTED)).toEqual(KEY_PROVIDER_IDS);
    expect(KEY_PROVIDER_IDS).toEqual(['assemblyai', 'deepgram', 'elevenlabs', 'openai', 'anthropic', 'google', 'openai_compatible']);
    expect(HOSTED.openai_compatible.baseUrl).toBe(true);
    expect(HOSTED.anthropic.roles).toEqual(rolesFor('anthropic'));
  });

  it('builds each test request from the key alone, never from anything else, and the compatible one from the base URL', () => {
    const t = (id, base) => CATALOG.find((p) => p.id === id).test('KEY', base);
    expect(t('anthropic')).toEqual({ url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': 'KEY', 'anthropic-version': '2023-06-01' } });
    expect(t('openai').url).toBe('https://api.openai.com/v1/models');
    expect(t('google')).toEqual({ url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', headers: { 'x-goog-api-key': 'KEY' } });
    expect(t('deepgram').headers.authorization).toBe('Token KEY');
    expect(t('assemblyai').url).toBe('https://api.assemblyai.com/v2/transcript?limit=1');
    expect(t('elevenlabs').headers['xi-api-key']).toBe('KEY');
    expect(t('ollama').url).toBe('http://127.0.0.1:11434/api/tags');
    expect(t('openai_compatible', 'https://llm.example.com/v1/').url).toBe('https://llm.example.com/v1/models');
  });

  it('maps the picker alias to a model per provider, or leaves it to the user', () => {
    expect(modelFor('anthropic', 'haiku')).toBe('claude-haiku-5-5');
    expect(modelFor('openai', 'haiku')).toBe('gpt-5-mini');
    expect(modelFor('google', 'opus')).toBe('gemini-2.5-pro');
    expect(modelFor('openai', 'mystery')).toBe('gpt-5');
    expect(modelFor('ollama', 'haiku')).toBeNull();
    expect(modelLabel('openai_compatible', 'sonnet', 'llama3.1', { openai_compatible: { model: 'qwen3' } })).toBe('qwen3');
    expect(modelLabel('ollama', 'sonnet', 'qwen2.5:7b')).toBe('ollama/qwen2.5:7b');
    expect(modelLabel('claude-code', 'opus')).toBe('claude-opus');
    expect(modelLabel(null, 'opus')).toBe('none');
  });
});

describe('settings.providers and the legacy switch', () => {
  it('reads the switch as the three model roles on one provider and leaves speech and voice alone', () => {
    expect(providersFromSource('anthropic-api', { speech: 'deepgram' })).toEqual({ speech: 'deepgram', summary: 'anthropic', notes: 'anthropic', agent: 'anthropic' });
    expect(providersFromSource('claude-code').agent).toBe('claude-code');
    expect(providersFromSource('local').notes).toBe('ollama');
    expect(providersFromSource('none', { summary: 'openai', voice: 'elevenlabs' })).toEqual({ voice: 'elevenlabs' });
    expect(providersFromSource(undefined)).toEqual({});
  });

  it('writes the switch back from the agent, then notes, then summary; providers without a legacy value read as none', () => {
    expect(sourceFromProviders({ agent: 'claude-code', notes: 'anthropic' })).toBe('claude-code');
    expect(sourceFromProviders({ notes: 'anthropic' })).toBe('anthropic-api');
    expect(sourceFromProviders({ summary: 'ollama' })).toBe('local');
    expect(sourceFromProviders({ notes: 'openai' })).toBe('none');
    expect(sourceFromProviders({})).toBe('none');
    for (const src of ['claude-code', 'anthropic-api', 'local']) expect(sourceFromProviders(providersFromSource(src))).toBe(src);
  });

  it('merges a partial pick, keeps only ids that can do the role, and clears on null', () => {
    const cur = { summary: 'anthropic', notes: 'anthropic', agent: 'claude-code' };
    expect(cleanProviders({ speech: 'deepgram', notes: 'openai' }, cur)).toEqual({ ...cur, speech: 'deepgram', notes: 'openai' });
    expect(cleanProviders({ speech: 'anthropic' }, cur)).toEqual(cur);
    expect(cleanProviders({ agent: null, voice: '' }, { ...cur, voice: 'openai' })).toEqual({ summary: 'anthropic', notes: 'anthropic' });
    expect(cleanProviders({ bogus: 'openai', notes: 7 }, cur)).toEqual(cur);
    expect(cleanProviders('x', cur)).toEqual(cur);
  });

  it('resolves a role: its own pick, another model role, the legacy switch, then Apple for speech', () => {
    expect(providerFor('summary', { summary: 'google' }, 'claude-code')).toBe('google');
    expect(providerFor('summary', { notes: 'openai' }, 'none')).toBe('openai');
    expect(providerFor('agent', {}, 'anthropic-api')).toBe('anthropic');
    expect(providerFor('agent', null, 'none')).toBeNull();
    expect(providerFor(null, { notes: 'ollama' }, 'none')).toBe('ollama');
    expect(providerFor('speech', {}, 'claude-code')).toBe('apple');
    expect(providerFor('speech', { speech: 'deepgram' }, 'none')).toBe('deepgram');
    expect(providerFor('voice', {}, 'claude-code')).toBeNull();
  });

  it('keeps a base URL and model only for the compatible provider, and only when well formed', () => {
    expect(cleanConnectors({ openai_compatible: { baseUrl: ' https://llm.example.com/v1 ', model: 'qwen3:8b' } })).toEqual({ openai_compatible: { baseUrl: 'https://llm.example.com/v1', model: 'qwen3:8b' } });
    expect(cleanConnectors({ openai_compatible: { baseUrl: 'ftp://x' } }, { openai_compatible: { baseUrl: 'https://a' } })).toEqual({ openai_compatible: { baseUrl: 'https://a' } });
    expect(cleanConnectors({ openai_compatible: { model: '' } }, { openai_compatible: { baseUrl: 'https://a', model: 'm' } })).toEqual({ openai_compatible: { baseUrl: 'https://a' } });
    expect(cleanConnectors({ openai: { baseUrl: 'https://a' }, openai_compatible: null }, { openai_compatible: { baseUrl: 'https://a' } })).toEqual({});
  });
});

describe('response parsers', () => {
  it('reads an OpenAI chat completions stream line by line, skipping keep-alives and [DONE]', () => {
    const lines = [
      ': keep-alive',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ];
    expect(lines.map((l) => openaiDelta(l)).filter(Boolean).join('')).toBe('Hello there');
    expect(() => openaiDelta('data: {"error":{"message":"rate limited"}}', 'Acme')).toThrow('Acme: rate limited');
    expect(openaiDelta('data: not json')).toBeNull();
  });

  it('reads a non-streamed OpenAI reply and refuses a filtered one', () => {
    expect(openaiReply({ choices: [{ message: { role: 'assistant', content: '  Done. ' }, finish_reason: 'stop' }] })).toBe('Done.');
    expect(openaiReply({})).toBe('');
    expect(() => openaiReply({ choices: [{ message: { content: null }, finish_reason: 'content_filter' }] })).toThrow('declined');
  });

  it('reads a Gemini SSE stream and a whole generateContent reply', () => {
    const lines = [
      'data: {"candidates":[{"content":{"parts":[{"text":"The "}],"role":"model"},"index":0}],"usageMetadata":{"promptTokenCount":9},"modelVersion":"gemini-2.5-flash"}',
      'data: {"candidates":[{"content":{"parts":[{"text":"answer"},{"text":"."}],"role":"model"},"finishReason":"STOP","index":0}]}',
      'event: ping',
    ];
    expect(lines.map(googleDelta).filter(Boolean).join('')).toBe('The answer.');
    expect(() => googleDelta('data: {"error":{"code":429,"message":"quota"}}')).toThrow('Google: quota');
    expect(googleReply({ candidates: [{ content: { parts: [{ text: 'One' }, { text: ' two' }], role: 'model' }, finishReason: 'STOP' }] })).toBe('One two');
    expect(() => googleReply({ promptFeedback: { blockReason: 'SAFETY' } })).toThrow('declined');
    expect(googleReply({})).toBe('');
  });
});

describe('proving a key', () => {
  const calls = [];
  const fake = (status) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status }; };

  it('runs the catalog request once and reports only the outcome', async () => {
    expect(await testConnector({ provider: 'google', secret: 'AIza-test' }, fake(200))).toEqual({ ok: true });
    expect(calls.at(-1).url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1');
    expect(calls.at(-1).init.headers['x-goog-api-key']).toBe('AIza-test');
    const bad = await testConnector({ provider: 'elevenlabs', secret: 'nope' }, fake(403));
    expect(bad).toEqual({ error: 'ElevenLabs did not accept that key.' });
    expect(JSON.stringify(bad)).not.toContain('nope');
  });

  it('reaches Ollama without a key, and asks for a base URL before a compatible key', async () => {
    expect(await testConnector({ provider: 'ollama' }, fake(200))).toEqual({ ok: true });
    expect(calls.at(-1).url).toBe('http://127.0.0.1:11434/api/tags');
    const down = await testConnector({ provider: 'ollama' }, async () => { throw new Error('refused'); });
    expect(down.error).toMatch(/Ollama is running/);
    expect(await testConnector({ provider: 'openai_compatible', secret: 'k' }, fake(200))).toEqual({ error: 'Enter the base URL, starting with https://.' });
    expect(await testConnector({ provider: 'openai_compatible', secret: 'k', baseUrl: 'https://llm.example.com/v1' }, fake(200))).toEqual({ ok: true });
    expect(calls.at(-1).url).toBe('https://llm.example.com/v1/models');
    expect(await testConnector({ provider: 'apple' }, fake(200))).toEqual({ error: 'That provider is not supported.' });
    expect(await testConnector({ provider: 'claude-code' }, fake(200))).toEqual({ error: 'That provider is not supported.' });
  });
});
