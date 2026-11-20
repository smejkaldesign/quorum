// The memory graph's SQLite store: one database per vault in app data, derived from the vault and rebuilt from it at
// any time. Search keeps its own tables in the same file (db() hands it the connection).
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 2;
export const NODE_KINDS = ['note', 'person', 'project', 'company', 'meeting', 'decision', 'topic', 'tag', 'folder'];
export const EDGE_KINDS = ['links_to', 'embeds', 'mentions', 'attended', 'works_on', 'member_of', 'decided_in', 'decision_about', 'about', 'tagged', 'in_folder', 'contradicts', 'supersedes'];
export const PROVENANCE = ['explicit', 'rule', 'model', 'person'];
// a node of these kinds is its note: it goes when the note goes. A person or project outlives its note as a gap
export const NOTE_IDENTITY = new Set(['note', 'meeting', 'decision']);

export const vaultHash = (vault) => createHash('sha256').update(path.resolve(vault)).digest('hex').slice(0, 16);
// the database file for a vault under a memory folder (DATA_DIR/memory)
export const storeFile = (dir, vault) => path.join(dir, vaultHash(vault), 'memory.db');
export const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

// a rebuild drops the model pass's read marks with the edges it wrote, so it reads those notes again; model_proposals
// stays, so a connection the person approved or declined keeps that answer
const TABLES = ['files', 'nodes', 'aliases', 'edges', 'communities', 'model_files'];
export const PROPOSAL_STATUS = ['pending', 'approved', 'declined'];
const SCHEMA = `
create table if not exists meta(key text primary key, value text);
create table if not exists files(rel text primary key, hash text, mtime real, size int, indexed_at real);
create table if not exists nodes(id text primary key, kind text not null, name text, rel text, props text, created_at real, updated_at real);
create index if not exists nodes_by_rel on nodes(rel);
create index if not exists nodes_by_name on nodes(name collate nocase);
create table if not exists aliases(node text, alias text, primary key(node, alias));
create index if not exists aliases_by_alias on aliases(alias);
create table if not exists edges(id integer primary key, src text not null, dst text not null, kind text not null, provenance text not null, source_rel text, source_line int, confidence real, valid_from real, valid_to real, superseded_by integer, recorded_at real, props text);
create index if not exists edges_by_src on edges(src, kind);
create index if not exists edges_by_dst on edges(dst, kind);
create index if not exists edges_by_kind on edges(kind);
create index if not exists edges_by_source on edges(source_rel);
create table if not exists communities(node text primary key, community text, rank real);
create table if not exists model_files(rel text primary key, hash text, read_at real, tokens int);
create table if not exists model_proposals(id integer primary key, key text unique not null, rel text, line int, kind text, src text, dst text, confidence real, props text, status text not null, edges text, recorded_at real, decided_at real);
create index if not exists model_proposals_by_rel on model_proposals(rel, status);
`;

const parse = (s) => { if (!s) return {}; try { return JSON.parse(s); } catch { return {}; } };
const nodeRow = (r) => (r ? { id: r.id, kind: r.kind, name: r.name, rel: r.rel, props: parse(r.props), created_at: r.created_at, updated_at: r.updated_at } : null);
const edgeRow = (r) => (r ? { ...r, props: parse(r.props) } : null);
const proposalRow = (r) => (r ? { ...r, props: parse(r.props), edges: r.edges ? JSON.parse(r.edges) : null } : null);

export function openStore({ dir, vault, log = () => {}, now = Date.now, readOnly = false }) {
  const file = storeFile(dir, vault);
  if (!readOnly) mkdirSync(path.dirname(file), { recursive: true });
  // a reader (the memory engine's utility process) opens what the main process built and never writes or migrates
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  if (readOnly) {
    let v = null;
    try { v = db.prepare("select value from meta where key = 'graph_schema'").get()?.value; } catch { /* no tables yet */ }
    if (v !== String(SCHEMA_VERSION)) { db.close(); throw new Error('memory graph not built'); }
  } else {
    db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = off;');
    db.exec('create table if not exists meta(key text primary key, value text)');
    const version = db.prepare("select value from meta where key = 'graph_schema'").get()?.value;
    if (version !== String(SCHEMA_VERSION)) {
      // a new schema reads the vault again: only the graph's own tables go, search keeps its own
      if (version) log('memory graph', `schema ${version} -> ${SCHEMA_VERSION}, rebuilding`);
      for (const t of TABLES) db.exec(`drop table if exists ${t}`);
    }
    db.exec(SCHEMA);
    db.prepare("insert or replace into meta(key, value) values ('graph_schema', ?)").run(String(SCHEMA_VERSION));
  }

  const q = (sql) => db.prepare(sql);
  const s = {
    getFile: q('select hash from files where rel = ?'),
    allFiles: q('select rel, hash from files'),
    putFile: q('insert into files(rel, hash, mtime, size, indexed_at) values (?, ?, ?, ?, ?) on conflict(rel) do update set hash = excluded.hash, mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at'),
    delFile: q('delete from files where rel = ?'),
    getNode: q('select * from nodes where id = ?'),
    nodesByRel: q('select * from nodes where rel = ?'),
    insNode: q('insert into nodes(id, kind, name, rel, props, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)'),
    updNode: q('update nodes set kind = ?, name = ?, rel = ?, props = ?, updated_at = ? where id = ?'),
    unback: q('update nodes set rel = null, updated_at = ? where id = ?'),
    delNode: q('delete from nodes where id = ?'),
    delAliases: q('delete from aliases where node = ?'),
    addAlias: q('insert or ignore into aliases(node, alias) values (?, ?)'),
    aliasesOf: q('select alias from aliases where node = ? order by alias'),
    insEdge: q('insert into edges(src, dst, kind, provenance, source_rel, source_line, confidence, valid_from, valid_to, superseded_by, recorded_at, props) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)'),
    getEdge: q('select * from edges where id = ?'),
    delEdge: q('delete from edges where id = ?'),
    // a supersedes edge records one supersession (props.old superseded by props.new) and lasts as long as both edges
    delPairEdges: q("delete from edges where kind = 'supersedes' and json_extract(props, '$.by') = 'supersession' and (json_extract(props, '$.old') = ? or json_extract(props, '$.new') = ?)"),
    pairEdge: q("select id from edges where kind = 'supersedes' and src = ? and dst = ? and json_extract(props, '$.by') = 'supersession' limit 1"),
    supersede: q('update edges set valid_to = ?, superseded_by = ? where id = ?'),
    restore: q('update edges set valid_to = null, superseded_by = null where superseded_by = ?'),
    bySource: q("select * from edges where source_rel = ? and provenance != 'person'"),
    touching: q('select * from edges where src = ? or dst = ?'),
    degree: q('select (select count(*) from edges where src = ?1) + (select count(*) from edges where dst = ?1) as n'),
    findName: q('select * from nodes where name = ? collate nocase'),
    findAlias: q('select n.* from aliases a join nodes n on n.id = a.node where a.alias = ?'),
    findPrefix: q("select * from nodes where name like ? escape '\\' collate nocase order by length(name) limit 25"),
    findAliasPrefix: q("select n.* from aliases a join nodes n on n.id = a.node where a.alias like ? escape '\\' order by length(a.alias) limit 25"),
    community: q('select community, rank from communities where node = ?'),
    renameNode: q('update nodes set id = ?, rel = ?, updated_at = ? where id = ?'),
    setRel: q('update nodes set rel = ?, updated_at = ? where id = ?'),
    moveAliases: q('insert or ignore into aliases(node, alias) select ?, alias from aliases where node = ?'),
    renameSrc: q('update edges set src = ? where src = ?'),
    renameDst: q('update edges set dst = ? where dst = ?'),
    renameCommunity: q('update or replace communities set node = ? where node = ?'),
    moveSource: q('update edges set source_rel = ? where source_rel = ?'),
    moveFileRow: q('update files set rel = ? where rel = ?'),
    count: (t) => q(`select count(*) as n from ${t}`),
  };
  // the model pass (memoryModelPass.js): which notes it read at which hash, and the connections it proposed that wait
  // for a person. Prepared on first use, so a reader that never asks for them works on a database built before them
  const mq = new Map();
  const m = (sql) => mq.get(sql) ?? mq.set(sql, db.prepare(sql)).get(sql);
  const counts = { files: s.count('files'), nodes: s.count('nodes'), edges: s.count('edges') };
  const nodeKinds = q('select kind, count(*) as n from nodes group by kind');
  const edgeKinds = q('select kind, count(*) as n from edges where superseded_by is null group by kind');

  // a nested call is a savepoint: when it throws, only its own writes roll back and the outer transaction goes on
  let depth = 0;
  function tx(fn) {
    const sp = depth ? `sp${depth}` : null;
    db.exec(sp ? `savepoint ${sp}` : 'begin');
    depth++;
    try { const r = fn(); depth--; db.exec(sp ? `release ${sp}` : 'commit'); return r; } catch (err) {
      depth--;
      if (sp) { db.exec(`rollback to ${sp}`); db.exec(`release ${sp}`); } else db.exec('rollback');
      throw err;
    }
  }

  function upsertNode({ id, kind, name, rel = null, props = {} }) {
    const t = now();
    const cur = s.getNode.get(id);
    if (!cur) { s.insNode.run(id, kind, name ?? id, rel, JSON.stringify(props ?? {}), t, t); return; }
    // a mention never overwrites the note that backs a node: only a backed upsert, or one onto an unbacked node, writes
    if (cur.rel && !rel) return;
    s.updNode.run(kind, name ?? cur.name, rel, JSON.stringify(props ?? {}), t, id);
  }

  function setAliases(id, names) {
    s.delAliases.run(id);
    for (const a of new Set(names.map(norm).filter(Boolean))) s.addAlias.run(id, a);
  }

  function addEdge({ src, dst, kind, provenance, source_rel = null, source_line = null, confidence = 1, valid_from = null, valid_to = null, props = null }) {
    const r = s.insEdge.run(src, dst, kind, provenance, source_rel, source_line, confidence, valid_from, valid_to, now(), props ? JSON.stringify(props) : null);
    return Number(r.lastInsertRowid);
  }

  // an edge that goes takes its supersessions with it: what it replaced holds again, and the supersedes edge written
  // for that pair goes too
  function removeEdge(id) { s.restore.run(id); s.delPairEdges.run(id, id); s.delEdge.run(id); }

  // nodes no note backs and no edge reaches are gone; a note-identity node needs its note
  function prune(ids) {
    for (const id of ids) {
      const n = s.getNode.get(id);
      if (!n || n.rel) continue;
      if (NOTE_IDENTITY.has(n.kind) || !s.degree.get(id).n) { s.delNode.run(id); s.delAliases.run(id); }
    }
  }

  function dropNode(id) {
    const touched = new Set();
    for (const e of s.touching.all(id, id)) { touched.add(e.src); touched.add(e.dst); removeEdge(e.id); }
    s.delNode.run(id);
    s.delAliases.run(id);
    touched.delete(id);
    return touched;
  }

  // forget everything a note said: its derived edges, the nodes that are the note, and the backing of an entity
  function removeFile(rel, { keepFile = false } = {}) {
    return tx(() => {
      const touched = new Set();
      for (const e of s.bySource.all(rel)) { touched.add(e.src); touched.add(e.dst); removeEdge(e.id); }
      for (const n of s.nodesByRel.all(rel)) {
        if (NOTE_IDENTITY.has(n.kind)) for (const t of dropNode(n.id)) touched.add(t);
        else { s.unback.run(now(), n.id); setAliases(n.id, [n.name]); touched.add(n.id); }
      }
      if (!keepFile) s.delFile.run(rel);
      prune(touched);
      return touched;
    });
  }

  // a note moved with the same text: its nodes and every edge keep their history under the new path. A node whose new
  // id is already taken (a mention of the new name) is merged into it
  function moveFile(from, to, idFor) {
    tx(() => {
      const t = now();
      for (const n of s.nodesByRel.all(from)) {
        const id = idFor(n, to);
        if (id !== n.id) {
          if (s.getNode.get(id)) s.delNode.run(id);
          s.renameNode.run(id, to, t, n.id);
          s.moveAliases.run(id, n.id);
          s.delAliases.run(n.id);
          s.renameSrc.run(id, n.id);
          s.renameDst.run(id, n.id);
          s.renameCommunity.run(id, n.id);
        } else s.setRel.run(to, t, n.id);
      }
      s.moveSource.run(to, from);
      s.delFile.run(to);
      s.moveFileRow.run(to, from);
    });
  }

  // one prepared statement per shape (direction, number of kinds, current), kept: a walk calls this thousands of times
  const edgeStmts = new Map();
  function edgesOf(id, { dir = 'both', kinds = null, current = true } = {}) {
    const key = `${dir}|${kinds?.length ?? 0}|${current ? 1 : 0}`;
    let st = edgeStmts.get(key);
    if (!st) {
      const where = [dir === 'out' ? 'src = ?' : dir === 'in' ? 'dst = ?' : '(src = ? or dst = ?)'];
      if (kinds?.length) where.push(`kind in (${kinds.map(() => '?').join(',')})`);
      if (current) where.push('superseded_by is null');
      st = db.prepare(`select * from edges where ${where.join(' and ')} order by id`);
      edgeStmts.set(key, st);
    }
    const args = dir === 'out' || dir === 'in' ? [id] : [id, id];
    if (kinds?.length) args.push(...kinds);
    return st.all(...args).map(edgeRow);
  }

  // exact name, then alias, then prefix; every match comes back so a caller can refuse to guess. A note node whose rel
  // backs a matched entity is the same thing twice, so only the entity stays. A prefix needs 3 characters, and its
  // matches come back with prefix: true (candidates, never an answer); prefix: false skips that step
  function find(name, { kind = null, prefix = true } = {}) {
    const n = norm(name);
    if (!n) return [];
    const kinds = kind ? new Set([].concat(kind)) : null;
    const keep = (rows) => {
      let out = [...new Map(rows.map((r) => [r.id, nodeRow(r)])).values()];
      if (kinds) out = out.filter((r) => kinds.has(r.kind));
      const backed = new Set(out.filter((r) => r.kind !== 'note' && r.rel).map((r) => r.rel));
      return out.filter((r) => !(r.kind === 'note' && backed.has(r.rel)));
    };
    const like = `${n.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    for (const rows of [() => s.findName.all(n), () => s.findAlias.all(n)]) {
      const hit = keep(rows());
      if (hit.length) return hit;
    }
    if (!prefix || n.length < 3) return [];
    return keep([...s.findPrefix.all(like), ...s.findAliasPrefix.all(like)]).map((r) => ({ ...r, prefix: true }));
  }

  function stats() {
    return {
      files: counts.files.get().n, nodes: counts.nodes.get().n, edges: counts.edges.get().n,
      byKind: { nodes: Object.fromEntries(nodeKinds.all().map((r) => [r.kind, r.n])), edges: Object.fromEntries(edgeKinds.all().map((r) => [r.kind, r.n])) },
    };
  }

  return {
    path: file,
    db: () => db,
    tx,
    upsertFile: ({ rel, hash, mtime = null, size = null }) => { s.putFile.run(rel, hash, mtime, size, now()); },
    fileHash: (rel) => s.getFile.get(rel)?.hash ?? null,
    files: () => new Map(s.allFiles.all().map((r) => [r.rel, r.hash])),
    removeFile,
    moveFile,
    upsertNode,
    setAliases,
    addAliases: (id, names) => { for (const a of new Set(names.map(norm).filter(Boolean))) s.addAlias.run(id, a); },
    unback: (id) => { const n = s.getNode.get(id); s.unback.run(now(), id); setAliases(id, [n?.name]); },
    aliasesOf: (id) => s.aliasesOf.all(id).map((r) => r.alias),
    nodesByRel: (rel) => s.nodesByRel.all(rel).map(nodeRow),
    dropNode,
    prune,
    addEdge,
    edge: (id) => edgeRow(s.getEdge.get(id)),
    removeEdge,
    // the supersedes edge for one supersession, once: src is the newer decision, dst the older one
    addSupersedes: ({ src, dst, old, by, source_rel = null, source_line = null, valid_from = null }) => {
      if (s.pairEdge.get(src, dst)) return null;
      return addEdge({ src, dst, kind: 'supersedes', provenance: 'rule', source_rel, source_line, valid_from, props: { by: 'supersession', old, new: by } });
    },
    edgesBySource: (rel) => s.bySource.all(rel).map(edgeRow),
    updateEdge: (id, { source_line = null, confidence = 1, valid_from = null, props = null }) => { db.prepare('update edges set source_line = ?, confidence = ?, valid_from = ?, props = ? where id = ?').run(source_line, confidence, valid_from, props ? JSON.stringify(props) : null, id); },
    supersede: (edgeId, byEdgeId, at = now()) => { s.supersede.run(at, byEdgeId, edgeId); },
    node: (id) => nodeRow(s.getNode.get(id)),
    find,
    // every node of a kind; backed true for nodes a note stands behind, false for names no note has yet
    nodes: ({ kind = null, backed = null } = {}) => {
      const where = [];
      const args = [];
      if (kind) { const k = [].concat(kind); where.push(`kind in (${k.map(() => '?').join(',')})`); args.push(...k); }
      if (backed === true) where.push('rel is not null');
      if (backed === false) where.push('rel is null');
      return db.prepare(`select * from nodes${where.length ? ` where ${where.join(' and ')}` : ''} order by id`).all(...args).map(nodeRow);
    },
    edgesOf,
    community: (id) => s.community.get(id) ?? null,
    stats,
    meta: (key, value) => {
      if (value === undefined) return db.prepare('select value from meta where key = ?').get(key)?.value ?? null;
      db.prepare('insert or replace into meta(key, value) values (?, ?)').run(key, String(value));
      return value;
    },
    // ---- model pass ----
    modelFile: (rel) => m('select hash from model_files where rel = ?').get(rel)?.hash ?? null,
    modelFiles: () => new Map(m('select rel, hash from model_files').all().map((r) => [r.rel, r.hash])),
    putModelFile: (rel, hash, tokens = null) => { m('insert or replace into model_files(rel, hash, read_at, tokens) values (?, ?, ?, ?)').run(rel, hash, now(), tokens); },
    dropModelFile: (rel) => { m('delete from model_files where rel = ?').run(rel); },
    // a proposal by its key keeps the answer a person gave it: only a pending one is written over
    putProposal: ({ key, rel, line = null, kind, src = null, dst = null, confidence = null, props = null }) => {
      const cur = m('select status from model_proposals where key = ?').get(key);
      if (cur && cur.status !== 'pending') return false;
      m('insert into model_proposals(key, rel, line, kind, src, dst, confidence, props, status, recorded_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict(key) do update set rel = excluded.rel, line = excluded.line, kind = excluded.kind, src = excluded.src, dst = excluded.dst, confidence = excluded.confidence, props = excluded.props, recorded_at = excluded.recorded_at')
        .run(key, rel, line, kind, src, dst, confidence, props ? JSON.stringify(props) : null, 'pending', now());
      return true;
    },
    proposal: (key) => proposalRow(m('select * from model_proposals where key = ?').get(key)),
    proposals: ({ rel = null, status = null } = {}) => m('select * from model_proposals where (?1 is null or rel = ?1) and (?2 is null or status = ?2) order by id').all(rel, status).map(proposalRow),
    setProposal: (key, { status, edges = null }) => { m('update model_proposals set status = ?, edges = ?, decided_at = ? where key = ?').run(status, edges ? JSON.stringify(edges) : null, now(), key); },
    dropProposals: (rel, status = 'pending') => { m('delete from model_proposals where rel = ? and status = ?').run(rel, status); },
    moveProposals: (from, to) => { m('update model_proposals set rel = ? where rel = ?').run(to, from); m('update or replace model_files set rel = ? where rel = ?').run(to, from); },
    close: () => { try { db.close(); } catch { /* closed */ } },
  };
}
