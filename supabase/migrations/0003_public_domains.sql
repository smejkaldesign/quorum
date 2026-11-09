-- Quorum hosted edition, step 3: domain join never applies to public mail domains. A workspace created from a gmail.com
-- address would otherwise let every gmail.com user join it. The list is a table so it can grow without a migration.
create table public.public_mail_domains (domain text primary key check (domain = lower(domain)));
alter table public.public_mail_domains enable row level security;
-- readable by signed-in users (the app explains why domain join is unavailable), writable only through migrations or the service role
create policy public_mail_domains_select on public.public_mail_domains for select to authenticated using (true);
insert into public.public_mail_domains (domain) values
  ('gmail.com'), ('googlemail.com'), ('outlook.com'), ('hotmail.com'), ('hotmail.co.uk'), ('live.com'), ('msn.com'), ('yahoo.com'), ('yahoo.co.uk'), ('ymail.com'),
  ('icloud.com'), ('me.com'), ('mac.com'), ('aol.com'), ('proton.me'), ('protonmail.com'), ('pm.me'), ('hey.com'), ('fastmail.com'), ('fastmail.fm'),
  ('zoho.com'), ('gmx.com'), ('gmx.net'), ('yandex.com'), ('yandex.ru'), ('mail.com'), ('mail.ru'), ('comcast.net'), ('att.net'), ('verizon.net'),
  ('sbcglobal.net'), ('duck.com'), ('tutanota.com'), ('tuta.io'), ('qq.com'), ('163.com'), ('126.com'), ('naver.com'), ('web.de'), ('t-online.de'),
  ('orange.fr'), ('free.fr'), ('libero.it'), ('example.com');

create or replace function public.is_public_mail_domain(d text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.public_mail_domains p where p.domain = lower(trim(coalesce(d, ''))));
$$;
grant execute on function public.is_public_mail_domain(text) to authenticated;

-- no workspace may carry a public domain; the check also protects direct updates
alter table public.workspaces add constraint workspaces_domain_not_public check (domain is null or not public.is_public_mail_domain(domain));

-- create_workspace drops a public domain instead of failing, so the caller still gets a workspace, with domain join off
create or replace function public.create_workspace(name text, domain text default null, domain_join boolean default true) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces; d text;
begin
  if auth.uid() is null then raise exception 'You need to sign in first'; end if;
  d := nullif(lower(trim(create_workspace.domain)), '');
  if d is not null and public.is_public_mail_domain(d) then d := null; end if;
  insert into public.workspaces (id, user_id, name, domain, domain_join)
  values (public.gen_ulid(), auth.uid(), coalesce(nullif(trim(create_workspace.name), ''), 'My workspace'), d, d is not null and coalesce(create_workspace.domain_join, true))
  returning * into ws;
  return ws;
end $$;

-- joining by domain refuses public domains even if a row somehow carries one
create or replace function public.join_by_domain(ws public.ulid) returns public.ulid
language plpgsql security definer set search_path = public as $$
declare w public.workspaces;
begin
  select * into w from public.workspaces x where x.id = ws and x.deleted_at is null;
  if w.id is null then raise exception 'That workspace no longer exists'; end if;
  if w.domain is null or not w.domain_join or public.is_public_mail_domain(w.domain)
     or w.domain <> lower(split_part(coalesce(auth.email(), ''), '@', 2)) then raise exception 'Your email domain does not match this workspace'; end if;
  insert into public.members (id, user_id, workspace_id, role) values (public.gen_ulid(), auth.uid(), w.id, 'member')
  on conflict (workspace_id, user_id) do update set deleted_at = null;
  return w.id;
end $$;

create or replace function public.domain_workspaces() returns table (workspace_id public.ulid, name text)
language sql stable security definer set search_path = public as $$
  select w.id, w.name from public.workspaces w
  where w.domain is not null and w.domain_join and w.deleted_at is null and not public.is_public_mail_domain(w.domain)
    and w.domain = lower(split_part(coalesce(auth.email(), ''), '@', 2)) and w.domain <> ''
    and not exists (select 1 from public.members m where m.workspace_id = w.id and m.user_id = auth.uid() and m.deleted_at is null)
  order by w.name;
$$;
