// A read-only view of the memory graph's database (graph/store.js) for the memory engine's utility process: the review
// rules read it through rules/entities.js ruleGraph. It opens the file read-only, so it never creates the database or
// changes its schema; the store in main owns every write. Answers null while the file is missing.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// graph/store.js vaultHash: the folder of a vault's database under DATA_DIR/memory
export const graphFile = (dataDir, vault) => path.join(dataDir, 'memory', createHash('sha256').update(path.resolve(vault)).digest('hex').slice(0, 16), 'memory.db');
const json = (t) => { try { return t ? JSON.parse(t) : {}; } catch { return {}; } };
const edge = (r) => ({ ...r, props: json(r.props) });
const node = (r) => (r ? { ...r, props: json(r.props) } : null);

export function openGraphView({ dataDir, vault }) {
  const file = graphFile(dataDir, vault);
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  const q = (sql) => db.prepare(sql);
  const s = {
    node: q('select * from nodes where id = ?'),
    byKind: q('select * from nodes where kind = ?'),
    byRel: q('select * from nodes where rel = ?'),
    aliases: q('select alias from aliases where node = ? order by alias'),
    out: q('select * from edges where src = ?'),
    in: q('select * from edges where dst = ?'),
    bySource: q("select * from edges where source_rel = ? and provenance != 'person'"),
  };
  const current = (e) => e.valid_to == null && e.superseded_by == null;
  return {
    node: (id) => node(s.node.get(id)),
    nodes: ({ kind }) => s.byKind.all(kind).map(node),
    nodesByRel: (rel) => s.byRel.all(rel).map(node),
    aliasesOf: (id) => s.aliases.all(id).map((r) => r.alias),
    edgesOf: (id, { dir = 'both', kinds = null, current: cur = true } = {}) => {
      const rows = dir === 'out' ? s.out.all(id) : dir === 'in' ? s.in.all(id) : [...s.out.all(id), ...s.in.all(id).filter((e) => e.src !== id)];
      return rows.filter((e) => (!kinds || kinds.includes(e.kind)) && (!cur || current(e))).map(edge);
    },
    edgesBySource: (rel) => s.bySource.all(rel).map(edge),
    close: () => db.close(),
  };
}
