// the passkey session token for this tab: written by the passkey sign-in, read by every request to the project
// (as the x-quorum-passkey header) and by the relay calls. sessionStorage, so closing the tab ends it.
const KEY = 'quorum-admin-passkey';

export const token = {
  get(): string | null {
    try {
      const raw = sessionStorage.getItem(KEY);
      if (!raw) return null;
      const { t, exp } = JSON.parse(raw) as { t: string; exp: string };
      if (new Date(exp).getTime() <= Date.now()) { sessionStorage.removeItem(KEY); return null; }
      return t;
    } catch { return null; }
  },
  set(t: string, exp: string) { try { sessionStorage.setItem(KEY, JSON.stringify({ t, exp })); } catch {} },
  clear() { try { sessionStorage.removeItem(KEY); } catch {} },
};
