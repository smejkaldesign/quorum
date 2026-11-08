// System One decision models: typed yes/no answers in a few hundred ms, from whichever provider the workspace connected.
// The key sits in the macOS Keychain under the provider's own service name; every caller falls back to what it did
// before when there's no key or the call fails
import { execFile } from 'node:child_process';

export const PROVIDERS = {
  openai: { name: 'OpenAI decisions', service: 'openai-decisions', url: 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', placeholder: 'sk-...', keyHint: 'OpenAI API key' },
  typesafe: { name: 'TypeSafe Jev', service: 'typesafe-systemone', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', placeholder: 'ts-...', keyHint: 'TypeSafe API key' },
};
const ACCOUNT = 'quorum';
const cached = {}; // per provider: undefined until looked up, null when there's no key

const security = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : out.trim())));
const known = (provider) => { if (!PROVIDERS[provider]) throw new Error(`unknown decisions provider ${provider}`); return PROVIDERS[provider]; };

export async function decisionsKey(provider) {
  const p = known(provider);
  if (cached[provider] === undefined) cached[provider] = (await security(['find-generic-password', '-s', p.service, '-a', ACCOUNT, '-w'])) || null;
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
  const saved = await security(['add-generic-password', '-U', '-s', p.service, '-a', ACCOUNT, '-l', `${p.name} (Quorum)`, '-w', key]);
  cached[provider] = undefined;
  return saved === null ? { error: "Couldn't save the key to your Keychain" } : { ok: true };
}

export async function removeDecisionsKey(provider) {
  const p = known(provider);
  await security(['delete-generic-password', '-s', p.service, '-a', ACCOUNT]);
  cached[provider] = null;
}
