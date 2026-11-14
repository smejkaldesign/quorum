-- applied-when: select exists(select 1 from pg_proc where proname = 'kb_search')
-- Search over knowledge base notes (docs/specs/workspace-knowledge.md, "Use"): Quorum chat, the quorum CLI and the
-- Quorum MCP server look up the KB notes the asker can read (app/ee/kbSearch.js). Two parts:
--
-- 1. kb_note_document builds a note's full text search document: the title weighs most, then the path, then the body.
--    An expression index over it covers every live KB note, so the table gains no column and select * stays as it was.
-- 2. kb_search and kb_folder_path run as security invoker. Every row they read passes the caller's own row level
--    security: notes_select (0024) for the notes, knowledge_bases_select and kb_folders_select for the names. A person
--    who cannot read a KB gets nothing from it, the same answer as reading the notes table directly.

-- the body is cut at 100,000 characters, well under the 1 MB limit of a tsvector
create or replace function public.kb_note_document(title text, path text, body text) returns tsvector
language sql immutable parallel safe set search_path = public as $$
  select setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A')
      || setweight(to_tsvector('english'::regconfig, regexp_replace(coalesce(path, ''), '[/_.-]+', ' ', 'g')), 'B')
      || setweight(to_tsvector('english'::regconfig, left(coalesce(body, ''), 100000)), 'C');
$$;

create index notes_kb_search on public.notes
  using gin (public.kb_note_document(frontmatter ->> 'title', path, body))
  where kb_id is not null and deleted_at is null;

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

-- the best matches for a query among the KB notes the caller can read in one workspace, best first.
-- mode 'all' needs every word (web search syntax: quotes for a phrase, - to leave a word out); mode 'any' takes a
-- note with any of the words, which suits a question typed in chat. only_kb narrows the search to one KB.
-- max_results is held between 1 and 50. snippet is the passage around the matches, at most three fragments.
create or replace function public.kb_search(workspace_id public.ulid, query text, only_kb public.ulid default null, max_results integer default 8, mode text default 'all')
returns table (note_id public.ulid, kb_id public.ulid, kb_name text, folder_id public.ulid, folder_path text[], path text, title text, snippet text, rank real, user_id uuid, updated_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with q as (
    select case when kb_search.mode = 'any'
                then nullif(replace(plainto_tsquery('english'::regconfig, left(coalesce(kb_search.query, ''), 1000))::text, ' & ', ' | '), '')::tsquery
                else websearch_to_tsquery('english'::regconfig, left(coalesce(kb_search.query, ''), 1000)) end as tsq
  ), hits as (
    select n.id, n.kb_id, n.folder_id, n.path, n.frontmatter, n.body, n.user_id, n.updated_at,
           ts_rank_cd(public.kb_note_document(n.frontmatter ->> 'title', n.path, n.body), q.tsq) as rank
    from public.notes n, q
    where q.tsq is not null and numnode(q.tsq) > 0
      and n.workspace_id = kb_search.workspace_id and n.kb_id is not null and n.deleted_at is null
      and (kb_search.only_kb is null or n.kb_id = kb_search.only_kb)
      and public.kb_note_document(n.frontmatter ->> 'title', n.path, n.body) @@ q.tsq
    order by rank desc, n.updated_at desc, n.id
    limit greatest(1, least(coalesce(kb_search.max_results, 8), 50))
  )
  select h.id, h.kb_id, k.name, h.folder_id, public.kb_folder_path(h.folder_id), h.path,
         coalesce(nullif(btrim(h.frontmatter ->> 'title'), ''), regexp_replace(regexp_replace(h.path, '^.*/', ''), '\.md$', '')),
         ts_headline('english'::regconfig, left(h.body, 100000), q.tsq, 'MaxFragments=3, MaxWords=35, MinWords=12, FragmentDelimiter=" … ", StartSel="", StopSel=""'),
         h.rank, h.user_id, h.updated_at
  from hits h
  cross join q
  join public.knowledge_bases k on k.id = h.kb_id
  order by h.rank desc, h.updated_at desc, h.id;
$$;

revoke all on function public.kb_search(public.ulid, text, public.ulid, integer, text) from public, anon;
grant execute on function public.kb_search(public.ulid, text, public.ulid, integer, text) to authenticated;
revoke all on function public.kb_folder_path(public.ulid) from public, anon;
grant execute on function public.kb_folder_path(public.ulid) to authenticated;
