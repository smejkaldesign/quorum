// models sometimes wrap JSON in prose or add a second block; take the first complete object
export function extractJson(raw) {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('no JSON in model reply');
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(raw.slice(start, i + 1));
  }
  throw new Error('unterminated JSON in model reply');
}
