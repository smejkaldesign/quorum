// Supersession: when a new fact of a single-valued kind replaces an older one, the older edge ends and points at the
// new one. Pure. Single-valued kinds:
// - member_of: a person or project belongs to one company at a time
// - works_on with a role: one role per person and project (an edge without a role never competes)
// - decision_about with a key: a later decision about the same subject with the same key ("Database: ...") replaces it
// Edges with no dates replace each other only when they come from the same note (the note was edited).
// Provenance comes first: a model reading (memoryModelPass.js) only ever replaces an older model reading. Between a
// model reading and a fact a note states, a rule found or a person approved, the stated fact stays current whatever
// the dates; the model pass sends such a reading to Review instead of adding it (conflicts below).

// what an edge competes over: the node whose other edges of this kind to look up, and the slot within it. null when
// the kind is not single-valued
export function subjectOf(e) {
  if (e.kind === 'member_of') return { by: 'src', id: e.src, slot: '' };
  if (e.kind === 'works_on' && e.props?.role) return { by: 'src', id: e.src, slot: e.dst };
  if (e.kind === 'decision_about' && e.props?.key) return { by: 'dst', id: e.dst, slot: e.props.key };
  return null;
}
const slotOf = (e) => (e.kind === 'works_on' ? e.dst : e.kind === 'decision_about' ? e.props?.key ?? null : '');
const isModel = (e) => e.provenance === 'model';
const valueOf = (e) => (e.kind === 'member_of' ? e.dst : e.kind === 'works_on' ? e.props?.role ?? null : e.src);

// which edges end now that `incoming` is known, given the current edges of the same kind on its subject. Returns
// [{ old, by, at }]: edge old is superseded by edge by, valid until at. The incoming edge can itself be the old one
// when a current fact is newer than it
export function supersessions(current, incoming, now = Date.now()) {
  const subject = subjectOf(incoming);
  if (!subject) return [];
  const slot = slotOf(incoming);
  const value = valueOf(incoming);
  const out = [];
  for (const c of current) {
    if (c.id === incoming.id || c.kind !== incoming.kind || c.superseded_by != null) continue;
    if (subjectOf(c)?.id !== subject.id || slotOf(c) !== slot || valueOf(c) === value) continue;
    if (isModel(c) !== isModel(incoming)) {
      // the stated fact replaces the model reading, never the other way
      const [model, stated] = isModel(c) ? [c, incoming] : [incoming, c];
      out.push({ old: model.id, by: stated.id, at: stated.valid_from ?? now });
      continue;
    }
    const a = c.valid_from, b = incoming.valid_from;
    if (a != null && b != null && a !== b) {
      out.push(a < b ? { old: c.id, by: incoming.id, at: b } : { old: incoming.id, by: c.id, at: a });
    } else if (c.source_rel && c.source_rel === incoming.source_rel) {
      // the same note now says something else: the edit is the newer fact
      out.push({ old: c.id, by: incoming.id, at: now });
    }
  }
  // a newer fact replaces the incoming one only once, by the newest of them
  const self = out.filter((p) => p.old === incoming.id).sort((x, y) => y.at - x.at);
  return [...out.filter((p) => p.old !== incoming.id), ...self.slice(0, 1)];
}

// the current facts a model reading would compete with that a note states, a rule found or a person approved: a model
// reading with any of these goes to Review instead of the graph
export function conflicts(current, incoming) {
  if (!isModel(incoming)) return [];
  const subject = subjectOf(incoming);
  if (!subject) return [];
  const slot = slotOf(incoming);
  const value = valueOf(incoming);
  return current.filter((c) => c.kind === incoming.kind && c.superseded_by == null && !isModel(c) && subjectOf(c)?.id === subject.id && slotOf(c) === slot && valueOf(c) !== value);
}
