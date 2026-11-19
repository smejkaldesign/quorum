// Today's daily note, the way Obsidian's Daily notes plugin names it: the folder, file name format and template come
// from .obsidian/daily-notes.json. With that file, an empty folder is the vault root, as in Obsidian; with no file, the
// 01-daily folder. The format uses Moment's tokens in its default English locale. [text], and a token after a
// backslash, are kept as written. A format with a Moment token this module doesn't know is refused, so a wrong file
// name is never made.

export const DAILY_FOLDER = '01-daily';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Moment's English ordinal: 1st 2nd 3rd 4th, 11th 12th 13th, 21st
const ordinal = (n) => { const b = n % 10; return `${n}${Math.floor((n % 100) / 10) === 1 ? 'th' : b === 1 ? 'st' : b === 2 ? 'nd' : b === 3 ? 'rd' : 'th'}`; };
const dayOfYear = (d) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 1)) / 864e5) + 1;
const daysIn = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
// Moment's week of the year: weeks start on dow (0 Sunday), and week 1 holds January (7 + dow - doy). The English locale
// is dow 0, doy 6 (the week with January 1st); ISO is dow 1, doy 4 (the week with January 4th)
const firstWeekOffset = (y, dow, doy) => { const fwd = 7 + dow - doy; return -((7 + new Date(Date.UTC(y, 0, fwd)).getUTCDay() - dow) % 7) + fwd - 1; };
const weeksIn = (y, dow, doy) => (daysIn(y) - firstWeekOffset(y, dow, doy) + firstWeekOffset(y + 1, dow, doy)) / 7;
function weekOf(d, dow, doy) {
  const y = d.getFullYear();
  const week = Math.floor((dayOfYear(d) - firstWeekOffset(y, dow, doy) - 1) / 7) + 1;
  if (week < 1) return { week: week + weeksIn(y - 1, dow, doy), year: y - 1 };
  if (week > weeksIn(y, dow, doy)) return { week: week - weeksIn(y, dow, doy), year: y + 1 };
  return { week, year: y };
}
const local = (d) => weekOf(d, 0, 6), iso = (d) => weekOf(d, 1, 4);
const hour12 = (d) => d.getHours() % 12 || 12;
const TOKENS = {
  YYYY: (d) => pad(d.getFullYear(), 4), YY: (d) => pad(d.getFullYear() % 100), Y: (d) => String(d.getFullYear()),
  Q: (d) => String(Math.floor(d.getMonth() / 3) + 1), Qo: (d) => ordinal(Math.floor(d.getMonth() / 3) + 1),
  MMMM: (d) => MONTHS[d.getMonth()], MMM: (d) => MONTHS[d.getMonth()].slice(0, 3), MM: (d) => pad(d.getMonth() + 1), M: (d) => String(d.getMonth() + 1), Mo: (d) => ordinal(d.getMonth() + 1),
  DDDD: (d) => pad(dayOfYear(d), 3), DDD: (d) => String(dayOfYear(d)), DDDo: (d) => ordinal(dayOfYear(d)),
  DD: (d) => pad(d.getDate()), D: (d) => String(d.getDate()), Do: (d) => ordinal(d.getDate()),
  dddd: (d) => DAYS[d.getDay()], ddd: (d) => DAYS[d.getDay()].slice(0, 3), dd: (d) => DAYS[d.getDay()].slice(0, 2), d: (d) => String(d.getDay()), do: (d) => ordinal(d.getDay()),
  e: (d) => String(d.getDay()), E: (d) => String(d.getDay() || 7),
  ww: (d) => pad(local(d).week), w: (d) => String(local(d).week), wo: (d) => ordinal(local(d).week),
  WW: (d) => pad(iso(d).week), W: (d) => String(iso(d).week), Wo: (d) => ordinal(iso(d).week),
  gggg: (d) => pad(local(d).year, 4), gg: (d) => pad(local(d).year % 100), GGGG: (d) => pad(iso(d).year, 4), GG: (d) => pad(iso(d).year % 100),
  HH: (d) => pad(d.getHours()), H: (d) => String(d.getHours()), hh: (d) => pad(hour12(d)), h: (d) => String(hour12(d)),
  kk: (d) => pad(d.getHours() || 24), k: (d) => String(d.getHours() || 24),
  mm: (d) => pad(d.getMinutes()), m: (d) => String(d.getMinutes()), ss: (d) => pad(d.getSeconds()), s: (d) => String(d.getSeconds()),
  A: (d) => (d.getHours() < 12 ? 'AM' : 'PM'), a: (d) => (d.getHours() < 12 ? 'am' : 'pm'),
  X: (d) => String(Math.floor(d.getTime() / 1000)), x: (d) => String(d.getTime()),
};
// Moment's own token list, longest first, so a format splits the way Moment splits it
const TOKEN = /\[([^[]*?)\]|(\\)?(Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[ow]?|W[oW]?|Qo?|N{1,5}|YYYYYY|YYYYY|YYYY|YY|y{2,4}|yo?|gg(?:ggg?)?|GG(?:GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|Y)/g;

export function formatDate(d, fmt) {
  return String(fmt).replace(TOKEN, (all, lit, esc, t) => {
    if (lit !== undefined) return lit;
    if (esc) return t;
    if (!TOKENS[t]) throw new Error(`Quorum can't name a daily note with the date format ${fmt}: it doesn't support ${t}`);
    return TOKENS[t](d);
  });
}

// text is the daily-notes.json file, or null when there is none
export function dailyConfig(text) {
  let c;
  try { c = text ? JSON.parse(String(text)) : {}; } catch { c = {}; }
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^\/+|\/+$/g, '') : '');
  return { folder: text == null ? DAILY_FOLDER : clean(c?.folder), format: (typeof c?.format === 'string' && c.format.trim()) || 'YYYY-MM-DD', template: clean(c?.template) };
}

// the note's path in the vault for a day; a format with slashes makes folders, as in Obsidian
export const dailyPath = (config, d) => `${config.folder ? `${config.folder}/` : ''}${formatDate(d, config.format)}.md`;
// the template file, which Obsidian names without its .md
export const templatePath = (config) => (config.template ? (/\.md$/i.test(config.template) ? config.template : `${config.template}.md`) : null);

// a new daily note from its template: {{date}}, {{time}} and {{title}} filled in, with an optional :format after them
export function fillTemplate(text, d, title) {
  return String(text).replace(/\{\{\s*(date|time|title)\s*(?::([^}]*))?\}\}/gi, (_, k, fmt) => {
    const key = k.toLowerCase();
    if (key === 'title') return title;
    return formatDate(d, fmt?.trim() || (key === 'date' ? 'YYYY-MM-DD' : 'HH:mm'));
  });
}
