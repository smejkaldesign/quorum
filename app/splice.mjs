// Save an edited note without reformatting the rest of it: blocks you didn't touch keep their exact original
// text, and only edited blocks are written out by the editor. Returns null when the mapping isn't safe,
// and the caller falls back to source mode for that note.
import { marked } from 'marked';

export function createSplicer(md) {
  const blocksOf = (doc) => (doc.content ?? []).map((n) => md.serialize({ type: 'doc', content: [n] }));

  // the original text cut into top-level blocks, each carrying the blank lines that follow it
  function rawBlocks(body) {
    const tokens = marked.lexer(body);
    const lead = [];
    const blocks = [];
    for (const t of tokens) {
      if (t.type === 'space') { if (blocks.length) blocks[blocks.length - 1].gap += t.raw; else lead.push(t.raw); continue; }
      blocks.push({ raw: t.raw, gap: '' });
    }
    return { lead: lead.join(''), blocks };
  }

  return function splice(original, newDoc) {
    const oldDoc = md.parse(original);
    const oldB = blocksOf(oldDoc);
    const { lead, blocks } = rawBlocks(original);
    if (blocks.length !== oldB.length) return null;
    const newB = blocksOf(newDoc);
    // longest common subsequence of block text decides which blocks survived untouched
    const n = oldB.length, m = newB.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = oldB[i] === newB[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let out = lead;
    let i = 0, j = 0;
    while (j < m) {
      if (i < n && oldB[i] === newB[j]) { out += blocks[i].raw + blocks[i].gap; i++; j++; }
      else if (i < n && L[i + 1][j] >= L[i][j + 1]) i++;
      else { out += `${newB[j].replace(/\n+$/, '')}\n\n`; j++; }
    }
    if (!out.endsWith('\n') && original.endsWith('\n')) out += '\n';
    return out;
  };
}
