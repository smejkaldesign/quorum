// one line per event, JSON, to stdout. Audio bytes and keys never pass through here: callers log counts and names.
export function log(event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}
