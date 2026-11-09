// client binary frames: one byte of channel index into the hello's channels list, then PCM16LE at the hello's sample rate
export function demux(frame, channels) {
  const buf = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (buf.length < 3) return null;
  const channel = channels[buf[0]];
  if (!channel) return null;
  // an odd payload would split a sample; drop the stray byte rather than feed half a sample to the engine
  const pcm = buf.subarray(1, 1 + ((buf.length - 1) & ~1));
  return pcm.length ? { channel, pcm } : null;
}

export const pcmSeconds = (bytes, sampleRate) => bytes / 2 / sampleRate;

// what the client may ask for; anything else gets the default. channels are the app's two sides in the order it sends them
export function cleanHello(h = {}) {
  const channels = Array.isArray(h.channels) ? [...new Set(h.channels.map((c) => String(c).slice(0, 16)).filter(Boolean))].slice(0, 2) : [];
  const terms = Array.isArray(h.terms) ? [...new Set(h.terms.map((t) => String(t).trim()).filter((t) => t && t.length <= 50))].slice(0, 100) : [];
  return {
    token: typeof h.token === 'string' ? h.token : null,
    workspaceId: String(h.workspaceId ?? ''),
    meetingId: h.meetingId == null ? null : String(h.meetingId),
    channels: channels.length ? channels : ['me', 'them'],
    sampleRate: [8000, 16000, 24000, 48000].includes(h.sampleRate) ? h.sampleRate : 16000,
    terms,
    locale: /^[a-z]{2}(-[A-Za-z]{2})?$/.test(String(h.locale ?? '')) ? String(h.locale) : 'en-US',
  };
}
