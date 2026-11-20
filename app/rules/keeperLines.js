// Learned facts an earlier version of the keeper wrote into files the person keeps: the copy or pointer it kept in
// CLAUDE.md, a list in CLAUDE.md or AGENTS.md, or a note picked in Settings with Edit vault notes on. The keeper now
// writes only files Quorum owns (keeper.js), so it never takes these out on its own. One finding per file: Approve
// moves the lines the facts file does not hold yet into it and takes the marked block out of the file, with versions
// and Undo (the movefacts step, memorySetup.js). The rest of the file stays as it is. Archive leaves the block where it
// is. A file that starts with the facts file's header is Quorum's own, and the keeper moves its list by itself.
import { LEARNED_HEADER, QUORUM_FOLDER, FACTS_NAME, blockAt, learnedLines } from '../cli/learned.mjs';
import { finding, plural, quote, skipped } from './common.js';

export const rule = { id: 'note.keeper-lines', version: 1, label: 'Learned facts Quorum wrote into your files' };

// learned: the facts file, vault-relative (main.js memoryCond, keeper.js factsFile)
export function run({ notes, learned = null }) {
  const to = learned ?? `${QUORUM_FOLDER}/${FACTS_NAME}`;
  const target = notes.find((n) => n.rel === to) ?? null;
  // a note at the facts file's path that the person made: Quorum writes no facts there, so there is nothing to move into
  const blocked = target != null && !target.text.startsWith(LEARNED_HEADER);
  const out = [];
  for (const n of notes) {
    if (n.rel === to || skipped(n) || n.text.startsWith(LEARNED_HEADER) || !blockAt(n.text)) continue;
    const lines = learnedLines(n.text);
    const what = lines.length ? plural(lines.length, 'learned fact') : 'a note about the learned facts';
    out.push(finding(rule, {
      key: n.rel, target: n.rel, notes: target ? [n.rel, to] : [n.rel],
      title: `${quote(n.rel)} holds ${what} Quorum wrote`,
      problem: `An earlier version of Quorum wrote ${what} into ${quote(n.rel)}, between its quorum:learned markers. Quorum now keeps them only in ${quote(to)}, which agents read through the Quorum MCP server.`,
      proposal: blocked
        ? `${quote(to)} is a note of yours, so Quorum cannot move the facts there. Pick another Quorum folder in Settings, Memory, or remove the block by hand.`
        : `Move the facts ${quote(to)} does not hold yet into it, then take the marked block out of ${quote(n.rel)}. Nothing else in the file changes.`,
      evidence: lines.slice(0, 5).map((l) => l.slice(2)),
      meta: [['File', n.rel], ['Facts file', to]],
      ...(blocked ? {} : { fix: { kind: 'ops', group: 'movefacts', ops: [{ op: 'movefacts', rel: n.rel, to }] } }),
    }));
  }
  return out;
}
