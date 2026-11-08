// OpenAI's Decisions API: typed yes/no and pick-one answers in a couple hundred ms. The key sits in the macOS Keychain,
// shared with the vault's scripts, and every caller falls back to what it did before when there's no key or the call fails
import { execFile } from 'node:child_process';

const SERVICE = 'openai-decisions';
const ACCOUNT = 'quorum';
let cached; // undefined until looked up, null when there's no key

const security = (args) => new Promise((resolve) => execFile('/usr/bin/security', args, (err, out) => resolve(err ? null : out.trim())));

export async function decisionsKey() {
  if (cached === undefined) cached = (await security(['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])) || null;
  return cached;
}

export async function decide(input, questions, timeoutMs = 4000, key) {
  const k = key ?? await decisionsKey();
  if (!k) return null;
  const r = await fetch('https://api.openai.com/v1/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-6-luna', input, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`Decisions API ${r.status}`);
  const { answers = [] } = await r.json();
  return Object.fromEntries(answers.filter((a) => a.type !== 'refusal').map((a) => [a.name, a]));
}

// checks the key with one tiny question before keeping it
export async function setDecisionsKey(key) {
  try {
    await decide('Hello there', [{ type: 'predicate', name: 'greeting', instructions: 'Is this a greeting?' }], 8000, key);
  } catch (err) {
    return { error: /401|403/.test(err.message) ? "OpenAI didn't accept that key" : "Couldn't reach OpenAI. Check your connection and try again." };
  }
  const saved = await security(['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-l', 'OpenAI Decisions (Quorum and Agent OS)', '-w', key]);
  cached = undefined;
  return saved === null ? { error: "Couldn't save the key to your Keychain" } : { ok: true };
}

export async function removeDecisionsKey() {
  await security(['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
  cached = null;
}
