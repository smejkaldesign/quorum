// System One decision models: typed yes/no answers in a few hundred ms, from whichever provider the workspace connected.
// The key sits in Quorum's secret store (secrets.js) under the provider's own service name; every caller falls back to
// what it did before when there's no key or the call fails
import { isDevelopment } from './edition.js';
import { secrets } from './secrets.js';

export const PROVIDERS = {
  openai: { name: 'OpenAI decisions', service: 'openai-decisions', url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', placeholder: 'sk-...', keyHint: 'OpenAI API key' },
  typesafe: { name: 'TypeSafe Jev', service: 'typesafe-systemone', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', placeholder: 'ts-...', keyHint: 'TypeSafe API key' },
};
const svc = (p) => (isDevelopment ? `quorum-dev-${p.service}` : p.service);
const cached = {}; // per provider: undefined until looked up, null when there's no key

const known = (provider) => { if (!PROVIDERS[provider]) throw new Error(`unknown decisions provider ${provider}`); return PROVIDERS[provider]; };

export async function decisionsKey(provider) {
  const p = known(provider);
  if (cached[provider] !== undefined) return cached[provider];
  const key = await secrets.get(svc(p));
  if (key === undefined) return null; // stored but unreadable this time: asked again next call
  cached[provider] = key || null;
  return cached[provider];
}

// the first provider with a key wins; the workspace setting is the record of who set it up
export async function connectedProvider(preferred) {
  for (const id of [preferred, ...Object.keys(PROVIDERS)].filter(Boolean)) if (await decisionsKey(id)) return id;
  return null;
}

// questions are the OpenAI shape ({ type: 'predicate', name, instructions }); answers come back as { [name]: { probability } }
export async function decide(provider, input, questions, timeoutMs = 4000, key) {
  const p = known(provider);
  const k = key ?? await decisionsKey(provider);
  if (!k) return null;
  const body = provider === 'typesafe'
    ? { model: p.model, state: input, questions: Object.fromEntries(questions.map((q) => [q.name, { type: 'noul', instructions: q.instructions }])) }
    : { model: p.model, input, questions };
  const r = await fetch(p.url, { method: 'POST', headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${p.name} ${r.status}`);
  const data = await r.json();
  if (provider === 'typesafe') return Object.fromEntries(Object.entries(data.answers ?? {}).filter(([, a]) => a?.type === 'noul').map(([name, a]) => [name, { name, type: 'predicate', probability: Number(a.noul) }]));
  return Object.fromEntries((data.answers ?? []).filter((a) => a.type !== 'refusal').map((a) => [a.name, a]));
}

// checks the key with one tiny question before keeping it
export async function setDecisionsKey(provider, key) {
  const p = known(provider);
  try {
    await decide(provider, 'Hello there', [{ type: 'predicate', name: 'greeting', instructions: 'Is this a greeting?' }], 8000, key);
  } catch (err) {
    return { error: /401|403/.test(err.message) ? `${p.name} didn't accept that key` : `Couldn't reach ${p.name}. Check your connection and try again.` };
  }
  const saved = await secrets.set(svc(p), key);
  cached[provider] = undefined;
  return saved ? { ok: true } : { error: "Couldn't save the key on this Mac" };
}

export async function removeDecisionsKey(provider) {
  const p = known(provider);
  await secrets.remove(svc(p));
  cached[provider] = null;
}
