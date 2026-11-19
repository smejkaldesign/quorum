// Pairs the notes one watcher burst removed with the notes it added, so a note moved outside the app (Finder, git,
// another editor) gets its links rewritten like an in-app move. A pair needs the same text and the same size. A text
// that more than one removed note or more than one added note shares is ambiguous and pairs nothing, and a blank note
// never pairs, since two empty notes say nothing about which one became the other.
// gone and added: [{ rel, text, size }], rels relative to the vault
export function pairMoves(gone, added) {
  const group = (list) => {
    const out = new Map();
    for (const n of list) {
      if (!n?.rel || !n.rel.endsWith('.md') || typeof n.text !== 'string' || !n.text.trim()) continue;
      const key = `${n.size}:${n.text}`;
      (out.get(key) ?? out.set(key, []).get(key)).push(n.rel);
    }
    return out;
  };
  const from = group(gone);
  const to = group(added);
  const moves = [];
  for (const [key, olds] of from) {
    const news = to.get(key);
    if (olds.length === 1 && news?.length === 1 && olds[0] !== news[0]) moves.push({ from: olds[0], to: news[0] });
  }
  return moves;
}
