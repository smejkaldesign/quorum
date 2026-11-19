# Memory graph, search and memory setup

Status: building (integration branch `feat/memory-graph`). This spec is the contract for the pieces built in parallel and the standing reference for every later change to Quorum's memory. Audit and research behind it: the memory audit (2026-11-19), Graphify (Apache 2.0), Zep and Graphiti (temporal knowledge graphs), and the context rot literature (Chroma 2025, Liu et al. 2024).

## Goal

When a person creates a second brain in Quorum or connects an existing one, Quorum ends with a complete, working memory: a graph of notes, people, projects, meetings and decisions with typed, sourced and dated connections; hybrid search across the whole vault; a setup report that lists every gap as a Needs review item Quorum can fix on Approve; and MCP tools that let AI tools query all of it. The memory stays correct as it grows: facts that change are superseded, retrieval stays small and relevant, and the maintainer layer keeps it clean.

## Principles

1. **Local first.** Everything in this spec runs on the Mac with no model calls, except the optional model pass (wave 2), which uses the person's own model source. No note text leaves the Mac in the Local edition.
2. **The vault is the source of truth.** The graph and the search index are derived data in Quorum's app data, rebuilt from the vault at any time. Quorum writes to notes only through Review items the person approves (or the auto-apply setting), with versions and Undo, like every other memory fix.
3. **Graph first.** Retrieval starts from the graph; keyword and vector similarity are signals in one ranker. The eval decides the weights.
4. **Every connection says where it came from and when.** Provenance and validity time on every edge.
5. **Small, high-signal context.** Every retrieval tool takes a token budget, returns the best items first, and says what it left out.

## Storage

One SQLite database per vault, in app data: `DATA_DIR/memory/<vault-hash>/memory.db`, opened with Electron's built-in `node:sqlite` (`DatabaseSync`, Node 24.22, FTS5 available). WAL mode. A schema version in `meta`; a version change rebuilds from the vault. The database lives in the main process; the memory engine utility process opens its own read-only connection where it needs one.

### Tables (owned by `app/graph/store.js`)

- `meta(key text primary key, value text)`
- `files(rel text primary key, hash text, mtime real, size int, indexed_at real)`: one row per note; `hash` is sha256 of the text, so unchanged files are skipped.
- `nodes(id text primary key, kind text, name text, rel text null, props text json, created_at real, updated_at real)`. Kinds: `note`, `person`, `project`, `company`, `meeting`, `decision`, `topic`, `tag`, `folder`. A node backed by a note has `rel`; a person mentioned with no note has none (a gap). Ids are stable: `note:<rel>`, `person:<slug>`, `tag:<name>`, and so on.
- `aliases(node text, alias text, primary key(node, alias))`: normalized lowercase names for lookup and for merge detection.
- `edges(id integer primary key, src text, dst text, kind text, provenance text, source_rel text, source_line int null, confidence real, valid_from real null, valid_to real null, superseded_by integer null, recorded_at real)`.
  - Kinds: `links_to`, `embeds`, `mentions`, `attended`, `works_on`, `member_of`, `decided_in`, `decision_about`, `about`, `tagged`, `in_folder`, `contradicts`, `supersedes`.
  - Provenance: `explicit` (a wikilink, embed or frontmatter field written in the note), `rule` (a folder or naming convention, a meeting template, the keeper's name match), `model` (wave 2), `person` (approved in Review).
  - Validity (bi-temporal): `valid_from` and `valid_to` are when the fact held in the world (from the note's date, a meeting date, frontmatter dates); `recorded_at` is when Quorum learned it. A newer fact that replaces an older one sets the older edge's `valid_to` and `superseded_by` and keeps it for history.
- `edges_by_src`, `edges_by_dst`, `edges_by_kind` indexes.
- `communities(node text primary key, community text, rank real)` (wave 2 fills names).

### Tables (owned by `app/search/`)

- `chunks(id integer primary key, rel text, heading text, start_line int, end_line int, text text, hash text, tokens int)`
- `chunks_fts` (FTS5 over heading and text, porter tokenizer, external content `chunks`)
- `vectors(chunk integer primary key, model text, dim int, vec blob)`: float32, normalized.

## Modules and their APIs

### `app/graph/` (agent: graph-core)

- `store.js`: `openStore({ dir, vault, log })` returns the store with `tx(fn)`, `upsertFile`, `fileHash(rel)`, `removeFile(rel)` (drops its nodes' derived edges), `upsertNode`, `addEdge`, `supersede(edgeId, byEdgeId, at)`, `node(id)`, `find(name, { kind })` (exact, alias, then prefix; returns every match so callers can refuse ambiguity), `edgesOf(id, { dir, kinds, current = true })`, `stats()`, `close()`.
- `extract.js`: pure. `extractNote({ rel, text, note, resolve, conventions })` returns `{ nodes, edges }` from one note, with no model: links and embeds (through vindex's resolver), frontmatter (`type`, `people`, `attendees`, `project`, `projects`, `company`, `tags`, `date`, `status`, `aliases`), inline tags, folder conventions (configurable; defaults detect `people/`, `projects/`, `meetings/` or `08-meetings/`, `decisions/`), meeting notes (attendees and date), decision lines (`Decision:`, `Decided:`, `- [x] Decision`, a `## Decisions` section) and the keeper's link lines.
- `temporal.js`: pure. Given the current edges for a subject and a new edge of a single-valued kind (`works_on` with role, `member_of`, a decision on the same subject), decides whether it supersedes an older one; returns the supersede pairs.
- `query.js`: `graphQuery({ q, seeds, budget, depth = 2, kinds, current = true })` (seed nodes from `find` and from search hits, breadth-first expansion, scored by edge kind and provenance, trimmed to `budget` tokens, returns `{ nodes, edges, truncated: { shown, total, budgetNeeded } }`); `graphPath(a, b, { undirected })`; `explain(id)` (the node, its source, aliases, community, incoming and outgoing edges with provenance, superseded history); `entity(name)` (a person, project or company with meetings, decisions, notes and people around it); `decisions({ about, since, current = true })`. A name that matches several nodes returns `{ ambiguous: [candidates] }` and never guesses.
- `index.js`: `createMemoryGraph({ dataDir, vault, vindex, log })` wires the store to vindex: a full build on connect (batched, yields to the event loop, reports progress), then incremental updates from the watcher by content hash, including moves (vindex's `onMoves`). Emits `progress` and `ready`.

### `app/search/` (agent: search)

- `chunk.js`: pure. Splits a note into heading-scoped chunks of at most 400 tokens with a short overlap, keeping the note title and heading path on each chunk.
- `embed.js`: an embedder interface `{ id, dim, embed(texts) }`. The default is the bundled bge-small-en-v1.5 int8 in the memory engine's utility process (raise its max tokens to 512 for chunks). The interface leaves room for another local model or a hosted provider later; nothing hosted ships in this wave.
- `index.js`: incremental chunking, FTS and vector updates keyed by chunk hash; a background embed queue that never blocks the window and pauses while recording.
- `hybrid.js`: `search({ q, budget, k = 20, folders, kinds, since })`: BM25 from FTS5, cosine over vectors (brute force is fine up to a few hundred thousand chunks), graph boost for chunks in notes near the top hits' nodes, recency and supersession factors, merged with reciprocal rank fusion. Returns chunks with `rel`, heading, line range, score parts and a `truncated` summary.
- `eval/`: a local eval harness: a question set with expected notes (built from real questions over a vault, kept out of the repo when it names private content), recall@5, recall@10 and MRR for keyword only, vector only, graph only and hybrid. Used to set the weights and to judge any future model change.

### MCP and CLI tools (agent: mcp)

In `app/cli/` through the app bridge (`appTools.mjs`), each with a `budget` argument (default 1,500 tokens) and a truncation line that says how much was left out and the budget that would return everything:

- `search`: hybrid search over the whole vault and meetings.
- `graph_query`, `graph_path`, `explain`, `entity`, `decisions`.
- `memory_status`: setup progress, index counts, open gaps.

Update `about.mjs`, the instructions (under 2,048 characters), the README "For AI agents" section and the tool tests. Instructions tell agents to start with `entity`, `decisions` or `search` before reading files.

### Memory setup and the maintainer layer (agent: setup)

- **Scan** (`app/memorySetup.js`): runs on create and on connect, and again from Settings, Memory. It reports notes indexed, links resolved, entities found, embeddings built, and the gaps below, with progress until done.
- **Gaps become Needs review items**, each with a Quorum fix on Approve, through the existing review rules, quality gate, fix runs, versions and Undo:
  - a name mentioned in several notes with no person or project note (create the note from a template, linked from where it is mentioned);
  - one person or project under two names (add an alias, or merge on Approve);
  - meeting notes with attendees in text and no links (link them);
  - person and project notes with no type in frontmatter (add it);
  - notes the conventions cannot place (suggest a folder);
  - broken links and orphans (existing rules).
- **Setup screen** in onboarding for an existing vault and in Settings, Memory: what was found, what Quorum will fix, the keeper offered on for connected vaults (shown on, with one line on what it writes), the model pass offered with a cost estimate (off until wave 2 ships), and a done state.
- **Maintainer alignment.** The keeper writes typed edges through the graph store when it files a meeting (attended, mentions, decided_in) as well as its link lines. Review rules read the graph (orphans from edges, duplicates from aliases and vectors). The contradiction checker reads current edges and records `contradicts`; a resolved contradiction supersedes the losing fact. Learned facts come from current edges first.

## Context rot

Quorum guards against two kinds: a memory that grows stale and contradictory, and AI tools drowning in too much context.

Already in place: stale, duplicate, near-duplicate, oversized and contradiction rules; the learned facts list has a character budget.

Added in this build:

1. **Supersession, not deletion** (graph-core). Changed facts end their validity and point at what replaced them; queries return current facts by default and history on request.
2. **Budgets everywhere** (mcp). Every retrieval tool trims to a token budget, puts the strongest items first and last, and states what it left out, so an agent asks a narrower question instead of reading more.
3. **Recency and confirmation in ranking** (search). Superseded and long-unconfirmed facts rank lower; facts confirmed by recent meetings rank higher.
4. **Consolidation reviews** (setup). Duplicates merge into one canonical note on Approve; oversized notes are offered a split; summaries record the hashes of their sources and are marked stale when a source changes.
5. **Instruction file hygiene** (setup). The scan measures CLAUDE.md, AGENTS.md and similar files against a size budget and checks them for links to notes that no longer exist and for statements the graph contradicts, and lists those as Review items with a proposed edit.
6. **Freshness in the setup report** (setup). Share of facts confirmed in the last 90 days, open contradictions, stale summaries.

## Keeping the rest of the app in step

Any change to node kinds, edge kinds, tools or the scan updates, in the same PR: `about.mjs` and the MCP instructions, this spec, the Memory setup scan, the review rules that read the graph, and the tests that pin them (`mcp-about.test.js` checks that every tool appears in `about`; a graph test checks that every node and edge kind in `store.js` is documented here).

## Waves

- **Wave 1 (this build):** graph-core, search, mcp, setup, as above. Each agent opens its PR into `feat/memory-graph`; the integration PR into `main` comes after review and a live check on a real vault.
- **Wave 2:** the model pass (relations and decisions from prose, `model` provenance, low-confidence edges to Review, off by default with a cost estimate), named communities and hub notes, topic summaries, and Cloud graph sync through the `links` table.

## Embedding model choice

Local bge-small-en-v1.5 is the default: free, private, offline, already shipped. A full index of a 3 million token vault costs nothing and takes minutes on Apple Silicon. Hosted models (Voyage 4 lite at $0.02 per million tokens, Voyage 4 at $0.06, with 200 million free tokens per account) would cost cents per vault, but would send every note to a third party, which the Local edition promises not to do. The eval compares bge-small with a stronger local model (for example EmbeddingGemma 300M) and, on a non-confidential test vault only, a hosted model, before any change.
