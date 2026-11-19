// The memory database search writes to: one SQLite file per vault, DATA_DIR/memory/<vault-hash>/memory.db, shared with
// the graph (app/graph/store.js). A store handed in gives its open handle; with none, search opens the same file itself
// in WAL mode, so the two can run side by side until the store's handle is passed in.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storeFile } from '../graph/store.js';

export const SEARCH_VERSION = '1';
// the graph store's file for the vault, so both always open the same one
export const memoryDbFile = (dataDir, vault) => storeFile(path.join(dataDir, 'memory'), vault);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS search_files(rel TEXT PRIMARY KEY, hash TEXT, title TEXT, kind TEXT, date REAL, mtime REAL);
CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, rel TEXT, heading TEXT, start_line INT, end_line INT, text TEXT, hash TEXT, tokens INT);
CREATE INDEX IF NOT EXISTS chunks_by_rel ON chunks(rel);
CREATE INDEX IF NOT EXISTS chunks_by_hash ON chunks(hash);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(heading, text, content='chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
  DELETE FROM vectors WHERE chunk = old.id;
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF heading, text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, heading, text) VALUES ('delete', old.id, old.heading, old.text);
  INSERT INTO chunks_fts(rowid, heading, text) VALUES (new.id, new.heading, new.text);
END;
CREATE TABLE IF NOT EXISTS vectors(chunk INTEGER PRIMARY KEY, model TEXT, dim INT, vec BLOB);
`;
const DROP = 'DROP TRIGGER IF EXISTS chunks_ai; DROP TRIGGER IF EXISTS chunks_ad; DROP TRIGGER IF EXISTS chunks_au; DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS search_files;';

// creates search's tables; a different SEARCH_VERSION drops them first, and the next build reads the vault again
export function ensureSearchSchema(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)');
  const v = db.prepare("SELECT value FROM meta WHERE key = 'search_schema'").get()?.value;
  if (v != null && v !== SEARCH_VERSION) db.exec(DROP);
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('search_schema', ?)").run(SEARCH_VERSION);
}

// { db, own }: own is true when search opened the file and closes it. store: the graph store, whose db() is the handle
export function openMemoryDb({ dataDir, vault, store = null, file = null }) {
  const shared = typeof store?.db === 'function' ? store.db() : null;
  if (shared) { ensureSearchSchema(shared); return { db: shared, own: false }; }
  const f = file ?? memoryDbFile(dataDir, vault);
  mkdirSync(path.dirname(f), { recursive: true });
  const db = new DatabaseSync(f);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 2000;');
  ensureSearchSchema(db);
  return { db, own: true };
}
