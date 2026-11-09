// the recognizer's vocabulary for one capture: names and terms the on-device model would otherwise spell by ear.
// Sources arrive in priority order (the people on this call first, the vault's regulars last) so the cap keeps the
// most relevant ones. Apple keeps a context list short; the cap is the ceiling, not a target
export const TERM_CAP = 300;
export const VAULT_PEOPLE = 150;
const MAX_WORDS = 4;

// words a transcriber already knows, which turn up in display names and dictionary entries ("Guest", "Phone", "iPhone 12")
const COMMON = new Set(('the a an and or of to in on at for with by from as is are was be me you we they it this that these those my your our their his her its ' +
  'guest user phone iphone ipad mac room meeting call host admin unknown anonymous participant participants someone everyone team ' +
  'mr mrs ms dr jr sr mobile home work office').split(' '));
// mail providers whose domain names nobody at the meeting works for
const MAIL_HOSTS = new Set(['gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn', 'yahoo', 'icloud', 'me', 'mac', 'aol', 'proton', 'protonmail', 'pm', 'fastmail', 'hey', 'example']);

const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\(.*?\)/g, ' ').replace(/[\s ]+/g, ' ').trim();
const keep = (t) => {
  if (t.length < 2 || !/[\p{L}]/u.test(t)) return false;
  const words = t.split(' ');
  if (words.length > MAX_WORDS || words.some((w) => w.length === 1 && !/\./.test(w))) return false;
  return !(words.length === 1 && COMMON.has(t.toLowerCase()));
};

// the organization a participant line points at: the email's domain ("jane@acme.com" -> Acme) or the tag Zoom shows ("Sam Lee (Acme)")
export function orgOf(participant) {
  const s = String(participant ?? '');
  const email = s.match(/[\w.%+-]+@([\w-]+)(?:\.[\w-]+)*\.[a-z]{2,}/i);
  if (email) { const d = email[1].toLowerCase(); return MAIL_HOSTS.has(d) ? null : d[0].toUpperCase() + d.slice(1); }
  const tag = s.match(/\(([^)]+)\)\s*$/);
  if (!tag || /^(creator|recorder)$/i.test(tag[1].trim())) return null;
  const org = tag[1].trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} .&'-]{1,60}$/u.test(org) ? org : null;
}

// the names that come up most across the saved meetings; ties keep the most recent (the index arrives newest first)
export function topNames(lists, n = VAULT_PEOPLE) {
  const count = new Map();
  for (const list of lists) for (const raw of list ?? []) { const t = clean(raw); if (t) count.set(t, (count.get(t) ?? 0) + 1); }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

export function buildTerms({ invitees = [], participants = [], dictionary = [], company = '', owner = '', vaultPeople = [], vaultOrgs = [], cap = TERM_CAP } = {}) {
  const dict = (dictionary ?? []).map((d) => d?.write);
  const out = [], seen = new Set();
  for (const raw of [...invitees, ...participants, ...dict, company, owner, ...vaultPeople, ...vaultOrgs]) {
    const t = clean(raw);
    const key = t.toLowerCase();
    if (!keep(t) || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}
