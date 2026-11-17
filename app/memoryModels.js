// The models the memory agent uses and what they cost, in one place. Claim reading is extraction over short excerpts,
// so it runs on Haiku; the judge weighs two passages against each other, so it runs on Sonnet. The names are the
// Claude Code model aliases claudeText passes to `claude -p --model`.
//
// Prices are API-rate equivalents in US dollars per million tokens, for the models the aliases named when this was
// written (Claude Haiku 5.5 and Claude Sonnet 5.5). On a Claude Code sign-in the calls count against the plan's usage
// limits; nothing is billed per token. Update the table when the aliases move to a new model.
export const MEMORY_MODELS = { claims: 'haiku', judge: 'sonnet', draft: 'sonnet' };
export const PRICES = {
  haiku: { model: 'Claude Haiku 5.5', input: 0.1, output: 0.5 },
  sonnet: { model: 'Claude Sonnet 5.5', input: 2, output: 10 },
};
// characters per token for English notes, and the answer each call writes: a note read brings about 6 claims of about
// 75 tokens each (Haiku listed 650 claims for 100 notes, Sonnet 489), a judge answers one label with two quotes and a reason per pair. A judge call holds up to
// JUDGE_BATCH pairs (contradictionResolve.js) of about JUDGE_PAIR_TOKENS each, after its system prompt. Every
// `claude -p` call also carries CALL_OVERHEAD_TOKENS of Claude Code's own prompt (measured with hooks off). Measured
// on two Haiku calls: Claude Code caches the system prompt, which later calls read from the cache, and writes the rest
// of each prompt, its own part included, to the cache at CACHE_WRITE times the input price
export const CHARS_PER_TOKEN = 4;
export const OUT_TOKENS_PER_NOTE = 450;
export const JUDGE_PAIR_TOKENS = 400;
export const JUDGE_SYSTEM_TOKENS = 330;
export const JUDGE_OUT_TOKENS = 150;
export const JUDGE_BATCH = 8;
export const CALL_OVERHEAD_TOKENS = 1463;
export const CACHE_WRITE = 1.25;

export const tokensOf = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
// the dollars at API rates for this many input and output tokens on a model alias
export function dollars(alias, input, output) {
  const p = PRICES[alias];
  if (!p) return 0;
  return (input * p.input + output * p.output) / 1e6;
}

export const judgeCalls = (pairs) => Math.ceil(pairs / JUDGE_BATCH);
// what a pass costs at API rates. claims: { promptChars, notes, calls } of the claim calls; pairs: the pairs to judge.
// inputTokens counts Claude Code's part at the cache-write price, as input tokens of equal cost
export function passCost({ promptChars = 0, notes = 0, calls = 0 } = {}, pairs = 0) {
  const claimIn = Math.round(tokensOf(promptChars) + calls * CALL_OVERHEAD_TOKENS * CACHE_WRITE);
  const claimOut = notes * OUT_TOKENS_PER_NOTE;
  const jc = judgeCalls(pairs);
  const judgeIn = Math.round(pairs * JUDGE_PAIR_TOKENS + jc * (JUDGE_SYSTEM_TOKENS + CALL_OVERHEAD_TOKENS * CACHE_WRITE));
  const judgeOut = pairs * JUDGE_OUT_TOKENS;
  const usd = dollars(MEMORY_MODELS.claims, claimIn, claimOut) + dollars(MEMORY_MODELS.judge, judgeIn, judgeOut);
  return { inputTokens: claimIn + judgeIn, outputTokens: claimOut + judgeOut, judgeCalls: jc, usd };
}

// "About $0.42 at API rates", or "Less than $0.01 at API rates" for a tiny pass
export function costLabel(usd) {
  if (!(usd > 0)) return null;
  if (usd < 0.01) return 'Less than $0.01 at API rates';
  return `About $${usd < 10 ? usd.toFixed(2) : Math.round(usd)} at API rates`;
}
