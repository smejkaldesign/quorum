// The Notifications feed rows, built once per change and shared by every reader until the next one (main.js): the bell,
// the Memory tab counts, Memory health and Notifications all read the same rows. touch() marks a change. A build that a
// change overtook is handed to the readers waiting on it and not kept, so the next read builds again. key() names the
// state of a source with no change event (the guardrail log another process writes); maxAge bounds everything else.
export function createFeedCache({ build, key = () => '', maxAge = 5 * 60000, now = Date.now }) {
  let gen = 0;
  let kept = null; // { gen, key, at, value, derived: Map }
  let pending = null; // { gen, key, promise }
  let builds = 0;

  function get() {
    const k = key();
    if (kept && kept.gen === gen && kept.key === k && now() - kept.at < maxAge) return Promise.resolve(kept.value);
    if (pending && pending.gen === gen && pending.key === k) return pending.promise;
    const g = gen;
    builds++;
    const promise = Promise.resolve().then(build).then((value) => {
      if (g === gen) kept = { gen: g, key: k, at: now(), value, derived: new Map() };
      return value;
    });
    const entry = { gen: g, key: k, promise };
    pending = entry;
    const clear = () => { if (pending === entry) pending = null; };
    promise.then(clear, clear);
    return promise;
  }

  // a value worked out from the rows (the counts), kept with them until they are built again
  async function derived(name, fn) {
    const value = await get();
    const entry = kept?.value === value ? kept : null;
    if (entry?.derived.has(name)) return entry.derived.get(name);
    const out = fn(value);
    entry?.derived.set(name, out);
    return out;
  }

  return { get, derived, touch: () => { gen++; }, stats: () => ({ gen, builds }) };
}
