// The agent runs working on vault notes right now, for the Memory tab: which files each run has written so far, which
// folders hold them, and the runs that work on the whole vault without naming files until they finish. The keeper
// names each file as it writes it; an import names each note it writes and counts as running until it has been quiet
// for idleMs; an agent run with its own tools is only known as running in the vault, and its files are recorded when
// it ends (memoryVersions.js watch).
//
// A stoppable run (the keeper) can be stopped from the Memory tab: stopAndRestore asks the run to stop, waits for it,
// then puts back every file it changed from the versions saved before its writes and deletes those versions and
// updates (memoryVersions.js undo).

export function createLiveRuns({ onChange = () => {}, idleMs = 4000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const runs = new Map();
  let seq = 0;
  const changed = () => onChange(state());

  // stop is the run's own way to stop; a run without one cannot be stopped from the Memory tab
  function start({ who, label = who, wholeVault = false, stop = null }) {
    const id = `run-${++seq}`;
    runs.set(id, { id, who, label, wholeVault, stop, files: new Map(), timer: null, stopping: false });
    changed();
    return id;
  }
  // a file the run wrote, with the id of the version that holds the text from before the write
  function touch(id, rel, versionId = null) {
    const r = runs.get(id);
    if (!r) return;
    const known = r.files.has(rel);
    const ids = r.files.get(rel) ?? [];
    if (versionId) ids.push(versionId);
    r.files.set(rel, ids);
    if (!known) changed();
  }
  function end(id) {
    const r = runs.get(id);
    if (!r) return;
    if (r.timer) clearTimer(r.timer);
    runs.delete(id);
    changed();
  }
  // a write from a run with no clear start or end (an import): the run starts with its first write and ends once no
  // write has come for idleMs
  function pulse({ who, label = who }, rel, versionId = null) {
    let r = [...runs.values()].find((x) => x.who === who && x.pulse);
    if (!r) { r = runs.get(start({ who, label })); r.pulse = true; }
    touch(r.id, rel, versionId);
    if (r.timer) clearTimer(r.timer);
    const id = r.id;
    r.timer = setTimer(() => end(id), idleMs);
    return id;
  }
  const get = (id) => runs.get(id) ?? null;
  // what the renderer shows: each run with its files, and which run each file and folder belongs to
  function state() {
    return liveState([...runs.values()].map((r) => ({ id: r.id, who: r.who, label: r.label, wholeVault: r.wholeVault, stoppable: !!r.stop, stopping: r.stopping, files: [...r.files.keys()] })));
  }
  return { start, touch, end, pulse, get, state };
}

// the files and folders in progress, from a list of runs: a file belongs to the newest run that wrote it, and a folder
// is in progress while any file under it is
export function liveState(runs) {
  const files = {};
  const folders = new Set();
  for (const r of runs) {
    for (const rel of r.files) {
      files[rel] = r.id;
      const parts = rel.split('/');
      for (let k = 1; k < parts.length; k++) folders.add(parts.slice(0, k).join('/'));
    }
  }
  return { runs, files, folders: [...folders].sort(), vault: runs.filter((r) => r.wholeVault).map((r) => r.id) };
}

// stop a run and put back every file it changed. Returns the files restored, or null when the run is gone or cannot
// be stopped
export async function stopAndRestore(live, id, { store, vault }) {
  const r = live.get(id);
  if (!r || !r.stop) return null;
  r.stopping = true;
  await r.stop();
  const files = [...r.files.entries()];
  live.end(id);
  const restored = [];
  for (const [rel, ids] of files) if (ids.length && store.undo(vault, rel, ids)) restored.push(rel);
  return restored;
}
