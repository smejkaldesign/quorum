-- applied-when: select exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'stripe_subscription_id')
-- Billing: one Stripe subscription per workspace. The relay's webhook (relay/billing.js) writes these columns with the
-- service role; members read them through workspace_billing. plan stays the switch everything else checks: paid after
-- checkout, free again when the subscription ends; cloud and internal are set by hand on the Platform page.
alter table public.workspaces
  add column stripe_customer_id text,
  add column stripe_subscription_id text,
  add column billing_status text,
  add column current_period_end timestamptz;
create unique index workspaces_stripe_customer on public.workspaces (stripe_customer_id) where stripe_customer_id is not null;
create unique index workspaces_stripe_subscription on public.workspaces (stripe_subscription_id) where stripe_subscription_id is not null;

create or replace function public.workspace_billing(workspace_id public.ulid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare out jsonb;
begin
  if not public.is_member(workspace_billing.workspace_id) then raise exception 'You are not a member of that workspace'; end if;
  select jsonb_build_object('plan', w.plan, 'seats', w.seats, 'seats_included', w.seats_included, 'hour_packs', w.hour_packs, 'billing_status', w.billing_status,
                            'current_period_end', w.current_period_end, 'subscribed', w.stripe_subscription_id is not null, 'members', (select count(*) from public.members m where m.workspace_id = w.id and m.deleted_at is null))
    into out from public.workspaces w where w.id = workspace_billing.workspace_id and w.deleted_at is null;
  if out is null then raise exception 'That workspace no longer exists'; end if;
  return out;
end $$;
revoke all on function public.workspace_billing(public.ulid) from public, anon;
grant execute on function public.workspace_billing(public.ulid) to authenticated, service_role;
