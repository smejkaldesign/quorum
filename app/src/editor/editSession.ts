// One open note's edits in Knowledge (VaultEditor.tsx), apart from React so the save and reload rules can be tested.
// Edits save on a short pause, one save at a time, and each save names the hash of the file it was made from. When the
// file changes on disk under it, the note opens again as it is now; an edit that wasn't saved yet goes to the clipboard
// first and the message says so. The note's frontmatter (the Properties rows) saves the same way, at once when the
// panel commits it. After the view closes, a last save that fails (a conflict, or the note was moved or
// deleted) also puts the edit on the clipboard, with a toast, because there is no view left to show it in.
import type { VaultEdit } from '../quorum';

export const SAVE_AFTER = 800;
type SaveResult = { hash: string; frontmatter?: string; propsError?: string } | { conflict: true } | { error: string };
export type EditApi = {
  load: (open: boolean) => Promise<VaultEdit | null>;
  save: (p: { hash: string; body?: string; frontmatter?: string }) => Promise<SaveResult>;
  copy: (text: string) => Promise<unknown>;
  toast: (text: string) => void;
};
// props, after a save: the frontmatter the panel shows now (null keeps what it shows) and why the rows sent were turned
// down, or null
export type EditView = { take: (n: VaultEdit) => void; notice: (text: string | null) => void; error: (text: string | null) => void; saved: (body: string) => void; props: (fm: string | null, problem: string | null) => void };

export function createEditSession(api: EditApi, view: EditView) {
  // base is the body as opened, which a rich save splices into; saved and savedFm are what the file on disk has (its
  // hash); body and fm are the latest edits
  const s = { hash: '', base: '', saved: '', body: '', savedFm: '', fm: '', inflight: null as Promise<void> | null, timer: undefined as ReturnType<typeof setTimeout> | undefined, gone: false };
  const copied = (text: string) => api.copy(text).then(() => true, () => false);
  const kept = (ok: boolean) => (ok ? 'Your edit is on the clipboard.' : "Quorum couldn't copy your edit to the clipboard.");

  function take(n: VaultEdit) {
    clearTimeout(s.timer);
    Object.assign(s, { hash: n.hash, base: n.body, saved: n.body, body: n.body, savedFm: n.frontmatter, fm: n.frontmatter });
    view.take(n);
  }

  // what wasn't saved goes to the clipboard, then the note opens again as it is on disk now
  const unsaved = () => s.body !== s.saved || s.fm !== s.savedFm;
  const pending = () => `${s.fm !== s.savedFm ? s.fm : ''}${s.body}`;
  async function reload() {
    const was = unsaved();
    const ok = was && (await copied(pending()));
    if (s.gone) { if (was) api.toast(`A note changed on disk before your last edit saved. ${kept(ok)}`); return; }
    const n = await api.load(true);
    if (!n) { view.error(was ? `This note was moved or deleted. ${kept(ok)}` : 'This note was moved or deleted.'); return; }
    take(n);
    view.notice(was ? `This note changed on disk, so it reloaded. ${ok ? 'Your unsaved edit is on the clipboard.' : "Quorum couldn't copy your unsaved edit to the clipboard."}` : null);
  }

  async function failed(message: string) {
    if (!s.gone) { view.error(message); return; }
    if (unsaved()) api.toast(`${message} ${kept(await copied(pending()))}`);
  }

  // one save at a time; a save asked for while one runs waits for it, then saves the latest text if it still differs
  async function save(): Promise<void> {
    while (s.inflight) await s.inflight;
    if (!s.hash || !unsaved()) return;
    const text = s.body, props = s.fm;
    const run = (async () => {
      try {
        const r = await api.save({ hash: s.hash, ...(text !== s.saved ? { body: text } : {}), ...(props !== s.savedFm ? { frontmatter: props } : {}) });
        if ('hash' in r) {
          const fm = r.frontmatter ?? props;
          Object.assign(s, { hash: r.hash, saved: text, savedFm: fm });
          // properties that were turned down stay in the panel with the reason, and are not sent again until edited
          if (s.fm === props) s.fm = fm;
          if (!s.gone) { view.error(null); view.props(!r.propsError && s.fm === fm ? fm : null, r.propsError ?? null); }
          view.saved(text);
        }
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

  // the Properties panel commits on ⌘↵ or blur, so its change goes out at once
  function editProps(fm: string) {
    s.fm = fm;
    clearTimeout(s.timer);
    return save();
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

  return { state: s, take, edit, editProps, save, reload, changed, close };
}
