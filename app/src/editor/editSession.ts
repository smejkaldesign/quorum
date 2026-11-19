// One open note's edits in Knowledge (VaultEditor.tsx), apart from React so the save and reload rules can be tested.
// Edits save on a short pause, one save at a time, and each save names the hash of the file it was made from. When the
// file changes on disk under it, the note opens again as it is now; an edit that wasn't saved yet goes to the clipboard
// first and the message says so. After the view closes, a last save that fails (a conflict, or the note was moved or
// deleted) also puts the edit on the clipboard, with a toast, because there is no view left to show it in.
import type { VaultEdit } from '../quorum';

export const SAVE_AFTER = 800;
type SaveResult = { hash: string } | { conflict: true } | { error: string };
export type EditApi = {
  load: (open: boolean) => Promise<VaultEdit | null>;
  save: (p: { hash: string; body: string }) => Promise<SaveResult>;
  copy: (text: string) => Promise<unknown>;
  toast: (text: string) => void;
};
export type EditView = { take: (n: VaultEdit) => void; notice: (text: string | null) => void; error: (text: string | null) => void; saved: (body: string) => void };

export function createEditSession(api: EditApi, view: EditView) {
  // base is the body as opened, which a rich save splices into; saved is the body the file on disk has (its hash)
  const s = { hash: '', base: '', saved: '', body: '', inflight: null as Promise<void> | null, timer: undefined as ReturnType<typeof setTimeout> | undefined, gone: false };
  const copied = (text: string) => api.copy(text).then(() => true, () => false);
  const kept = (ok: boolean) => (ok ? 'Your edit is on the clipboard.' : "Quorum couldn't copy your edit to the clipboard.");

  function take(n: VaultEdit) {
    clearTimeout(s.timer);
    Object.assign(s, { hash: n.hash, base: n.body, saved: n.body, body: n.body });
    view.take(n);
  }

  // what wasn't saved goes to the clipboard, then the note opens again as it is on disk now
  async function reload() {
    const unsaved = s.body !== s.saved;
    const ok = unsaved && (await copied(s.body));
    if (s.gone) { if (unsaved) api.toast(`A note changed on disk before your last edit saved. ${kept(ok)}`); return; }
    const n = await api.load(true);
    if (!n) { view.error(unsaved ? `This note was moved or deleted. ${kept(ok)}` : 'This note was moved or deleted.'); return; }
    take(n);
    view.notice(unsaved ? `This note changed on disk, so it reloaded. ${ok ? 'Your unsaved edit is on the clipboard.' : "Quorum couldn't copy your unsaved edit to the clipboard."}` : null);
  }

  async function failed(message: string) {
    if (!s.gone) { view.error(message); return; }
    if (s.body !== s.saved) api.toast(`${message} ${kept(await copied(s.body))}`);
  }

  // one save at a time; a save asked for while one runs waits for it, then saves the latest text if it still differs
  async function save(): Promise<void> {
    while (s.inflight) await s.inflight;
    if (!s.hash || s.body === s.saved) return;
    const text = s.body;
    const run = (async () => {
      try {
        const r = await api.save({ hash: s.hash, body: text });
        if ('hash' in r) { s.hash = r.hash; s.saved = text; if (!s.gone) view.error(null); view.saved(text); }
        else if ('conflict' in r) await reload();
        else await failed(r.error);
      } catch (e) { await failed(`Couldn't save: ${String(e).replace(/^.*Error:\s*/, '')}`); }
    })();
    s.inflight = run;
    await run;
    if (s.inflight === run) s.inflight = null;
  }

  function edit(md: string) {
    s.body = md;
    view.notice(null);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => void save(), SAVE_AFTER);
  }

  // a change on disk to this note that isn't this session's own save reloads it
  async function changed() {
    if (!s.hash) return;
    while (s.inflight) await s.inflight;
    const n = await api.load(false).catch(() => null);
    if (n && n.hash !== s.hash && !s.gone) await reload();
  }

  // the view closed: save what's left (md is the rich editor's latest markdown, when it has one)
  function close(md?: string) {
    if (md !== undefined) s.body = md;
    clearTimeout(s.timer);
    s.gone = true;
    return save();
  }

  return { state: s, take, edit, save, reload, changed, close };
}
