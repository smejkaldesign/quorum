-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'links' and column_name = 'edge_key')
-- Quorum hosted edition, step 49: Cloud graph sync (docs/specs/memory-graph.md, wave 2). Each Mac publishes the memory
-- graph edges it extracted from its own notes that sit in a knowledge base, and reads the edges of teammates' knowledge
-- base notes into its local graph (app/ee/graphSync.js). The rows live in links, whose read policy (0043) already
-- limits a member to links on notes they can read (note_readable), so no read grows. This migration
--   1. adds the edge columns to links: kind, provenance, both ends (id, kind, name), source line, confidence, validity,
--      the edge's key, the key of the edge that superseded it, and the hashes of the note and of its edge set. A row
--      with kind null is a plain link (0001) and keeps its old shape;
--   2. narrows writes on links: a row is written only as yourself, on a live note you own, and a graph row only on a
--      note in a knowledge base. Update and delete were open to every workspace member (0001); now only the row's
--      owner. A low-confidence model edge is refused unless a person approved it;
--   3. adds graph_put, which replaces the caller's graph rows on one note in one transaction, and graph_heads, one line
--      per readable knowledge base note with graph rows, so a reader fetches only the notes whose edge set changed.
--      Both run as the caller (security invoker), so row level security decides what they touch and return;
--   4. drops a note's graph rows when it leaves its knowledge base or is deleted, whoever made the change.

alter table public.links
  add column if not exists kind text,
  add column if not exists provenance text,
  add column if not exists src text,
  add column if not exists src_kind text,
  add column if not exists src_name text,
  add column if not exists dst text,
  add column if not exists dst_kind text,
  add column if not exists dst_name text,
  add column if not exists source_line integer,
  add column if not exists confidence real,
  add column if not exists valid_from timestamptz,
  add column if not exists valid_to timestamptz,
  add column if not exists edge_key text,
  add column if not exists superseded_by_key text,
  add column if not exists note_hash text,
  add column if not exists graph_hash text,
  add column if not exists props jsonb,
  add column if not exists ends jsonb;

alter table public.links drop constraint if exists links_graph_shape;
alter table public.links add constraint links_graph_shape check (
  kind is null or (
    kind ~ '^[a-z_]{1,40}$'
    and provenance in ('explicit', 'rule', 'model', 'person')
    and src is not null and dst is not null and length(src) <= 600 and length(dst) <= 600
    and coalesce(length(src_name), 0) <= 300 and coalesce(length(dst_name), 0) <= 300
    and edge_key ~ '^[0-9a-f]{64}$' and graph_hash ~ '^[0-9a-f]{64}$'
    and (superseded_by_key is null or superseded_by_key ~ '^[0-9a-f]{64}$')
    and (confidence is null or (confidence >= 0 and confidence <= 1))
    and coalesce(pg_column_size(props), 0) + coalesce(pg_column_size(ends), 0) <= 8192
  )
);
-- a model edge reaches teammates only when it is confident or a person approved it in Review
alter table public.links drop constraint if exists links_model_reviewed;
alter table public.links add constraint links_model_reviewed check (
  provenance is distinct from 'model' or coalesce(confidence >= 0.8, false) or coalesce(props ->> 'approved', '') = 'true'
);

create index if not exists links_graph on public.links (workspace_id, from_note) where kind is not null and deleted_at is null;

drop policy if exists links_insert on public.links;
create policy links_insert on public.links for insert to authenticated
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())) and exists (
    select 1 from public.notes n where n.id = links.from_note and n.workspace_id = links.workspace_id
      and n.user_id = (select auth.uid()) and n.deleted_at is null and (links.kind is null or n.kb_id is not null)
  ));
drop policy if exists links_update on public.links;
create policy links_update on public.links for update to authenticated
  using (user_id = (select auth.uid()))
  with check (public.is_member(workspace_id) and (user_id = (select auth.uid())) and exists (
    select 1 from public.notes n where n.id = links.from_note and n.workspace_id = links.workspace_id
      and n.user_id = (select auth.uid()) and n.deleted_at is null and (links.kind is null or n.kb_id is not null)
  ));
drop policy if exists links_delete on public.links;
create policy links_delete on public.links for delete to authenticated
  using (user_id = (select auth.uid()));

-- the caller's edge set for one of their notes, replacing what they published for it before. edges is a JSON array of
-- rows with the column names above (id a ULID the app made); an empty array withdraws the note's edges
create or replace function public.graph_put(note_id public.ulid, graph_hash text, edges jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  n integer;
begin
  if (select auth.uid()) is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(graph_put.edges) is distinct from 'array' then raise exception 'edges must be a list'; end if;
  if jsonb_array_length(graph_put.edges) > 2000 then raise exception 'A note can publish at most 2000 edges'; end if;
  if not exists (select 1 from public.notes x where x.id = graph_put.note_id and x.user_id = (select auth.uid()) and x.deleted_at is null) then
    raise exception 'That note is not yours';
  end if;
  delete from public.links l where l.from_note = graph_put.note_id and l.kind is not null and l.user_id = (select auth.uid());
  insert into public.links (id, user_id, workspace_id, from_note, anchor, kind, provenance, src, src_kind, src_name, dst, dst_kind, dst_name,
    source_line, confidence, valid_from, valid_to, edge_key, superseded_by_key, note_hash, graph_hash, props, ends)
  select e.id, (select auth.uid()), x.workspace_id, x.id, left(coalesce(e.dst_name, e.dst, ''), 300), e.kind, e.provenance, e.src, e.src_kind,
    e.src_name, e.dst, e.dst_kind, e.dst_name, e.source_line, e.confidence, e.valid_from, e.valid_to, e.edge_key, e.superseded_by_key,
    e.note_hash, graph_put.graph_hash, e.props, e.ends
  from jsonb_to_recordset(graph_put.edges) as e(id public.ulid, kind text, provenance text, src text, src_kind text, src_name text, dst text,
    dst_kind text, dst_name text, source_line integer, confidence real, valid_from timestamptz, valid_to timestamptz, edge_key text,
    superseded_by_key text, note_hash text, props jsonb, ends jsonb)
  cross join public.notes x where x.id = graph_put.note_id;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.graph_put(public.ulid, text, jsonb) from public, anon;
grant execute on function public.graph_put(public.ulid, text, jsonb) to authenticated;

-- one line per knowledge base note in the workspace that has graph rows the caller can read: who wrote it, where it
-- sits, and the hash of its edge set
create or replace function public.graph_heads(workspace_id public.ulid)
returns table (note_id text, kb_id text, path text, author uuid, graph_hash text, note_hash text, edges integer)
language sql
stable
security invoker
set search_path = public
as $$
  select l.from_note, n.kb_id, n.path, n.user_id, max(l.graph_hash), max(l.note_hash), count(*)::integer
  from public.links l join public.notes n on n.id = l.from_note
  where l.workspace_id = graph_heads.workspace_id and l.kind is not null and l.deleted_at is null and n.deleted_at is null and n.kb_id is not null
  group by l.from_note, n.kb_id, n.path, n.user_id;
$$;
revoke all on function public.graph_heads(public.ulid) from public, anon;
grant execute on function public.graph_heads(public.ulid) to authenticated;

-- a note that leaves its knowledge base (moved out, made private, or deleted) takes its graph rows with it, also when
-- an admin made the change and the rows belong to the author. Runs only from the trigger below
create or replace function public.links_graph_unshare()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.links l where l.from_note = new.id and l.kind is not null;
  return null;
end;
$$;
revoke all on function public.links_graph_unshare() from public, anon, authenticated;
drop trigger if exists notes_graph_unshare on public.notes;
create trigger notes_graph_unshare after update on public.notes for each row
  when (old.kb_id is not null and (new.kb_id is null or new.deleted_at is not null))
  execute function public.links_graph_unshare();
