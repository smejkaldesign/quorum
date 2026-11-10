// In-app updates for both editions. electron-updater reads a static feed, so no account is involved: the Local
// edition reads GitHub Releases (latest-mac.yml from the release workflow) and the Cloud edition reads the generic
// feed quorum.watch serves (quorumCloud.updates in the packaged package.json, written by scripts/package-cloud.mjs).
// The state here is what the window shows: an Update button once a version is downloaded, and the About row in
// Preferences. Pure apart from the autoUpdater passed in, so the tests drive it with a fake.
export const CHECK_EVERY_MS = 6 * 3600 * 1000;
export const FIRST_CHECK_MS = 15000;
export const FOCUS_CHECK_AFTER_MS = 3600 * 1000;

// where this build looks for updates; null means the build has no feed and the updater stays off
export function feedFor({ edition, packaged }) {
  if (edition === 'cloud') return packaged?.quorumCloud?.updates ? { provider: 'generic', url: String(packaged.quorumCloud.updates).replace(/\/+$/, '') } : null;
  return { provider: 'github', owner: 'smejkaldesign', repo: 'quorum' };
}

export function createUpdater({ autoUpdater, feed, current, enabled = true, emit = () => {}, log = () => {}, now = () => Date.now(), timers = { setTimeout, setInterval, clearTimeout, clearInterval } }) {
  let state = { status: enabled && feed ? 'idle' : 'off', current, version: null, percent: 0, notes: null, checkedAt: null, error: null };
  const set = (patch) => { state = { ...state, ...patch }; emit(state); };
  const notesOf = (info) => (typeof info?.releaseNotes === 'string' ? info.releaseNotes : Array.isArray(info?.releaseNotes) ? info.releaseNotes.map((n) => n?.note ?? '').join('\n') : null);

  if (state.status !== 'off') {
    if (feed.provider === 'generic') autoUpdater.setFeedURL?.({ provider: 'generic', url: feed.url });
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => set({ status: state.status === 'ready' ? 'ready' : 'checking', error: null }));
    autoUpdater.on('update-available', (info) => { log('updater: available', info?.version); set({ status: 'downloading', version: info?.version ?? null, percent: 0, notes: notesOf(info), checkedAt: now() }); });
    autoUpdater.on('update-not-available', () => set({ status: state.status === 'ready' ? 'ready' : 'idle', checkedAt: now(), error: null }));
    autoUpdater.on('download-progress', (p) => set({ status: 'downloading', percent: Math.round(p?.percent ?? 0) }));
    autoUpdater.on('update-downloaded', (info) => { log('updater: downloaded', info?.version); set({ status: 'ready', version: info?.version ?? state.version, percent: 100, notes: notesOf(info) ?? state.notes, checkedAt: now() }); });
    autoUpdater.on('error', (e) => { log('updater', String(e?.message ?? e)); set({ status: state.status === 'ready' ? 'ready' : 'failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 200), checkedAt: now() }); });
  }

  const check = async () => {
    if (state.status === 'off' || state.status === 'checking' || state.status === 'downloading') return state;
    try { await autoUpdater.checkForUpdates(); } catch (e) { set({ status: state.status === 'ready' ? 'ready' : 'failed', error: String(e?.message ?? e).split('\n')[0].slice(0, 200), checkedAt: now() }); }
    return state;
  };
  let handles = [];
  return {
    state: () => state,
    check,
    // the window came to the front: one check an hour at most, so a Mac that sleeps through the interval still hears
    onFocus: () => { if (state.status === 'idle' && (!state.checkedAt || now() - state.checkedAt > FOCUS_CHECK_AFTER_MS)) check(); },
    install: () => { if (state.status !== 'ready') return false; autoUpdater.quitAndInstall(); return true; },
    start: () => {
      if (state.status === 'off') return () => {};
      handles = [timers.setTimeout(check, FIRST_CHECK_MS), timers.setInterval(check, CHECK_EVERY_MS)];
      return () => { timers.clearTimeout(handles[0]); timers.clearInterval(handles[1]); };
    },
  };
}
