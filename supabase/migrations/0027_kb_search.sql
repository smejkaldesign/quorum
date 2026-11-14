-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_search')
-- Search over knowledge base notes (docs/specs/workspace-knowledge.md, "Use"): Quorum chat, the quorum CLI and the
-- Quorum MCP server look up the KB notes the asker can read (app/ee/kbSearch.js). Three parts:
--
-- 1. kb_note_search holds one row per live KB note with its search documents, built once when the note is written:
--    doc in the english configuration (stemmed, stop words out) and doc_simple in the simple configuration, the
--    fallback when english finds nothing (names, codes, other languages). A trigger on notes keeps it current. The
--    documents sit in their own table so the notes rows that pull sync reads whole (select *) stay the size they were.
--    Row level security: a row is readable by whoever can read its KB, the same rule as notes_select for KB notes.
-- 2. kb_search and kb_folder_path run as security invoker. kb_search first takes the KBs the caller can read
--    (can_read_kb), then kb_search_match matches the indexed documents of those KBs only (checking each KB again),
--    ranks each match once and applies the limit, and the notes are read under the caller's own notes_select. A
--    person who cannot read a KB gets nothing from it.
-- 3. kb_any_query turns a question typed in chat into a short OR query: stop words out, the eight longest terms kept.

-- title weighs most, then the path, then the body; the body is cut at 100,000 characters, well under the 1 MB limit
-- of a tsvector
create or replace function public.kb_note_document(config regconfig, title text, path text, body text) returns tsvector
language sql immutable parallel safe set search_path = public as $$
  select setweight(to_tsvector(config, coalesce(title, '')), 'A')
      || setweight(to_tsvector(config, regexp_replace(coalesce(path, ''), '[/_.-]+', ' ', 'g')), 'B')
      || setweight(to_tsvector(config, left(coalesce(body, ''), 100000)), 'C');
$$;

create table public.kb_note_search (
  note_id public.ulid primary key references public.notes (id) on delete cascade,
  workspace_id public.ulid not null references public.workspaces (id) on delete cascade,
  kb_id public.ulid not null references public.knowledge_bases (id) on delete cascade,
  doc tsvector not null,
  doc_simple tsvector not null
);
-- no btree index on kb_id: with one, the planner filters every row of the readable KBs through the documents (each
-- read from TOAST) instead of asking the GIN index for the few that match
create index kb_note_search_doc on public.kb_note_search using gin (doc);
create index kb_note_search_doc_simple on public.kb_note_search using gin (doc_simple);

-- the KBs the caller can read, in every workspace they belong to. The policy below calls it once per query (an
-- uncorrelated subquery), where can_read_kb(kb_id) in the policy would run once for every row a search scans
create or replace function public.kb_readable_ids() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(k.id::text), '{}')
  from public.members m join public.knowledge_bases k on k.workspace_id = m.workspace_id
  where m.user_id = auth.uid() and m.deleted_at is null and public.can_read_kb(k.id);
$$;
revoke all on function public.kb_readable_ids() from public, anon;
grant execute on function public.kb_readable_ids() to authenticated;

alter table public.kb_note_search enable row level security;
create policy kb_note_search_select on public.kb_note_search for select to authenticated using (kb_id::text = any ((select public.kb_readable_ids())::text[]));
revoke all on public.kb_note_search from anon, authenticated;
grant select on public.kb_note_search to authenticated;

-- a note in a KB and not deleted has its row; any other note has none. Only the columns that change a document or
-- the note's KB rebuild it, so a sync that rewrites a note unchanged costs nothing here
create or replace function public.kb_note_search_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.kb_id is not distinct from old.kb_id and new.deleted_at is not distinct from old.deleted_at
     and new.path = old.path and new.body = old.body and new.frontmatter ->> 'title' is not distinct from old.frontmatter ->> 'title' then
    return null;
  end if;
  if new.kb_id is null or new.deleted_at is not null then
    delete from public.kb_note_search s where s.note_id = new.id;
    return null;
  end if;
  insert into public.kb_note_search (note_id, workspace_id, kb_id, doc, doc_simple)
  values (new.id, new.workspace_id, new.kb_id,
          public.kb_note_document('english', new.frontmatter ->> 'title', new.path, new.body),
          public.kb_note_document('simple', new.frontmatter ->> 'title', new.path, new.body))
  on conflict (note_id) do update set workspace_id = excluded.workspace_id, kb_id = excluded.kb_id, doc = excluded.doc, doc_simple = excluded.doc_simple;
  return null;
end $$;
create trigger notes_kb_search after insert or update of kb_id, deleted_at, path, body, frontmatter on public.notes
  for each row execute function public.kb_note_search_sync();
revoke all on function public.kb_note_search_sync() from public, anon, authenticated;

insert into public.kb_note_search (note_id, workspace_id, kb_id, doc, doc_simple)
select n.id, n.workspace_id, n.kb_id,
       public.kb_note_document('english', n.frontmatter ->> 'title', n.path, n.body),
       public.kb_note_document('simple', n.frontmatter ->> 'title', n.path, n.body)
from public.notes n where n.kb_id is not null and n.deleted_at is null;

-- a chat question as an OR of its terms: the configuration's lexemes (english drops stop words; simple keeps words of
-- three letters or more), the eight longest, longest first. Null when nothing is left
create or replace function public.kb_any_query(config regconfig, query text) returns tsquery
language sql immutable parallel safe set search_path = public as $$
  select nullif(string_agg(quote_literal(l), ' | ' order by length(l) desc, l), '')::tsquery
  from (
    select l from unnest(tsvector_to_array(to_tsvector(config, left(coalesce(query, ''), 1000)))) as l
    where config <> 'simple'::regconfig or length(l) >= 3
    order by length(l) desc, l limit 8
  ) t;
$$;

-- the names of a folder and its parents, top level first; empty for a note at the top of its KB
create or replace function public.kb_folder_path(folder_id public.ulid) returns text[]
language sql stable security invoker set search_path = public as $$
  with recursive up as (
    select f.id, f.parent_id, f.name, 0 as depth from public.kb_folders f where f.id = kb_folder_path.folder_id
    union all
    select p.id, p.parent_id, p.name, up.depth + 1 from public.kb_folders p join up on p.id = up.parent_id where up.depth < 64
  )
  select coalesce(array_agg(name order by depth desc), '{}'::text[]) from up;
$$;

-- the matching notes of some KBs, best first: note id, KB id and rank. Security definer, because under row level
-- security the planner may not use @@ (not leakproof) as a GIN index condition and would read every document; the KB
-- ids are checked again here with can_read_kb, so a caller learns nothing about a KB they cannot read. Sequential
-- scans are off inside it: the planner does not count reading each document from TOAST, so it would scan every
-- document where the GIN index finds the ones that match. EXECUTE plans each search with its own query
create or replace function public.kb_search_match(kb_ids text[], tsq tsquery, simple boolean, max_results integer)
returns table (note_id public.ulid, kb_id public.ulid, rank real)
language plpgsql stable security definer set search_path = public set enable_seqscan = off as $$
declare kbs text[] := array(select x from unnest(kb_search_match.kb_ids) x where public.can_read_kb(x::public.ulid));
begin
  if cardinality(kbs) = 0 or kb_search_match.tsq is null or numnode(kb_search_match.tsq) = 0 then return; end if;
  return query execute format($q$
    select s.note_id, s.kb_id, ts_rank_cd(s.%1$I, $1) as rank
    from public.kb_note_search s
    where s.%1$I @@ $1 and s.kb_id::text = any ($2)
    order by 3 desc, s.note_id limit $3
  $q$, case when kb_search_match.simple then 'doc_simple' else 'doc' end) using kb_search_match.tsq, kbs, greatest(1, least(coalesce(kb_search_match.max_results, 8), 50));
end $$;

-- the best matches for a query among the KB notes the caller can read in one workspace, best first.
-- mode 'all' needs every word (web search syntax: quotes for a phrase, - to leave a word out); mode 'any' takes a
-- note with any of the query's longest terms, which suits a question typed in chat. only_kb narrows the search to one
-- KB. When the english configuration finds nothing, the simple one runs. max_results is held between 1 and 50.
-- snippet is the passage around the matches, at most three fragments. The readable KBs come first (can_read_kb),
-- then kb_search_match ranks each match once and applies the limit, then the notes are read under notes_select.
create or replace function public.kb_search(workspace_id public.ulid, query text, only_kb public.ulid default null, max_results integer default 8, mode text default 'all')
returns table (note_id public.ulid, kb_id public.ulid, kb_name text, folder_id public.ulid, folder_path text[], path text, title text, snippet text, rank real, user_id uuid, updated_at timestamptz)
language plpgsql stable security invoker set search_path = public as $$
#variable_conflict use_column
declare
  q text := left(coalesce(kb_search.query, ''), 1000);
  kbs text[] := array(select k.id::text from public.knowledge_bases k
                      where k.workspace_id = kb_search.workspace_id and (kb_search.only_kb is null or k.id = kb_search.only_kb) and public.can_read_kb(k.id));
  cfg text;
  tsq tsquery;
begin
  if cardinality(kbs) = 0 then return; end if;
  foreach cfg in array array['english', 'simple'] loop
    tsq := case when kb_search.mode = 'any' then public.kb_any_query(cfg::regconfig, q) else websearch_to_tsquery(cfg::regconfig, q) end;
    continue when tsq is null or numnode(tsq) = 0;
    return query
      select n.id, n.kb_id, k.name, n.folder_id, public.kb_folder_path(n.folder_id), n.path,
             coalesce(nullif(btrim(n.frontmatter ->> 'title'), ''), regexp_replace(regexp_replace(n.path, '^.*/', ''), '\.md$', '')),
             ts_headline(cfg::regconfig, left(n.body, 100000), tsq, 'MaxFragments=3, MaxWords=35, MinWords=12, FragmentDelimiter=" … ", StartSel="", StopSel=""'),
             h.rank, n.user_id, n.updated_at
      from public.kb_search_match(kbs, tsq, cfg = 'simple', kb_search.max_results) h
      join public.knowledge_bases k on k.id = h.kb_id
      join public.notes n on n.id = h.note_id and n.deleted_at is null
      order by h.rank desc, n.updated_at desc, n.id;
    if found then return; end if;
  end loop;
end $$;

revoke all on function public.kb_search(public.ulid, text, public.ulid, integer, text) from public, anon;
grant execute on function public.kb_search(public.ulid, text, public.ulid, integer, text) to authenticated;
revoke all on function public.kb_search_match(text[], tsquery, boolean, integer) from public, anon;
grant execute on function public.kb_search_match(text[], tsquery, boolean, integer) to authenticated;
revoke all on function public.kb_folder_path(public.ulid) from public, anon;
grant execute on function public.kb_folder_path(public.ulid) to authenticated;
