// Rename and move without breaking links: every note that pointed at the old path gets its links rewritten,
// the way Obsidian's "Automatically update internal links" does. Only the link text changes in those files.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseNote } from './linkparse.js';

// temp file then rename, so Claude or an editor never reads half a file
export function writeAtomic(abs, text) {
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.quorum-tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
}

const noExt = (rel) => rel.replace(/\.md$/i, '');

// Obsidian's default "shortest path when possible": the bare name when it's unique, the full path when not
function wikiTarget(newRel, baseCount) {
  const base = path.posix.basename(noExt(newRel));
  return (baseCount.get(base.toLowerCase()) ?? 0) > 1 ? noExt(newRel) : base;
}

function mdTarget(newRel, oldHref, fromRel) {
  const encode = (p) => p.split('/').map(encodeURIComponent).join('/');
  // keep the link's own style: relative links stay relative to the note they're in
  if (oldHref.startsWith('.')) return encode(path.posix.relative(path.posix.dirname(fromRel), newRel) || path.posix.basename(newRel));
  return encode(newRel);
}

/**
 * mapping: Map<oldRel, newRel> for every note that moves (one for a note, many for a folder)
 * sources: rels of notes linking to any of them, from the index's backlinks, taken before the move
 * resolve: the index resolver from before the move; allRels: every note after the move
 */
export function rewriteLinks({ vault, mapping, sources, resolve, allRels, aliasesOf }) {
  const baseCount = new Map();
  for (const rel of allRels) { const b = path.posix.basename(noExt(rel)).toLowerCase(); baseCount.set(b, (baseCount.get(b) ?? 0) + 1); }
  let files = 0;
  let links = 0;
  for (const oldFrom of sources) {
    const from = mapping.get(oldFrom) ?? oldFrom;
    const abs = path.join(vault, from);
    let raw;
    try { raw = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    let changed = 0;
    for (const link of parseNote(oldFrom, raw).links) {
      const target = resolve(link.target, oldFrom);
      const to = target && mapping.get(target);
      if (!to) continue;
      // a link written as an alias or a name: slug keeps working after a move; leave it alone
      const aliases = (aliasesOf(target) ?? []).map((a) => a.toLowerCase());
      if (link.kind === 'wiki' && aliases.includes(link.target.toLowerCase())) continue;
      const anchor = link.anchor ? `#${link.anchor}` : '';
      let next;
      if (link.kind === 'wiki') {
        next = `${link.embed ? '!' : ''}[[${wikiTarget(to, baseCount)}${anchor}${link.display !== null ? `|${link.display}` : ''}]]`;
      } else {
        const href = link.raw.slice(link.raw.lastIndexOf('](') + 2, -1).replace(/#.*$/, '');
        next = `${link.embed ? '!' : ''}[${link.display}](${mdTarget(to, href, from)}${anchor})`;
      }
      if (next === link.raw) continue;
      const i = link.line;
      if (lines[i]?.includes(link.raw)) { lines[i] = lines[i].replace(link.raw, next); changed++; }
    }
    if (changed) { writeAtomic(abs, lines.join('\n')); files++; links += changed; }
  }
  return { files, links };
}

// point every link written as `target` (case-insensitive) in the given notes at an existing note instead
// add a name to a note's aliases: list, leaving the rest of the file byte-for-byte; one edit fixes every link to it
export function addAlias(abs, alias) {
  const raw = readFileSync(abs, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  let fm;
  if (!m) fm = null;
  else if (/^aliases:\s*\[(.*)\]\s*$/m.test(m[1])) fm = m[1].replace(/^aliases:\s*\[(.*)\]\s*$/m, (_l, list) => `aliases: [${list.trim() ? `${list.trim()}, ` : ''}${alias}]`);
  else if (/^aliases:\s*$/m.test(m[1])) {
    const lines = m[1].split('\n');
    let i = lines.findIndex((l) => /^aliases:\s*$/.test(l)) + 1;
    while (i < lines.length && /^\s+-\s/.test(lines[i])) i++;
    lines.splice(i, 0, `  - ${alias}`);
    fm = lines.join('\n');
  } else fm = `${m[1]}\naliases:\n  - ${alias}`;
  const next = fm === null ? `---\naliases:\n  - ${alias}\n---\n${raw}` : `---\n${fm}\n---${raw.slice(m[0].length)}`;
  writeAtomic(abs, next);
}

export function retargetLinks({ vault, sources, target, toRel, toName, allRels }) {
  const baseCount = new Map();
  for (const rel of allRels) { const b = path.posix.basename(noExt(rel)).toLowerCase(); baseCount.set(b, (baseCount.get(b) ?? 0) + 1); }
  const want = noExt(target).toLowerCase();
  // a slug-style link (lowercase-kebab) to a note that has a name: keeps the slug convention and uses its current name
  const slugStyle = /^[a-z0-9]+(-[a-z0-9]+)+$/.test(noExt(target));
  const written = slugStyle && toName ? toName : wikiTarget(toRel, baseCount);
  let files = 0;
  let links = 0;
  for (const from of sources) {
    const abs = path.join(vault, from);
    let raw;
    try { raw = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = raw.split('\n');
    let changed = 0;
    for (const link of parseNote(from, raw).links) {
      if (link.kind !== 'wiki' || noExt(link.target).toLowerCase() !== want) continue;
      const next = `${link.embed ? '!' : ''}[[${written}${link.anchor ? `#${link.anchor}` : ''}${link.display !== null ? `|${link.display}` : ''}]]`;
      if (lines[link.line]?.includes(link.raw)) { lines[link.line] = lines[link.line].replace(link.raw, next); changed++; }
    }
    if (changed) { writeAtomic(abs, lines.join('\n')); files++; links += changed; }
  }
  return { files, links };
}
