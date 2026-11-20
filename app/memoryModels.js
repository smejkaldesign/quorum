// The models the memory agent uses and what they cost, in one place. One setting per stage: MEMORY_MODELS names the
// model of each kind of call and CLAIM_ANSWER the form of the claim answer. The names are the Claude Code model
// aliases claudeText passes to `claude -p --model`.
//
// Claims run on Sonnet with the JSON answer. On 100 dated or decision notes of the owner's vault, against Sonnet with
// the JSON answer: Haiku with the JSON answer found 82% of Sonnet's claims (3 of 13 calls failed), Haiku with the
// compact answer 65%, Sonnet with the compact answer 69%. Accuracy comes first, so the stage keeps the answer that
// matched; switch here after a real run shows another one holds up.
//
// Prices are API-rate equivalents in US dollars per million tokens, for the models the aliases named when this was
// written (Claude Haiku 5.5 and Claude Sonnet 5.5). On a Claude Code sign-in the calls count against the plan's usage
// limits; nothing is billed per token. Update the table when the aliases move to a new model.
// relations: the model pass (memoryModelPass.js), which reads prose for entities, relations and decisions. It runs on
// the claims model: the same kind of reading, where Sonnet held up and Haiku did not
export const MEMORY_MODELS = { claims: 'sonnet', judge: 'sonnet', draft: 'sonnet', relations: 'sonnet' };
// 'json': one JSON object of claims; 'compact': one line per claim (contradictionClaims.js parseCompact)
export const CLAIM_ANSWER = 'json';
export const PRICES = {
  haiku: { model: 'Claude Haiku 5.5', input: 0.1, output: 0.5 },
  sonnet: { model: 'Claude Sonnet 5.5', input: 2, output: 10 },
};
// what a claim call measured on those 100 notes, 20 notes or up to 44,000 characters a call: output tokens per note
// read (thinking included) and seconds per call
export const MEASURED = {
  'sonnet/json': { outPerNote: 840, seconds: 33 },
  'sonnet/compact': { outPerNote: 660, seconds: 35 },
  'haiku/json': { outPerNote: 4560, seconds: 117 },
  'haiku/compact': { outPerNote: 2040, seconds: 67 },
};
export const claimMeasure = (model = MEMORY_MODELS.claims, answer = CLAIM_ANSWER) => MEASURED[`${model}/${answer}`] ?? MEASURED['sonnet/json'];
// A judge answers one label with two quotes and a reason per pair. A judge call holds up to JUDGE_BATCH pairs
// (contradictionResolve.js) of about JUDGE_PAIR_TOKENS each, after its system prompt; its time is taken as a claim
// call's on Sonnet. Every `claude -p` call also carries CALL_OVERHEAD_TOKENS of Claude Code's own prompt (measured with
// hooks off). Measured on two Haiku calls: Claude Code caches the system prompt, which later calls read from the
// cache, and writes the rest of each prompt, its own part included, to the cache at CACHE_WRITE times the input price
export const CHARS_PER_TOKEN = 4;
export const JUDGE_PAIR_TOKENS = 400;
export const JUDGE_SYSTEM_TOKENS = 330;
export const JUDGE_OUT_TOKENS = 150;
export const JUDGE_BATCH = 8;
export const JUDGE_SECONDS = 33;
// a draft call (memoryDraft.js) reads the notes of one item and writes one fix
export const DRAFT_IN_TOKENS = 3000;
export const DRAFT_OUT_TOKENS = 800;
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
// what a pass costs at API rates. claims: { promptChars, notes, calls } of the claim calls; pairs: the pairs to judge;
// drafts: the draft calls. inputTokens counts Claude Code's part at the cache-write price, as input tokens of equal cost
export function passCost({ promptChars = 0, notes = 0, calls = 0 } = {}, pairs = 0, { model = MEMORY_MODELS.claims, answer = CLAIM_ANSWER, drafts = 0 } = {}) {
  const claimIn = Math.round(tokensOf(promptChars) + calls * CALL_OVERHEAD_TOKENS * CACHE_WRITE);
  const claimOut = notes * claimMeasure(model, answer).outPerNote;
  const jc = judgeCalls(pairs);
  const judgeIn = Math.round(pairs * JUDGE_PAIR_TOKENS + jc * (JUDGE_SYSTEM_TOKENS + CALL_OVERHEAD_TOKENS * CACHE_WRITE));
  const judgeOut = pairs * JUDGE_OUT_TOKENS;
  const draftIn = Math.round(drafts * (DRAFT_IN_TOKENS + CALL_OVERHEAD_TOKENS * CACHE_WRITE));
  const draftOut = drafts * DRAFT_OUT_TOKENS;
  const usd = dollars(model, claimIn, claimOut) + dollars(MEMORY_MODELS.judge, judgeIn, judgeOut) + dollars(MEMORY_MODELS.draft, draftIn, draftOut);
  return { inputTokens: claimIn + judgeIn + draftIn, outputTokens: claimOut + judgeOut + draftOut, judgeCalls: jc, usd };
}

// "About $0.42 at API rates", or "Less than $0.01 at API rates" for a tiny pass
export function costLabel(usd) {
  if (!(usd > 0)) return null;
  if (usd < 0.01) return 'Less than $0.01 at API rates';
  return `About $${usd < 10 ? usd.toFixed(2) : Math.round(usd)} at API rates`;
}
