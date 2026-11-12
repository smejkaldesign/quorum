// The three questions the index, sync and the agent ask of the compiled guardrails, built once over a guardrails
// instance: is this path in a denied folder, does its name look like a secret, does its frontmatter carry a denied
// key. main.js and scripts/perf-bench.mjs share them, so the bench times what the app runs.
import path from 'node:path';
import { SECRET_NAMES, frontmatterKeys } from './guardrails.js';

export function createPredicates({ guardrails, brain }) {
  // the pattern is compiled once per rule set; the index asks for every note it walks
  let secretRe = { source: null, re: null };
  return {
    isPrivatePath: (rel) => {
      const b = brain();
      if (!b) return false;
      const abs = path.resolve(b.vault, rel);
      return guardrails.compiled().denyDirs.some((d) => { const dir = path.join(b.root, d); return abs === dir || abs.startsWith(dir + path.sep); });
    },
    isSecretPath: (rel) => {
      const c = guardrails.compiled();
      if (c.secretsOff) return false;
      const source = c.secretPattern ?? SECRET_NAMES;
      if (secretRe.source !== source) secretRe = { source, re: new RegExp(source, 'i') };
      return secretRe.re.test(String(rel));
    },
    // only the frontmatter block counts, the same as the read guard: a body line that starts with the key is no mark
    isConfidentialText: (text) => {
      const denied = guardrails.compiled().frontmatterKeys;
      return denied.length > 0 && frontmatterKeys(String(text).slice(0, 4000)).some((k) => denied.includes(k));
    },
  };
}
