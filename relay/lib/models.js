// text in, streamed text out, for the two model shapes the relay speaks: Anthropic Messages and OpenAI chat completions
// (which also covers openai_compatible connectors by base URL). onDelta gets each new piece of text.
const ANTHROPIC = { url: 'https://api.anthropic.com/v1/messages', version: '2023-06-01' };
export const ANTHROPIC_MODELS = { summary: 'claude-haiku-5-5', notes: 'claude-sonnet-5-5' };

async function readLines(body, onLine) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
  }
  if (buf) onLine(buf);
}

export async function streamAnthropic({ key, model, system, prompt, maxTokens = 8192, onDelta, signal, fetchImpl = fetch }) {
  const r = await fetchImpl(ANTHROPIC.url, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC.version, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, stream: true, messages: [{ role: 'user', content: prompt }] }),
    signal,
  });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(`Anthropic ${r.status}: ${data.error?.message ?? r.statusText}`); }
  let acc = '', stop = null;
  await readLines(r.body, (line) => {
    if (!line.startsWith('data:')) return;
    let evt;
    try { evt = JSON.parse(line.slice(5)); } catch { return; }
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') { acc += evt.delta.text; onDelta(evt.delta.text); }
    if (evt.type === 'message_delta') stop = evt.delta?.stop_reason ?? stop;
    if (evt.type === 'error') throw new Error(`Anthropic: ${evt.error?.message ?? 'stream error'}`);
  });
  if (stop === 'refusal') throw new Error('The model declined this request');
  return acc.trim();
}

export async function streamOpenAI({ key, baseUrl = 'https://api.openai.com/v1', model, system, prompt, maxTokens = 8192, onDelta, signal, fetchImpl = fetch }) {
  const r = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal,
  });
  if (!r.ok) { const data = await r.json().catch(() => ({})); throw new Error(`${new URL(baseUrl).host} ${r.status}: ${data.error?.message ?? r.statusText}`); }
  let acc = '';
  await readLines(r.body, (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch { return; }
    const piece = evt.choices?.[0]?.delta?.content;
    if (typeof piece === 'string' && piece) { acc += piece; onDelta(piece); }
  });
  return acc.trim();
}

// which call to make for a step: the organization's connector when the admin pointed the step at one, else Quorum's Anthropic key
export function pickModel({ step, connector, quorumKey, openaiModel }) {
  if (connector) {
    if (connector.provider === 'anthropic') return { kind: 'anthropic', key: connector.secret, model: ANTHROPIC_MODELS[step], counted: false };
    if (connector.provider === 'openai' || connector.provider === 'openai_compatible') return { kind: 'openai', key: connector.secret, baseUrl: connector.baseUrl ?? undefined, model: openaiModel, counted: false };
    throw new Error(`The organization's ${step} connector (${connector.provider}) is not a model provider the relay can call.`);
  }
  if (!quorumKey) throw new Error('Managed notes are not set up on this relay.');
  return { kind: 'anthropic', key: quorumKey, model: ANTHROPIC_MODELS[step], counted: true };
}
