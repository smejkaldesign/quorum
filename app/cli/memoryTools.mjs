// The memory graph and search tools, as the quorum MCP server and `quorum memory` list them. Pure data, shared by the
// CLI and the app: each call goes to the running app (memory_tool on the control socket), which runs the graph or search
// handler named here and withholds opted-out lines; the CLI then trims the answer to the budget (budget.mjs). All read
// only, so read only mode allows them; the in-app chat (connectors only) does not list them.
export const DEFAULT_BUDGET = 1500;
const str = (description) => ({ type: 'string', description });
const budget = { type: 'number', description: `most tokens to return, default ${DEFAULT_BUDGET}; the last line says what a larger budget would add` };
const current = { type: 'boolean', description: 'only facts that hold now (default true); false adds superseded ones as history' };

export const MEMORY_TOOLS = [
  {
    name: 'search', handler: 'memory-search', status: 'memory-search-status',
    description: 'Hybrid search over every note in the vault, meetings included: keyword (BM25), local embeddings and the knowledge graph, ranked together, with superseded facts lower and recent ones higher. One line per passage: path:lines, heading, score, then the passage. Read the file at those lines for more.',
    inputSchema: { type: 'object', properties: { q: str('what to look for, in plain words'), budget, k: { type: 'number', description: 'most passages, default 20' }, folders: { type: 'array', items: { type: 'string' }, description: 'only notes under these vault folders' }, kinds: { type: 'array', items: { type: 'string' }, description: 'only notes of these node kinds: note, person, project, meeting, decision...' }, since: str('ISO date: only notes changed on or after it') }, required: ['q'] },
  },
  {
    name: 'graph_query', handler: 'memory-graph-query',
    description: 'The knowledge graph around a name or question: typed nodes (note, person, project, company, meeting, decision, topic, tag, folder) and typed edges (links_to, mentions, attended, works_on, member_of, decided_in, decision_about, about, tagged, supersedes...), strongest first. Each edge gives its provenance (explicit, rule, model, person), source path and line, and the dates it held.',
    inputSchema: { type: 'object', properties: { q: str('a name or a question'), budget, depth: { type: 'number', description: 'hops from the matched nodes, 1 to 3, default 2' }, kinds: { type: 'array', items: { type: 'string' }, description: 'only these edge kinds' }, current }, required: ['q'] },
  },
  {
    name: 'graph_path', handler: 'memory-graph-path',
    description: 'How two things connect: the shortest chain of edges between two nodes, each edge with its kind, provenance, source and dates. Takes names or node ids.',
    inputSchema: { type: 'object', properties: { a: str('a name or node id'), b: str('a name or node id'), undirected: { type: 'boolean', description: 'follow edges both ways (default true)' }, budget }, required: ['a', 'b'] },
  },
  {
    name: 'explain', handler: 'memory-graph-explain',
    description: 'Why a node is in the graph: its source note, aliases, community, every incoming and outgoing edge with provenance and dates, and the facts it superseded or that superseded it.',
    inputSchema: { type: 'object', properties: { id: str('a node id such as person:jane-doe, or a name'), budget }, required: ['id'] },
  },
  {
    name: 'entity', handler: 'memory-graph-entity',
    description: 'Everything about one person, project or company: its note, the meetings it was in, the decisions about it, the notes that mention it and the people around it, newest first.',
    inputSchema: { type: 'object', properties: { name: str('a name, alias or node id'), budget }, required: ['name'] },
  },
  {
    name: 'decisions', handler: 'memory-graph-decisions',
    description: 'The decisions recorded in the vault, newest first, each with its text, where it was decided (note and line, meeting), its date, what it is about, and whether a later decision replaced it. The one call for every decision about project X: decisions with about X.',
    inputSchema: { type: 'object', properties: { about: str('a project, person, company or topic; all decisions when left out'), since: str('ISO date: only decisions on or after it'), current, budget } },
  },
  {
    name: 'communities', handler: 'memory-graph-communities',
    description: 'The topics in the vault: communities of notes, people and projects that link to each other more than to the rest, found in the knowledge graph with no model. Biggest first, each with its name, size, hub and strongest members. With id (a community id, its name, or any node in it), that one community and its members strongest first.',
    inputSchema: { type: 'object', properties: { id: str('a community id such as c:project:orca, a community name, or a node name or id: that community only'), min: { type: 'number', description: 'smallest community to list, default 3' }, budget } },
  },
  {
    name: 'hubs', handler: 'memory-graph-hubs',
    description: 'The most connected nodes in the knowledge graph, overall or in one community: each with its distinct neighbors, its edge count and its community. Tags and folders are left out. Good places to start reading.',
    inputSchema: { type: 'object', properties: { community: str('a community id, a community name, or a node in it: the hubs of that community only'), budget } },
  },
  {
    name: 'memory_status', handler: 'memory-graph-status', status: 'memory-search-status', setup: 'memory-setup-status',
    description: 'How complete Quorum\'s memory of the vault is: setup progress and gaps from the memory scan, notes indexed, nodes and edges by kind, links resolved, passages and embeddings built, and the open gaps listed in Needs review.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export const memoryTool = (name) => MEMORY_TOOLS.find((t) => t.name === name) ?? null;
export const NOT_READY = 'The memory index is not ready yet. Quorum builds it after the vault connects; check memory_status, or use search_meetings until it is done.';

// what names an item: an item whose note is withheld, or whose name, id, path or aliases name an opted-out customer, is
// dropped; in what is left, withheld lines are redacted from the text. withheld(rel) and isExcluded(text) are the app's
// filters; redact(text) blanks the withheld lines
// an id or path is a slug (company:acme-corp, people/acme-corp.md), so each is also checked with its dashes, underscores
// and colons read as spaces
const REL_KEYS = ['rel', 'source_rel', 'sourceRel'];
const NAME_KEYS = ['id', 'name', 'title', 'rel', 'src', 'srcName', 'dst', 'dstName', 'aliases', 'source_rel', 'sourceRel'];
const strings = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
const unslug = (t) => t.replace(/[-_:]+/g, ' ');
export const isHidden = (item, { withheld = () => false, isExcluded = () => false } = {}) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (REL_KEYS.some((k) => typeof item[k] === 'string' && withheld(item[k]))) return true;
  const names = strings(NAME_KEYS.map((k) => item[k]));
  return isExcluded(names.join('\n')) || isExcluded(names.map(unslug).join('\n'));
};
// a node's community (communities, hubs, explain, entity) named after an opted-out customer is blanked, and the node
// stays: being in that topic does not name the customer
const COMMUNITY_KEYS = ['community', 'communityName'];
const namesCommunity = (o, { isExcluded = () => false } = {}) => {
  const names = COMMUNITY_KEYS.flatMap((k) => (typeof o[k] === 'string' ? [o[k]] : o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? strings([o[k].community, o[k].id, o[k].name]) : []));
  return names.length > 0 && (isExcluded(names.join('\n')) || isExcluded(names.map(unslug).join('\n')));
};
export function withhold(value, filters = {}) {
  const redact = filters.redact ?? ((t) => t);
  const walk = (v) => {
    if (typeof v === 'string') return redact(v);
    if (Array.isArray(v)) return v.filter((x) => !isHidden(x, filters)).map(walk);
    if (v && typeof v === 'object') {
      const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      if (namesCommunity(v, filters)) for (const k of COMMUNITY_KEYS) if (k in out) out[k] = null;
      return out;
    }
    return v;
  };
  return walk(value);
}

// one handler answer as it may leave the app (the window or an AI tool): an answer about one node that is withheld
// gives nothing of it, and the rest goes through withhold
export function withholdAnswer(r, filters = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || r.error) return r;
  const subject = r.node ?? r.entity ?? r.about ?? r.community;
  if (isHidden(subject, filters)) return { error: 'That note is withheld.' };
  return withhold(r, filters);
}

// what the app runs for memory_tool on the control socket. handler(name) is the registered graph or search handler of
// that name, or null while the index is not built; each takes the tool's args as one object. memory_status asks the
// graph, the search index and the memory setup scan and answers with what is ready
// the app side of the bridge: a tool's handler name to a function that calls the registered IPC handler with every
// argument it is given, with no IPC event
export const fromActionHandlers = (handlers) => (h) => { const fn = handlers.get(h); return fn ? (...a) => fn(null, ...a) : null; };

export async function runMemoryTool(name, args = {}, { handler, ...filters }) {
  const tool = memoryTool(String(name ?? ''));
  if (!tool) throw new Error(`Unknown memory tool ${name}`);
  const run = async (h) => {
    const fn = handler(h);
    if (!fn) throw new Error(NOT_READY);
    const r = await fn(args);
    if (r?.error) throw new Error(r.error);
    return r;
  };
  if (tool.name === 'memory_status') {
    const part = (h) => run(h).catch((e) => ({ error: e.message }));
    const [graph, search, setup] = await Promise.all([part(tool.handler), part(tool.status), part(tool.setup)]);
    if (graph.error && search.error && setup.error) throw new Error(NOT_READY);
    return withhold({ graph, search, ...(setup.error ? {} : { setup }) }, filters);
  }
  const r = await run(tool.handler);
  // a handler answers null while no vault is connected
  if (r == null) throw new Error(NOT_READY);
  const out = withholdAnswer(r, filters);
  if (out?.error) throw new Error(out.error);
  return out;
}
