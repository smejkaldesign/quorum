// How far ahead Up next reads the calendar. A number is that many days. 'week' is the work week: Monday to Friday it
// runs from now to the end of Friday; on Saturday and Sunday it is the coming Monday to Friday.
export function calendarWindow(days, now = new Date()) {
  if (days !== 'week') return { days: Math.min(5, Math.max(1, Number(days) || 1)), from: null, until: null };
  const dow = now.getDay(); // 0 Sunday .. 6 Saturday
  const day = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  // until is the Saturday after the week's Friday, at midnight
  if (dow >= 1 && dow <= 5) return { days: 5 - dow, from: null, until: day(6 - dow) };
  const toMonday = dow === 6 ? 2 : 1;
  return { days: toMonday + 4, from: day(toMonday), until: day(toMonday + 5) };
}

export const normalizeDays = (d) => (d === 'week' ? 'week' : Math.min(5, Math.max(1, Number(d) || 1)));
