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
// characters per token for English notes, and the answer each call writes: a note read brings a few claims of about
// 60 tokens each, a judge answers one label with two quotes and a reason
export const CHARS_PER_TOKEN = 4;
export const OUT_TOKENS_PER_NOTE = 180;
export const JUDGE_IN_TOKENS = 700;
export const JUDGE_OUT_TOKENS = 150;

export const tokensOf = (chars) => Math.ceil(chars / CHARS_PER_TOKEN);
// the dollars at API rates for this many input and output tokens on a model alias
export function dollars(alias, input, output) {
  const p = PRICES[alias];
  if (!p) return 0;
  return (input * p.input + output * p.output) / 1e6;
}

// what a pass costs at API rates. claims: { promptChars, notes } of the claim calls; pairs: the pairs to judge
export function passCost({ promptChars = 0, notes = 0 } = {}, pairs = 0) {
  const claimIn = tokensOf(promptChars);
  const claimOut = notes * OUT_TOKENS_PER_NOTE;
  const judgeIn = pairs * JUDGE_IN_TOKENS;
  const judgeOut = pairs * JUDGE_OUT_TOKENS;
  const usd = dollars(MEMORY_MODELS.claims, claimIn, claimOut) + dollars(MEMORY_MODELS.judge, judgeIn, judgeOut);
  return { inputTokens: claimIn + judgeIn, outputTokens: claimOut + judgeOut, usd };
}

// "About $0.42 at API rates", or "Less than $0.01 at API rates" for a tiny pass
export function costLabel(usd) {
  if (!(usd > 0)) return null;
  if (usd < 0.01) return 'Less than $0.01 at API rates';
  return `About $${usd < 10 ? usd.toFixed(2) : Math.round(usd)} at API rates`;
}
