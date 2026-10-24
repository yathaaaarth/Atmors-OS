-- Phase 1 foundation: identity/access, prospects core, audit and workflow events.
--
-- Security model (see docs/architecture/authorization.md):
--   * RLS is enabled on every public table. Client sessions (anon/authenticated)
--     only ever get the narrow table grants listed explicitly below.
--   * Multi-record or privileged writes go through SECURITY DEFINER RPCs that
--     re-check permissions, write the change, audit and workflow event in one
--     transaction.
--   * Permission helpers live in the non-exposed `private` schema.

-- ---------------------------------------------------------------------------
-- Schemas and default privileges
-- ---------------------------------------------------------------------------

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- Supabase grants broad default privileges on new public tables. Tighten them
-- so every grant to a client role below is explicit.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.member_role as enum ('ceo', 'cto_coo', 'delivery');
create type public.member_status as enum ('invited', 'active', 'suspended', 'revoked');
create type public.profile_status as enum ('active', 'disabled');
create type public.actor_type as enum ('user', 'client', 'system');
create type public.prospect_status as enum (
  'new', 'contacted', 'engaged', 'proposal_sent',
  'converted', 'declined', 'disqualified', 'archived'
);

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create function private.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'APPEND_ONLY',
    detail = format('%s is append-only; %s is not permitted', tg_table_name, tg_op);
end;
$$;

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  slug text not null unique check (slug ~ '^[a-z0-9-]{2,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  display_name text not null default '' check (length(display_name) <= 120),
  status public.profile_status not null default 'active',
  timezone text not null default 'Asia/Kolkata' check (length(timezone) <= 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  role public.member_role not null,
  status public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_memberships_user_id_idx on public.organization_memberships (user_id);

-- Versioned role -> permission policy. The application mirrors the permission
-- key list in src/server/authorization/permissions.ts; this table is the
-- authoritative grant.
create table public.role_permissions (
  role public.member_role not null,
  permission_key text not null check (permission_key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  allowed boolean not null default true,
  policy_version integer not null default 1 check (policy_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (role, permission_key)
);

create trigger organizations_set_updated_at before update on public.organizations
  for each row execute function private.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function private.set_updated_at();
create trigger organization_memberships_set_updated_at before update on public.organization_memberships
  for each row execute function private.set_updated_at();
create trigger role_permissions_set_updated_at before update on public.role_permissions
  for each row execute function private.set_updated_at();

-- Keep profiles in step with auth.users.
create function private.handle_auth_user_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(left(new.raw_user_meta_data ->> 'display_name', 120), '')
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_auth_user_change();

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function private.handle_auth_user_change();

-- ---------------------------------------------------------------------------
-- Permission helpers (used by RLS policies and RPCs)
-- ---------------------------------------------------------------------------

create function private.is_active_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and p.status = 'active'
  );
$$;

create function private.has_permission(p_organization_id uuid, p_permission_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships m
    join public.profiles p on p.id = m.user_id
    join public.role_permissions rp on rp.role = m.role
    where m.organization_id = p_organization_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and p.status = 'active'
      and rp.permission_key = p_permission_key
      and rp.allowed
  );
$$;

-- True when the caller is an active member of an organization the target user
-- also belongs to (any membership status), so teammates can see names.
create function private.shares_active_organization(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships target
    where target.user_id = p_user_id
      and private.is_active_member(target.organization_id)
  );
$$;

revoke all on function private.is_active_member(uuid) from public;
revoke all on function private.has_permission(uuid, text) from public;
revoke all on function private.shares_active_organization(uuid) from public;
grant execute on function private.is_active_member(uuid) to authenticated, service_role;
grant execute on function private.has_permission(uuid, text) to authenticated, service_role;
grant execute on function private.shares_active_organization(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- CRM core: prospects
-- ---------------------------------------------------------------------------

create table public.prospects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  owner_user_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  company text check (length(company) <= 200),
  email text check (length(email) <= 320),
  normalized_email text generated always as (lower(btrim(email))) stored,
  contact_channel text not null default 'email'
    check (contact_channel in ('email', 'phone', 'linkedin', 'whatsapp', 'other')),
  contact_handle text check (length(contact_handle) <= 320),
  source text check (length(source) <= 120),
  target_service text check (length(target_service) <= 120),
  notes text check (length(notes) <= 10000),
  status public.prospect_status not null default 'new',
  next_action_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The owner must be a member of the same organization.
  foreign key (organization_id, owner_user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete restrict
);

create unique index prospects_org_normalized_email_key
  on public.prospects (organization_id, normalized_email)
  where normalized_email is not null;
create index prospects_org_status_idx on public.prospects (organization_id, status);
create index prospects_owner_idx on public.prospects (owner_user_id);
create index prospects_next_action_idx on public.prospects (organization_id, next_action_at)
  where next_action_at is not null;
create index prospects_created_by_idx on public.prospects (created_by);

create trigger prospects_set_updated_at before update on public.prospects
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log and workflow events (append-only)
-- ---------------------------------------------------------------------------

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  actor_type public.actor_type not null,
  actor_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text not null check (length(entity_type) <= 64),
  entity_id uuid,
  before_summary jsonb,
  after_summary jsonb,
  reason text check (length(reason) <= 2000),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  occurred_at timestamptz not null default now()
);

create index audit_logs_org_occurred_idx on public.audit_logs (organization_id, occurred_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_correlation_idx on public.audit_logs (correlation_id);

create table public.workflow_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  aggregate_type text not null check (length(aggregate_type) <= 64),
  aggregate_id uuid not null,
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  payload_json jsonb not null default '{}'::jsonb,
  source text not null check (source in ('app', 'system', 'webhook', 'migration')),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  occurred_at timestamptz not null default now()
);

create index workflow_events_aggregate_idx
  on public.workflow_events (aggregate_type, aggregate_id, occurred_at);
create index workflow_events_org_occurred_idx on public.workflow_events (organization_id, occurred_at desc);

create trigger audit_logs_append_only before update or delete on public.audit_logs
  for each row execute function private.reject_mutation();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function private.reject_mutation();
create trigger workflow_events_append_only before update or delete on public.workflow_events
  for each row execute function private.reject_mutation();
create trigger workflow_events_no_truncate before truncate on public.workflow_events
  for each statement execute function private.reject_mutation();

create function private.write_audit(
  p_organization_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb,
  p_after jsonb,
  p_reason text,
  p_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_id uuid;
begin
  insert into public.audit_logs (
    organization_id, actor_type, actor_id, action, entity_type, entity_id,
    before_summary, after_summary, reason, correlation_id
  )
  values (
    p_organization_id,
    case when v_actor is null then 'system'::public.actor_type else 'user'::public.actor_type end,
    v_actor, p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_reason, p_correlation_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function private.write_workflow_event(
  p_organization_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.workflow_events (
    organization_id, aggregate_type, aggregate_id, event_type, payload_json, source, correlation_id
  )
  values (
    p_organization_id, p_aggregate_type, p_aggregate_id, p_event_type,
    coalesce(p_payload, '{}'::jsonb), 'app', p_correlation_id
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function private.write_audit(uuid, text, text, uuid, jsonb, jsonb, text, text) from public;
revoke all on function private.write_workflow_event(uuid, text, uuid, text, jsonb, text) from public;
grant execute on function private.write_audit(uuid, text, text, uuid, jsonb, jsonb, text, text) to service_role;
grant execute on function private.write_workflow_event(uuid, text, uuid, text, jsonb, text) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.organization_memberships enable row level security;
alter table public.role_permissions enable row level security;
alter table public.prospects enable row level security;
alter table public.audit_logs enable row level security;
alter table public.workflow_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;

-- organizations: visible to active members.
grant select on public.organizations to authenticated;
create policy organizations_select_member on public.organizations
  for select to authenticated
  using ((select private.is_active_member(id)));

-- profiles: own profile, plus profiles of people who share an active organization.
grant select on public.profiles to authenticated;
grant update (display_name, timezone) on public.profiles to authenticated;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_select_org_peers on public.profiles
  for select to authenticated
  using ((select private.shares_active_organization(id)));
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- memberships: own rows; whole organization with members.read.
grant select on public.organization_memberships to authenticated;
create policy memberships_select_self on public.organization_memberships
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy memberships_select_with_permission on public.organization_memberships
  for select to authenticated
  using ((select private.has_permission(organization_id, 'members.read')));

-- role_permissions: readable so the app can resolve the caller's permissions.
grant select on public.role_permissions to authenticated;
create policy role_permissions_select_authenticated on public.role_permissions
  for select to authenticated
  using (true);

-- prospects: everything with prospects.read_all, otherwise only owned records.
-- No direct writes from client sessions; CRM write RPCs arrive in Phase 2.
grant select on public.prospects to authenticated;
create policy prospects_select_all_with_permission on public.prospects
  for select to authenticated
  using ((select private.has_permission(organization_id, 'prospects.read_all')));
create policy prospects_select_owned on public.prospects
  for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    and (select private.is_active_member(organization_id))
  );

-- audit_logs / workflow_events: read with audit.read; written only by RPCs.
grant select on public.audit_logs to authenticated;
create policy audit_logs_select_with_permission on public.audit_logs
  for select to authenticated
  using (
    organization_id is not null
    and (select private.has_permission(organization_id, 'audit.read'))
  );

grant select on public.workflow_events to authenticated;
create policy workflow_events_select_with_permission on public.workflow_events
  for select to authenticated
  using (
    organization_id is not null
    and (select private.has_permission(organization_id, 'audit.read'))
  );

-- Even the service role must not rewrite history.
revoke update, delete, truncate on public.audit_logs from service_role;
revoke update, delete, truncate on public.workflow_events from service_role;

-- ---------------------------------------------------------------------------
-- RPC: update a membership's role and/or status (audited)
-- ---------------------------------------------------------------------------
-- Errors are raised with the application's stable error code as the message;
-- src/server/errors.ts maps them to the API error envelope.

create function public.update_membership(
  p_membership_id uuid,
  p_role public.member_role default null,
  p_status public.member_status default null,
  p_reason text default null,
  p_correlation_id text default null
)
returns public.organization_memberships
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_before public.organization_memberships;
  v_after public.organization_memberships;
begin
  if v_actor is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;

  if p_correlation_id is null or length(p_correlation_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'correlation_id is required';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'reason must be between 3 and 2000 characters';
  end if;

  if p_role is null and p_status is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'role or status must be provided';
  end if;

  select * into v_before
  from public.organization_memberships
  where id = p_membership_id
  for update;

  -- Do not reveal whether the membership exists to callers who cannot manage it.
  if not found or not private.has_permission(v_before.organization_id, 'members.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if v_before.user_id = v_actor then
    raise exception using errcode = '42501', message = 'FORBIDDEN',
      detail = 'members cannot change their own role or status';
  end if;

  if coalesce(p_role, v_before.role) = v_before.role
     and coalesce(p_status, v_before.status) = v_before.status then
    return v_before;
  end if;

  -- Because the caller must hold members.manage and cannot target themselves,
  -- an organization always keeps at least one active member manager.

  update public.organization_memberships
  set role = coalesce(p_role, role),
      status = coalesce(p_status, status)
  where id = p_membership_id
  returning * into v_after;

  perform private.write_audit(
    v_after.organization_id,
    'membership.updated',
    'organization_membership',
    v_after.id,
    jsonb_build_object('role', v_before.role, 'status', v_before.status),
    jsonb_build_object('role', v_after.role, 'status', v_after.status),
    p_reason,
    p_correlation_id
  );

  perform private.write_workflow_event(
    v_after.organization_id,
    'organization_membership',
    v_after.id,
    'membership.updated',
    jsonb_build_object(
      'user_id', v_after.user_id,
      'previous', jsonb_build_object('role', v_before.role, 'status', v_before.status),
      'current', jsonb_build_object('role', v_after.role, 'status', v_after.status)
    ),
    p_correlation_id
  );

  return v_after;
end;
$$;

revoke all on function public.update_membership(uuid, public.member_role, public.member_status, text, text) from public, anon;
grant execute on function public.update_membership(uuid, public.member_role, public.member_status, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed: role permission policy v1 (see docs/architecture/authorization.md)
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, permission_key) values
  -- CEO: commercial ownership, pricing, contracts and revenue visibility.
  ('ceo', 'members.read'),
  ('ceo', 'prospects.read_all'),
  ('ceo', 'prospects.write'),
  ('ceo', 'proposals.manage'),
  ('ceo', 'proposals.approve'),
  ('ceo', 'pricing.read'),
  ('ceo', 'finance.read'),
  ('ceo', 'contracts.manage'),
  ('ceo', 'audit.read'),
  -- CTO/COO: system configuration, operations, assignments and audit.
  ('cto_coo', 'members.read'),
  ('cto_coo', 'members.manage'),
  ('cto_coo', 'prospects.read_all'),
  ('cto_coo', 'prospects.write'),
  ('cto_coo', 'operations.manage'),
  ('cto_coo', 'system.configure'),
  ('cto_coo', 'audit.read');
  -- delivery: no organization-wide grants; access comes from assignments.
