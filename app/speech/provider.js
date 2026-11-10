// The speech provider contract. Apple's on-device engine runs inside the helper; every other engine takes the helper's
// 16 kHz PCM per channel and answers with the helper's transcript events, so main.js feeds either into addFinal.
// openSpeech runs a cloud engine on the user's own key, with the same surface as the relay session (app/ee/relay.js):
// ready, send(channel, pcm), close(), open. The relay uses the same engine modules on Quorum's keys.
import { ENGINES } from './engines/index.js';

// engines with a streaming adapter today; the others in the catalog wait for theirs
export const SPEECH_ENGINES = Object.keys(ENGINES);
export const speechEngineFor = (id) => ENGINES[id] ?? null;

export function openSpeech({ engine, key, channels = ['me', 'them'], sampleRate = 16000, terms = [], locale = 'en-US', onEvent = () => {}, onError = () => {}, onClose = () => {}, engines = ENGINES }) {
  const mod = engines[engine];
  if (!mod) throw new Error(`no speech engine named ${engine}`);
  if (!key) throw new Error(`${mod.name ?? engine} needs a key`);
  let closed = false, failures = 0;
  const sessions = {};
  const fail = (err) => { onError(err); if (!closed) { closed = true; onClose({ error: err }); for (const s of Object.values(sessions)) { try { s.close(); } catch {} } } };
  for (const channel of channels) {
    sessions[channel] = mod.open({
      key, sampleRate, terms, locale, channel,
      onEvent,
      onError: (err) => fail(err instanceof Error ? err : new Error(String(err))),
      // one channel closing on its own ends the session; close() below expects both to go
      onClose: () => { if (!closed) { failures += 1; fail(new Error(`${engine} closed the ${channel} stream`)); } },
    });
  }
  // one refused channel closes the others, so no socket stays open on a key that does not work
  const ready = Promise.all(Object.values(sessions).map((s) => s.ready)).then(() => ({ engine, counted: false }), (err) => { closed = true; for (const s of Object.values(sessions)) { try { s.close(); } catch {} } throw err; });
  ready.catch(() => {});
  return {
    ready,
    send(channel, pcm) { if (!closed) sessions[channel]?.send(pcm); },
    close() {
      if (closed) return;
      closed = true;
      for (const s of Object.values(sessions)) { try { s.close(); } catch {} }
    },
    get open() { return !closed; },
    get failures() { return failures; },
  };
}
