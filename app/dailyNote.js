// Today's daily note, the way Obsidian's Daily notes plugin names it: the folder, file name format and template come
// from .obsidian/daily-notes.json when it sets them, else the 01-daily folder and YYYY-MM-DD. The format uses Moment's
// tokens (the ones daily note names use), and [text] in it is kept as written.

export const DAILY_FOLDER = '01-daily';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TOKENS = {
  YYYY: (d) => String(d.getFullYear()), YY: (d) => pad(d.getFullYear() % 100),
  MMMM: (d) => MONTHS[d.getMonth()], MMM: (d) => MONTHS[d.getMonth()].slice(0, 3), MM: (d) => pad(d.getMonth() + 1), M: (d) => String(d.getMonth() + 1),
  DD: (d) => pad(d.getDate()), D: (d) => String(d.getDate()),
  dddd: (d) => DAYS[d.getDay()], ddd: (d) => DAYS[d.getDay()].slice(0, 3),
  HH: (d) => pad(d.getHours()), mm: (d) => pad(d.getMinutes()),
};
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|mm/g;
export const formatDate = (d, fmt) => fmt.replace(TOKEN, (t, lit) => (lit !== undefined ? lit : TOKENS[t](d)));

export function dailyConfig(text) {
  let c;
  try { c = text ? JSON.parse(String(text)) : {}; } catch { c = {}; }
  const clean = (v) => (typeof v === 'string' ? v.trim().replace(/^\/+|\/+$/g, '') : '');
  return { folder: clean(c?.folder) || DAILY_FOLDER, format: (typeof c?.format === 'string' && c.format.trim()) || 'YYYY-MM-DD', template: clean(c?.template) };
}

// the note's path in the vault for a day; a format with slashes makes folders, as in Obsidian
export const dailyPath = (config, d) => `${config.folder}/${formatDate(d, config.format)}.md`;
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
