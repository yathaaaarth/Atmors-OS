-- Phase 2: CRM, invitations, custom proposals and the proof library.
-- PRD §4 (state machines), §5.1–5.3, §8; acceptance tests AT-001–AT-009.
--
-- Conventions (see docs/architecture/authorization.md):
--   * Staff read through RLS; every write is a SECURITY DEFINER RPC that
--     re-checks permission and records audit + workflow events atomically.
--   * Clients and prospects never read tables directly. They receive a
--     client-safe JSON projection from RPCs, so internal fields cannot leak.
--   * Money is bigint minor units with an ISO currency; never floating point.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.proposal_status as enum (
  'draft', 'internal_review', 'approved', 'sent', 'viewed',
  'negotiation', 'accepted', 'declined', 'expired', 'withdrawn'
);

create type public.proposal_version_status as enum (
  'draft', 'pending_approval', 'approved', 'sent', 'superseded', 'accepted'
);

create type public.proof_kind as enum ('testimonial', 'case_study');

create type public.proof_publication_status as enum (
  'draft', 'permission_requested', 'approved', 'published', 'withdrawn', 'rejected'
);

create type public.client_access_status as enum ('active', 'revoked');

-- ---------------------------------------------------------------------------
-- Permissions (policy v2)
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, permission_key, policy_version) values
  ('ceo', 'proposals.read_all', 2),
  ('ceo', 'proof.read', 2),
  ('ceo', 'proof.manage', 2),
  ('ceo', 'proof.approve', 2),
  ('cto_coo', 'proof.read', 2),
  ('cto_coo', 'proof.manage', 2),
  ('sales', 'prospects.create', 2),
  ('sales', 'prospects.write_own', 2),
  ('sales', 'proposals.manage_own', 2),
  ('sales', 'proof.read', 2);

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Business-day boundaries use the Atmors operating timezone.
create function private.today_ist()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Kolkata')::date;
$$;

create function private.current_user_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(u.email)) from auth.users u where u.id = (select auth.uid());
$$;

create function private.mask_email(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_email is null or position('@' in p_email) < 2 then null
    else left(p_email, 1) || repeat('•', greatest(position('@' in p_email) - 2, 1))
         || substr(p_email, position('@' in p_email))
  end;
$$;

-- Audit actor type now distinguishes clients from internal users.
create or replace function private.write_audit(
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
  v_actor_type public.actor_type;
  v_id uuid;
begin
  v_actor_type := case
    when v_actor is null then 'system'
    when exists (
      select 1 from public.organization_memberships m
      where m.user_id = v_actor and m.organization_id = p_organization_id
    ) then 'user'
    else 'client'
  end;

  insert into public.audit_logs (
    organization_id, actor_type, actor_id, action, entity_type, entity_id,
    before_summary, after_summary, reason, correlation_id
  )
  values (
    p_organization_id, v_actor_type, v_actor, p_action, p_entity_type, p_entity_id,
    p_before, p_after, p_reason, coalesce(p_correlation_id, gen_random_uuid()::text)
  )
  returning id into v_id;
  return v_id;
end;
$$;

create function private.require_reason(p_reason text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_reason is null or length(btrim(p_reason)) < 3 or length(p_reason) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'reason must be between 3 and 2000 characters';
  end if;
end;
$$;

create function private.require_correlation_id(p_correlation_id text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_correlation_id is null or length(p_correlation_id) not between 1 and 128 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'correlation_id is required';
  end if;
end;
$$;

create function private.require_user()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception using errcode = '28000', message = 'UNAUTHENTICATED';
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prospect access helpers and lifecycle
-- ---------------------------------------------------------------------------

create function private.can_read_prospect(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.prospects p
    where p.id = p_prospect_id
      and (
        private.has_permission(p.organization_id, 'prospects.read_all')
        or (p.owner_user_id = (select auth.uid()) and private.is_active_member(p.organization_id))
      )
  );
$$;

create function private.can_manage_prospect(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.prospects p
    where p.id = p_prospect_id
      and (
        private.has_permission(p.organization_id, 'prospects.write')
        or (
          p.owner_user_id = (select auth.uid())
          and private.has_permission(p.organization_id, 'prospects.write_own')
        )
      )
  );
$$;

-- Mirrors src/modules/crm/prospect-state.ts. The database is authoritative.
create function private.prospect_transition_allowed(
  p_from public.prospect_status,
  p_to public.prospect_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'new' then p_to in ('contacted', 'disqualified', 'archived')
    when 'contacted' then p_to in ('engaged', 'declined', 'disqualified', 'archived')
    when 'engaged' then p_to in ('proposal_sent', 'declined', 'disqualified', 'archived')
    when 'proposal_sent' then p_to in ('engaged', 'converted', 'declined', 'archived')
    when 'declined' then p_to in ('contacted', 'archived')
    when 'disqualified' then p_to in ('archived')
    when 'converted' then p_to in ('archived')
    else false
  end;
$$;

-- ---------------------------------------------------------------------------
-- Outreach history (append-only)
-- ---------------------------------------------------------------------------

create table public.outreach_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  channel text not null
    check (channel in ('email', 'phone', 'linkedin', 'whatsapp', 'meeting', 'portal', 'other')),
  direction text not null check (direction in ('outbound', 'inbound', 'internal')),
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)*$' and length(event_type) <= 64),
  summary text check (length(summary) <= 4000),
  occurred_at timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  provider_message_id text check (length(provider_message_id) <= 200),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  created_at timestamptz not null default now()
);

create index outreach_events_prospect_idx on public.outreach_events (prospect_id, occurred_at desc);
create index outreach_events_org_idx on public.outreach_events (organization_id, occurred_at desc);

create trigger outreach_events_append_only before update or delete on public.outreach_events
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------
-- Proof library (testimonials and case studies)
-- ---------------------------------------------------------------------------
-- One table for both kinds keeps permission, publication and withdrawal rules
-- in one place (decision D-007).

create table public.proof_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind public.proof_kind not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  quote text check (length(quote) <= 2000),
  author_name text check (length(author_name) <= 120),
  author_role text check (length(author_role) <= 120),
  company_name text check (length(company_name) <= 200),
  narrative text check (length(narrative) <= 20000),
  -- [{label, value, kind: measured|client_reported, period, evidence_ref}]
  metrics jsonb not null default '[]'::jsonb check (jsonb_typeof(metrics) = 'array'),
  audience_tags text[] not null default '{}',
  permitted_channels text[] not null default '{proposal}',
  source_evidence_ref text check (length(source_evidence_ref) <= 1000),
  permission_evidence_ref text check (length(permission_evidence_ref) <= 1000),
  permission_expires_on date,
  client_prospect_id uuid references public.prospects (id) on delete set null,
  publication_status public.proof_publication_status not null default 'draft',
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_reason text check (length(withdrawn_reason) <= 2000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'testimonial' or (quote is not null and length(btrim(quote)) > 0)),
  check (kind <> 'case_study' or (narrative is not null and length(btrim(narrative)) > 0))
);

create index proof_assets_org_status_idx on public.proof_assets (organization_id, publication_status);

create trigger proof_assets_set_updated_at before update on public.proof_assets
  for each row execute function private.set_updated_at();

-- AT-009: only approved/published, unexpired, unwithdrawn proof reaches prospects.
create function private.proof_is_visible(p_asset public.proof_assets)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_asset.publication_status in ('approved', 'published')
    and p_asset.withdrawn_at is null
    and (p_asset.permission_expires_on is null or p_asset.permission_expires_on >= private.today_ist())
    and 'proposal' = any (p_asset.permitted_channels);
$$;

-- ---------------------------------------------------------------------------
-- Proposals
-- ---------------------------------------------------------------------------

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  owner_user_id uuid not null,
  title text not null check (length(btrim(title)) between 1 and 200),
  status public.proposal_status not null default 'draft',
  internal_notes text check (length(internal_notes) <= 10000),
  current_version_id uuid,
  sent_version_id uuid,
  accepted_version_id uuid,
  sent_at timestamptz,
  first_viewed_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  declined_at timestamptz,
  decline_reason text check (length(decline_reason) <= 2000),
  withdrawn_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, owner_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

create index proposals_org_status_idx on public.proposals (organization_id, status);
create index proposals_prospect_idx on public.proposals (prospect_id);
create index proposals_owner_idx on public.proposals (owner_user_id);

create trigger proposals_set_updated_at before update on public.proposals
  for each row execute function private.set_updated_at();

create table public.proposal_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  version_number integer not null check (version_number > 0),
  status public.proposal_version_status not null default 'draft',
  currency char(3) not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  -- {summary, scope, deliverables[], timeline, dependencies[], assumptions[], exclusions[], terms}
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  -- [{label, basis: percent|fixed, percent_bps|amount_minor, due, due_date?, milestone?}]
  payment_schedule jsonb not null default '[]'::jsonb check (jsonb_typeof(payment_schedule) = 'array'),
  valid_until date,
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_minor bigint not null default 0 check (tax_minor >= 0),
  total_minor bigint not null default 0 check (total_minor >= 0),
  non_standard_terms boolean not null default false,
  margin_exception boolean not null default false,
  requires_approval boolean not null default false,
  approval_reasons text[] not null default '{}',
  change_summary text check (length(change_summary) <= 2000),
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles (id) on delete set null,
  submitted_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  approval_note text check (length(approval_note) <= 2000),
  sent_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, version_number),
  check (total_minor = subtotal_minor - discount_minor + tax_minor),
  check (discount_minor <= subtotal_minor)
);

create index proposal_versions_proposal_idx on public.proposal_versions (proposal_id, version_number desc);
create index proposal_versions_pending_idx on public.proposal_versions (organization_id)
  where status = 'pending_approval';

create trigger proposal_versions_set_updated_at before update on public.proposal_versions
  for each row execute function private.set_updated_at();

alter table public.proposals
  add constraint proposals_current_version_fkey
    foreign key (current_version_id) references public.proposal_versions (id) on delete restrict,
  add constraint proposals_sent_version_fkey
    foreign key (sent_version_id) references public.proposal_versions (id) on delete restrict,
  add constraint proposals_accepted_version_fkey
    foreign key (accepted_version_id) references public.proposal_versions (id) on delete restrict;

create table public.proposal_line_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  version_id uuid not null references public.proposal_versions (id) on delete cascade,
  position integer not null check (position >= 0),
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  quantity numeric(12, 2) not null check (quantity > 0 and quantity <= 1000000),
  unit text check (length(unit) <= 40),
  unit_amount_minor bigint not null check (unit_amount_minor >= 0),
  discount_minor bigint not null default 0 check (discount_minor >= 0),
  tax_rate_bps integer not null default 0 check (tax_rate_bps between 0 and 10000),
  billing_timing text not null default 'upfront'
    check (billing_timing in ('upfront', 'milestone', 'monthly', 'on_completion')),
  gross_minor bigint not null,
  net_minor bigint not null,
  tax_minor bigint not null,
  total_minor bigint not null,
  unique (version_id, position),
  -- Amounts are derived, never trusted from input (AT-005).
  check (gross_minor = round(quantity * unit_amount_minor)),
  check (discount_minor <= gross_minor),
  check (net_minor = gross_minor - discount_minor),
  check (tax_minor = round(net_minor * tax_rate_bps / 10000.0)),
  check (total_minor = net_minor + tax_minor)
);

create index proposal_line_items_proposal_idx on public.proposal_line_items (proposal_id);

create table public.proposal_proof (
  version_id uuid not null references public.proposal_versions (id) on delete cascade,
  proof_asset_id uuid not null references public.proof_assets (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  position integer not null check (position >= 0),
  primary key (version_id, proof_asset_id)
);

create index proposal_proof_asset_idx on public.proposal_proof (proof_asset_id);

create table public.proposal_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  version_id uuid references public.proposal_versions (id) on delete restrict,
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  actor_type public.actor_type not null,
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  occurred_at timestamptz not null default now()
);

create index proposal_events_proposal_idx on public.proposal_events (proposal_id, occurred_at);

create trigger proposal_events_append_only before update or delete on public.proposal_events
  for each row execute function private.reject_mutation();

-- Submitted versions are immutable; edits create a new version (AT-006).
create function private.guard_proposal_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'proposal versions are never deleted';
  end if;

  if old.status <> 'draft' and (
       new.proposal_id, new.version_number, new.currency, new.content, new.payment_schedule,
       new.valid_until, new.subtotal_minor, new.discount_minor, new.tax_minor, new.total_minor,
       new.non_standard_terms, new.margin_exception, new.requires_approval, new.approval_reasons,
       new.change_summary
     ) is distinct from (
       old.proposal_id, old.version_number, old.currency, old.content, old.payment_schedule,
       old.valid_until, old.subtotal_minor, old.discount_minor, old.tax_minor, old.total_minor,
       old.non_standard_terms, old.margin_exception, old.requires_approval, old.approval_reasons,
       old.change_summary
     ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'proposal version content is immutable once submitted';
  end if;

  if old.status in ('sent', 'superseded', 'accepted') and new.content_hash is distinct from old.content_hash then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'content hash of a sent version cannot change';
  end if;

  return new;
end;
$$;

create trigger proposal_versions_guard before update or delete on public.proposal_versions
  for each row execute function private.guard_proposal_version();

create function private.guard_version_children()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_status public.proposal_version_status;
begin
  v_version_id := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
  select status into v_status from public.proposal_versions where id = v_version_id;
  -- A cascading delete of the parent is impossible (versions are never deleted).
  if v_status is distinct from 'draft' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'line items and proof are immutable once a version is submitted';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger proposal_line_items_guard before insert or update or delete on public.proposal_line_items
  for each row execute function private.guard_version_children();
create trigger proposal_proof_guard before insert or update or delete on public.proposal_proof
  for each row execute function private.guard_version_children();

create function private.can_read_proposal(p_proposal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.proposals p
    where p.id = p_proposal_id
      and (
        private.has_permission(p.organization_id, 'proposals.read_all')
        or private.has_permission(p.organization_id, 'proposals.manage')
        or (p.owner_user_id = (select auth.uid()) and private.is_active_member(p.organization_id))
      )
  );
$$;

create function private.can_manage_proposal(p_proposal_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.proposals p
    where p.id = p_proposal_id
      and (
        private.has_permission(p.organization_id, 'proposals.manage')
        or (
          p.owner_user_id = (select auth.uid())
          and private.has_permission(p.organization_id, 'proposals.manage_own')
        )
      )
  );
$$;

create function private.record_proposal_event(
  p_proposal public.proposals,
  p_version_id uuid,
  p_event_type text,
  p_metadata jsonb,
  p_correlation_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_correlation text := coalesce(p_correlation_id, gen_random_uuid()::text);
begin
  insert into public.proposal_events (
    organization_id, proposal_id, version_id, event_type, actor_type, actor_id, metadata, correlation_id
  )
  values (
    p_proposal.organization_id, p_proposal.id, p_version_id, p_event_type,
    case
      when v_actor is null then 'system'::public.actor_type
      when private.is_active_member(p_proposal.organization_id) then 'user'::public.actor_type
      else 'client'::public.actor_type
    end,
    v_actor, coalesce(p_metadata, '{}'::jsonb), v_correlation
  );
  perform private.write_workflow_event(
    p_proposal.organization_id, 'proposal', p_proposal.id, p_event_type,
    coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('version_id', p_version_id),
    v_correlation
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Invitations and client access
-- ---------------------------------------------------------------------------

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  proposal_id uuid references public.proposals (id) on delete restrict,
  -- sha256 of the random token; the token itself is never stored (PRD §5.1).
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scope text not null default 'proposal_view' check (scope in ('proposal_view')),
  expires_at timestamptz not null,
  sent_at timestamptz,
  opened_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by uuid references auth.users (id) on delete set null,
  revoked_at timestamptz,
  revoked_reason text check (length(revoked_reason) <= 2000),
  replaced_by uuid references public.invitations (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index invitations_prospect_idx on public.invitations (prospect_id, created_at desc);

create trigger invitations_set_updated_at before update on public.invitations
  for each row execute function private.set_updated_at();

create table public.client_access (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete cascade,
  invitation_id uuid references public.invitations (id) on delete set null,
  status public.client_access_status not null default 'active',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (prospect_id, user_id)
);

create index client_access_user_idx on public.client_access (user_id) where status = 'active';

create function private.client_has_access(p_prospect_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.client_access ca
    where ca.prospect_id = p_prospect_id
      and ca.user_id = (select auth.uid())
      and ca.status = 'active'
  );
$$;

create function private.invitation_state(p_invitation public.invitations)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_invitation.revoked_at is not null then 'revoked'
    when p_invitation.redeemed_at is not null then 'redeemed'
    when p_invitation.expires_at <= now() then 'expired'
    when p_invitation.opened_at is not null then 'opened'
    when p_invitation.sent_at is not null then 'sent'
    else 'created'
  end;
$$;

-- ---------------------------------------------------------------------------
-- Client-safe projections
-- ---------------------------------------------------------------------------

-- Exactly the terms a client sees and accepts; hashed into content_hash.
create function private.version_terms_json(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'version_number', v.version_number,
    'currency', v.currency,
    'valid_until', v.valid_until,
    'content', v.content,
    'payment_schedule', v.payment_schedule,
    'subtotal_minor', v.subtotal_minor,
    'discount_minor', v.discount_minor,
    'tax_minor', v.tax_minor,
    'total_minor', v.total_minor,
    'line_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', li.title,
        'description', li.description,
        'quantity', li.quantity,
        'unit', li.unit,
        'unit_amount_minor', li.unit_amount_minor,
        'discount_minor', li.discount_minor,
        'tax_rate_bps', li.tax_rate_bps,
        'billing_timing', li.billing_timing,
        'gross_minor', li.gross_minor,
        'net_minor', li.net_minor,
        'tax_minor', li.tax_minor,
        'total_minor', li.total_minor
      ) order by li.position)
      from public.proposal_line_items li
      where li.version_id = v.id
    ), '[]'::jsonb)
  )
  from public.proposal_versions v
  where v.id = p_version_id;
$$;

create function private.client_version_json(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.version_terms_json(v.id) || jsonb_build_object(
    'id', v.id,
    'content_hash', v.content_hash,
    'change_summary', v.change_summary,
    'sent_at', v.sent_at,
    'is_expired', v.valid_until < private.today_ist()
  )
  from public.proposal_versions v
  where v.id = p_version_id;
$$;

create function private.client_proof_json(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id,
    'kind', a.kind,
    'title', a.title,
    'quote', a.quote,
    'author_name', a.author_name,
    'author_role', a.author_role,
    'company_name', a.company_name,
    'narrative', a.narrative,
    'metrics', a.metrics
  ) order by pp.position), '[]'::jsonb)
  from public.proposal_proof pp
  join public.proof_assets a on a.id = pp.proof_asset_id
  where pp.version_id = p_version_id
    and private.proof_is_visible(a);
$$;

create function private.client_proposal_json(p_proposal_id uuid, p_mark_viewed boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals;
  v_previous_id uuid;
  v_org_name text;
  v_prospect public.prospects;
begin
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then
    return null;
  end if;

  select name into v_org_name from public.organizations where id = v_proposal.organization_id;
  select * into v_prospect from public.prospects where id = v_proposal.prospect_id;

  if v_proposal.sent_version_id is null or v_proposal.status = 'withdrawn' then
    return jsonb_build_object(
      'proposal', jsonb_build_object(
        'id', v_proposal.id,
        'title', v_proposal.title,
        'status', case when v_proposal.status = 'withdrawn' then 'withdrawn' else 'preparing' end
      ),
      'organization_name', v_org_name,
      'prospect', jsonb_build_object('name', v_prospect.name, 'company', v_prospect.company),
      'version', null,
      'previous_version', null,
      'proof', '[]'::jsonb
    );
  end if;

  if p_mark_viewed and v_proposal.status = 'sent' then
    update public.proposals
    set status = 'viewed', first_viewed_at = coalesce(first_viewed_at, now())
    where id = v_proposal.id
    returning * into v_proposal;
    perform private.record_proposal_event(v_proposal, v_proposal.sent_version_id, 'proposal.viewed', '{}'::jsonb, null);
  end if;

  select v.id into v_previous_id
  from public.proposal_versions v
  where v.proposal_id = v_proposal.id
    and v.sent_at is not null
    and v.id <> v_proposal.sent_version_id
  order by v.version_number desc
  limit 1;

  return jsonb_build_object(
    'proposal', jsonb_build_object(
      'id', v_proposal.id,
      'title', v_proposal.title,
      'status', v_proposal.status,
      'accepted_version_id', v_proposal.accepted_version_id,
      'accepted_at', v_proposal.accepted_at,
      'declined_at', v_proposal.declined_at
    ),
    'organization_name', v_org_name,
    'prospect', jsonb_build_object('name', v_prospect.name, 'company', v_prospect.company),
    'version', private.client_version_json(v_proposal.sent_version_id),
    'previous_version', case when v_previous_id is not null then private.client_version_json(v_previous_id) end,
    'proof', private.client_proof_json(v_proposal.sent_version_id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security for new tables (staff reads only)
-- ---------------------------------------------------------------------------

alter table public.outreach_events enable row level security;
alter table public.proof_assets enable row level security;
alter table public.proposals enable row level security;
alter table public.proposal_versions enable row level security;
alter table public.proposal_line_items enable row level security;
alter table public.proposal_proof enable row level security;
alter table public.proposal_events enable row level security;
alter table public.invitations enable row level security;
alter table public.client_access enable row level security;

revoke all on public.outreach_events, public.proof_assets, public.proposals, public.proposal_versions,
  public.proposal_line_items, public.proposal_proof, public.proposal_events, public.invitations,
  public.client_access from anon, authenticated;

grant select on public.outreach_events to authenticated;
create policy outreach_events_select on public.outreach_events
  for select to authenticated
  using ((select private.can_read_prospect(prospect_id)));

grant select on public.proof_assets to authenticated;
create policy proof_assets_select on public.proof_assets
  for select to authenticated
  using ((select private.has_permission(organization_id, 'proof.read')));

grant select on public.proposals to authenticated;
create policy proposals_select on public.proposals
  for select to authenticated
  using ((select private.can_read_proposal(id)));

grant select on public.proposal_versions to authenticated;
create policy proposal_versions_select on public.proposal_versions
  for select to authenticated
  using ((select private.can_read_proposal(proposal_id)));

grant select on public.proposal_line_items to authenticated;
create policy proposal_line_items_select on public.proposal_line_items
  for select to authenticated
  using ((select private.can_read_proposal(proposal_id)));

grant select on public.proposal_proof to authenticated;
create policy proposal_proof_select on public.proposal_proof
  for select to authenticated
  using ((select private.can_read_proposal(proposal_id)));

grant select on public.proposal_events to authenticated;
create policy proposal_events_select on public.proposal_events
  for select to authenticated
  using ((select private.can_read_proposal(proposal_id)));

-- token_hash is deliberately not readable from client sessions.
grant select (
  id, organization_id, prospect_id, proposal_id, scope, expires_at, sent_at, opened_at,
  redeemed_at, redeemed_by, revoked_at, revoked_reason, replaced_by, created_by, created_at, updated_at
) on public.invitations to authenticated;
create policy invitations_select on public.invitations
  for select to authenticated
  using ((select private.can_read_prospect(prospect_id)));

grant select on public.client_access to authenticated;
create policy client_access_select_staff on public.client_access
  for select to authenticated
  using ((select private.can_read_prospect(prospect_id)));
create policy client_access_select_self on public.client_access
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ===========================================================================
-- RPCs: prospects and outreach
-- ===========================================================================

create function public.create_prospect(
  p_organization_id uuid,
  p_owner_user_id uuid,
  p_name text,
  p_company text default null,
  p_email text default null,
  p_contact_channel text default 'email',
  p_contact_handle text default null,
  p_source text default null,
  p_target_service text default null,
  p_notes text default null,
  p_next_action_at timestamptz default null,
  p_correlation_id text default null
)
returns public.prospects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.prospects;
begin
  perform private.require_correlation_id(p_correlation_id);

  if not (
    private.has_permission(p_organization_id, 'prospects.write')
    or (private.has_permission(p_organization_id, 'prospects.create') and p_owner_user_id = v_uid)
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_owner_user_id and m.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'owner must be an active member';
  end if;

  if p_email is not null and exists (
    select 1 from public.prospects
    where organization_id = p_organization_id and normalized_email = lower(btrim(p_email))
  ) then
    raise exception using errcode = '23505', message = 'CONFLICT', detail = 'duplicate prospect email';
  end if;

  insert into public.prospects (
    organization_id, owner_user_id, name, company, email, contact_channel, contact_handle,
    source, target_service, notes, next_action_at, created_by
  )
  values (
    p_organization_id, p_owner_user_id, btrim(p_name), nullif(btrim(p_company), ''),
    nullif(lower(btrim(p_email)), ''), p_contact_channel, nullif(btrim(p_contact_handle), ''),
    nullif(btrim(p_source), ''), nullif(btrim(p_target_service), ''), nullif(p_notes, ''),
    p_next_action_at, v_uid
  )
  returning * into v_row;

  perform private.write_audit(
    v_row.organization_id, 'prospect.created', 'prospect', v_row.id, null,
    jsonb_build_object('name', v_row.name, 'owner_user_id', v_row.owner_user_id, 'status', v_row.status),
    null, p_correlation_id
  );
  perform private.write_workflow_event(
    v_row.organization_id, 'prospect', v_row.id, 'prospect.created',
    jsonb_build_object('owner_user_id', v_row.owner_user_id), p_correlation_id
  );
  return v_row;
end;
$$;

create function public.update_prospect(
  p_prospect_id uuid,
  p_patch jsonb,
  p_correlation_id text default null
)
returns public.prospects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.prospects;
  v_after public.prospects;
  v_unknown text;
begin
  perform private.require_correlation_id(p_correlation_id);

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'patch must be an object';
  end if;

  select k into v_unknown
  from jsonb_object_keys(p_patch) as k
  where k not in ('name', 'company', 'email', 'contact_channel', 'contact_handle', 'source',
                  'target_service', 'notes', 'next_action_at', 'owner_user_id')
  limit 1;
  if v_unknown is not null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown field ' || v_unknown;
  end if;

  select * into v_before from public.prospects where id = p_prospect_id for update;
  if not found or not private.can_manage_prospect(p_prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if p_patch ? 'owner_user_id' and (p_patch ->> 'owner_user_id')::uuid is distinct from v_before.owner_user_id then
    if not private.has_permission(v_before.organization_id, 'prospects.write') then
      raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'reassigning requires prospects.write';
    end if;
    if not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = v_before.organization_id
        and m.user_id = (p_patch ->> 'owner_user_id')::uuid and m.status = 'active'
    ) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'owner must be an active member';
    end if;
  end if;

  if p_patch ? 'email' and nullif(lower(btrim(p_patch ->> 'email')), '') is not null and exists (
    select 1 from public.prospects
    where organization_id = v_before.organization_id
      and normalized_email = lower(btrim(p_patch ->> 'email'))
      and id <> v_before.id
  ) then
    raise exception using errcode = '23505', message = 'CONFLICT', detail = 'duplicate prospect email';
  end if;

  update public.prospects set
    name = case when p_patch ? 'name' then btrim(p_patch ->> 'name') else name end,
    company = case when p_patch ? 'company' then nullif(btrim(p_patch ->> 'company'), '') else company end,
    email = case when p_patch ? 'email' then nullif(lower(btrim(p_patch ->> 'email')), '') else email end,
    contact_channel = case when p_patch ? 'contact_channel' then p_patch ->> 'contact_channel' else contact_channel end,
    contact_handle = case when p_patch ? 'contact_handle' then nullif(btrim(p_patch ->> 'contact_handle'), '') else contact_handle end,
    source = case when p_patch ? 'source' then nullif(btrim(p_patch ->> 'source'), '') else source end,
    target_service = case when p_patch ? 'target_service' then nullif(btrim(p_patch ->> 'target_service'), '') else target_service end,
    notes = case when p_patch ? 'notes' then nullif(p_patch ->> 'notes', '') else notes end,
    next_action_at = case when p_patch ? 'next_action_at' then (p_patch ->> 'next_action_at')::timestamptz else next_action_at end,
    owner_user_id = case when p_patch ? 'owner_user_id' then (p_patch ->> 'owner_user_id')::uuid else owner_user_id end
  where id = p_prospect_id
  returning * into v_after;

  perform private.write_audit(
    v_after.organization_id, 'prospect.updated', 'prospect', v_after.id,
    (to_jsonb(v_before) - 'notes' - 'updated_at' - 'normalized_email')
      - array(select k from jsonb_object_keys(to_jsonb(v_before)) k where not p_patch ? k),
    (to_jsonb(v_after) - 'notes' - 'updated_at' - 'normalized_email')
      - array(select k from jsonb_object_keys(to_jsonb(v_after)) k where not p_patch ? k),
    null, p_correlation_id
  );
  return v_after;
end;
$$;

create function public.transition_prospect(
  p_prospect_id uuid,
  p_to public.prospect_status,
  p_reason text,
  p_correlation_id text default null
)
returns public.prospects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.prospects;
  v_after public.prospects;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);

  select * into v_before from public.prospects where id = p_prospect_id for update;
  if not found or not private.can_manage_prospect(p_prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if not private.prospect_transition_allowed(v_before.status, p_to) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('prospect %s -> %s', v_before.status, p_to);
  end if;

  update public.prospects set status = p_to where id = p_prospect_id returning * into v_after;

  perform private.write_audit(
    v_after.organization_id, 'prospect.status_changed', 'prospect', v_after.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status),
    p_reason, p_correlation_id
  );
  perform private.write_workflow_event(
    v_after.organization_id, 'prospect', v_after.id, 'prospect.status_changed',
    jsonb_build_object('from', v_before.status, 'to', v_after.status, 'reason', p_reason), p_correlation_id
  );
  return v_after;
end;
$$;

create function public.log_outreach(
  p_prospect_id uuid,
  p_channel text,
  p_direction text,
  p_summary text,
  p_occurred_at timestamptz default null,
  p_next_action_at timestamptz default null,
  p_correlation_id text default null
)
returns public.outreach_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_prospect public.prospects;
  v_row public.outreach_events;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_prospect from public.prospects where id = p_prospect_id for update;
  if not found or not private.can_manage_prospect(p_prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if p_occurred_at is not null and p_occurred_at > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'occurred_at is in the future';
  end if;

  insert into public.outreach_events (
    organization_id, prospect_id, channel, direction, event_type, summary, occurred_at, actor_id, correlation_id
  )
  values (
    v_prospect.organization_id, v_prospect.id, p_channel, p_direction, 'outreach.logged',
    nullif(btrim(p_summary), ''), coalesce(p_occurred_at, now()), v_uid, p_correlation_id
  )
  returning * into v_row;

  if p_next_action_at is not null then
    update public.prospects set next_action_at = p_next_action_at where id = v_prospect.id;
  end if;

  return v_row;
end;
$$;

-- ===========================================================================
-- RPCs: proof library
-- ===========================================================================

create function private.validate_proof_metrics(p_metrics jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_metric jsonb;
begin
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'array' or jsonb_array_length(p_metrics) > 20 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'metrics must be an array (max 20)';
  end if;
  for v_metric in select * from jsonb_array_elements(p_metrics) loop
    -- PRD §5.3: every numeric claim links to evidence and a defined period.
    if jsonb_typeof(v_metric) <> 'object'
       or coalesce(length(btrim(v_metric ->> 'label')), 0) = 0
       or coalesce(length(btrim(v_metric ->> 'value')), 0) = 0
       or coalesce(v_metric ->> 'kind', '') not in ('measured', 'client_reported')
       or coalesce(length(btrim(v_metric ->> 'period')), 0) = 0
       or coalesce(length(btrim(v_metric ->> 'evidence_ref')), 0) = 0 then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'each metric needs label, value, kind, period and evidence_ref';
    end if;
  end loop;
end;
$$;

create function public.save_proof_asset(
  p_organization_id uuid,
  p_id uuid,
  p_kind public.proof_kind,
  p_fields jsonb,
  p_correlation_id text default null
)
returns public.proof_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.proof_assets;
  v_row public.proof_assets;
  v_metrics jsonb := coalesce(p_fields -> 'metrics', '[]'::jsonb);
  v_channels text[];
  v_tags text[];
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id, 'proof.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  perform private.validate_proof_metrics(v_metrics);

  -- array(...) over a missing key yields '{}', not null, so default explicitly.
  v_channels := case
    when jsonb_typeof(p_fields -> 'permitted_channels') = 'array'
      then array(select jsonb_array_elements_text(p_fields -> 'permitted_channels'))
    else '{proposal}'::text[]
  end;
  v_tags := coalesce(array(select jsonb_array_elements_text(p_fields -> 'audience_tags')), '{}');

  if p_id is null then
    insert into public.proof_assets (
      organization_id, kind, title, quote, author_name, author_role, company_name, narrative, metrics,
      audience_tags, permitted_channels, source_evidence_ref, permission_evidence_ref,
      permission_expires_on, created_by
    )
    values (
      p_organization_id, p_kind, btrim(p_fields ->> 'title'), nullif(btrim(p_fields ->> 'quote'), ''),
      nullif(btrim(p_fields ->> 'author_name'), ''), nullif(btrim(p_fields ->> 'author_role'), ''),
      nullif(btrim(p_fields ->> 'company_name'), ''), nullif(btrim(p_fields ->> 'narrative'), ''),
      v_metrics, v_tags, v_channels,
      nullif(btrim(p_fields ->> 'source_evidence_ref'), ''),
      nullif(btrim(p_fields ->> 'permission_evidence_ref'), ''),
      nullif(p_fields ->> 'permission_expires_on', '')::date, v_uid
    )
    returning * into v_row;
    perform private.write_audit(p_organization_id, 'proof.created', 'proof_asset', v_row.id, null,
      jsonb_build_object('kind', v_row.kind, 'title', v_row.title), null, p_correlation_id);
    return v_row;
  end if;

  select * into v_before from public.proof_assets
  where id = p_id and organization_id = p_organization_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.kind <> p_kind then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'kind cannot change';
  end if;

  update public.proof_assets set
    title = btrim(p_fields ->> 'title'),
    quote = nullif(btrim(p_fields ->> 'quote'), ''),
    author_name = nullif(btrim(p_fields ->> 'author_name'), ''),
    author_role = nullif(btrim(p_fields ->> 'author_role'), ''),
    company_name = nullif(btrim(p_fields ->> 'company_name'), ''),
    narrative = nullif(btrim(p_fields ->> 'narrative'), ''),
    metrics = v_metrics,
    audience_tags = v_tags,
    permitted_channels = v_channels,
    source_evidence_ref = nullif(btrim(p_fields ->> 'source_evidence_ref'), ''),
    permission_evidence_ref = nullif(btrim(p_fields ->> 'permission_evidence_ref'), ''),
    permission_expires_on = nullif(p_fields ->> 'permission_expires_on', '')::date,
    -- Editing approved or published proof sends it back for review.
    publication_status = case
      when publication_status in ('approved', 'published') then 'draft'::public.proof_publication_status
      else publication_status
    end,
    reviewed_by = case when publication_status in ('approved', 'published') then null else reviewed_by end,
    reviewed_at = case when publication_status in ('approved', 'published') then null else reviewed_at end
  where id = p_id
  returning * into v_row;

  perform private.write_audit(p_organization_id, 'proof.updated', 'proof_asset', v_row.id,
    jsonb_build_object('publication_status', v_before.publication_status, 'title', v_before.title),
    jsonb_build_object('publication_status', v_row.publication_status, 'title', v_row.title),
    null, p_correlation_id);
  return v_row;
end;
$$;

create function public.transition_proof_asset(
  p_id uuid,
  p_to public.proof_publication_status,
  p_reason text default null,
  p_correlation_id text default null
)
returns public.proof_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.proof_assets;
  v_row public.proof_assets;
  v_allowed boolean;
  v_needs_approve boolean := p_to in ('approved', 'published', 'rejected');
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_before from public.proof_assets where id = p_id for update;
  if not found or not private.has_permission(v_before.organization_id,
       case when v_needs_approve then 'proof.approve' else 'proof.manage' end) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  v_allowed := case v_before.publication_status
    when 'draft' then p_to in ('permission_requested', 'approved', 'rejected')
    when 'permission_requested' then p_to in ('approved', 'rejected', 'draft')
    when 'approved' then p_to in ('published', 'withdrawn')
    when 'published' then p_to in ('withdrawn')
    when 'rejected' then p_to in ('draft')
    when 'withdrawn' then p_to in ('draft')
    else false
  end;
  if not v_allowed then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proof %s -> %s', v_before.publication_status, p_to);
  end if;

  if p_to in ('withdrawn', 'rejected') then
    perform private.require_reason(p_reason);
  end if;

  if p_to = 'approved' then
    if v_before.source_evidence_ref is null or v_before.permission_evidence_ref is null then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'approval requires source evidence and recorded permission';
    end if;
    perform private.validate_proof_metrics(v_before.metrics);
  end if;

  update public.proof_assets set
    publication_status = p_to,
    reviewed_by = case when p_to in ('approved', 'rejected') then v_uid else reviewed_by end,
    reviewed_at = case when p_to in ('approved', 'rejected') then now() else reviewed_at end,
    withdrawn_at = case when p_to = 'withdrawn' then now() when p_to = 'draft' then null else withdrawn_at end,
    withdrawn_reason = case when p_to = 'withdrawn' then p_reason when p_to = 'draft' then null else withdrawn_reason end
  where id = p_id
  returning * into v_row;

  perform private.write_audit(v_row.organization_id, 'proof.status_changed', 'proof_asset', v_row.id,
    jsonb_build_object('publication_status', v_before.publication_status),
    jsonb_build_object('publication_status', v_row.publication_status),
    p_reason, p_correlation_id);
  perform private.write_workflow_event(v_row.organization_id, 'proof_asset', v_row.id, 'proof.status_changed',
    jsonb_build_object('from', v_before.publication_status, 'to', v_row.publication_status), p_correlation_id);
  return v_row;
end;
$$;

-- ===========================================================================
-- RPCs: proposals (staff)
-- ===========================================================================

create function public.create_proposal(
  p_prospect_id uuid,
  p_title text,
  p_currency text default 'INR',
  p_correlation_id text default null
)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_prospect public.prospects;
  v_proposal public.proposals;
  v_version public.proposal_versions;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found or not (
    private.has_permission(v_prospect.organization_id, 'proposals.manage')
    or (
      private.has_permission(v_prospect.organization_id, 'proposals.manage_own')
      and v_prospect.owner_user_id = v_uid
    )
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if v_prospect.status in ('disqualified', 'archived') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'cannot create a proposal for a disqualified or archived prospect';
  end if;

  insert into public.proposals (organization_id, prospect_id, owner_user_id, title, created_by)
  values (v_prospect.organization_id, v_prospect.id, v_uid, btrim(p_title), v_uid)
  returning * into v_proposal;

  insert into public.proposal_versions (organization_id, proposal_id, version_number, currency, created_by)
  values (v_proposal.organization_id, v_proposal.id, 1, upper(p_currency), v_uid)
  returning * into v_version;

  update public.proposals set current_version_id = v_version.id where id = v_proposal.id
  returning * into v_proposal;

  perform private.write_audit(v_proposal.organization_id, 'proposal.created', 'proposal', v_proposal.id, null,
    jsonb_build_object('title', v_proposal.title, 'prospect_id', v_proposal.prospect_id), null, p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_version.id, 'proposal.created', '{}'::jsonb, p_correlation_id);
  return v_proposal;
end;
$$;

create function public.save_proposal_draft(
  p_version_id uuid,
  p_title text,
  p_currency text,
  p_valid_until date,
  p_content jsonb,
  p_payment_schedule jsonb,
  p_line_items jsonb,
  p_proof_ids uuid[] default '{}',
  p_non_standard_terms boolean default false,
  p_margin_exception boolean default false,
  p_correlation_id text default null
)
returns public.proposal_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_version public.proposal_versions;
  v_proposal public.proposals;
  v_item jsonb;
  v_position integer := 0;
  v_quantity numeric;
  v_unit_amount bigint;
  v_discount bigint;
  v_tax_bps integer;
  v_gross bigint;
  v_net bigint;
  v_tax bigint;
  v_subtotal bigint := 0;
  v_discount_total bigint := 0;
  v_tax_total bigint := 0;
  v_content jsonb;
  v_reasons text[] := '{}';
  v_proof_id uuid;
  v_proof public.proof_assets;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_version from public.proposal_versions where id = p_version_id for update;
  if not found or not private.can_manage_proposal(v_version.proposal_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_version.status <> 'draft' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'only draft versions can be edited; create a new version';
  end if;
  select * into v_proposal from public.proposals where id = v_version.proposal_id for update;

  if p_title is null or length(btrim(p_title)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'title is required';
  end if;
  if p_currency is null or upper(p_currency) not in ('INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unsupported currency';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'content must be an object';
  end if;
  if p_payment_schedule is null or jsonb_typeof(p_payment_schedule) <> 'array'
     or jsonb_array_length(p_payment_schedule) > 12 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'payment schedule must be an array (max 12)';
  end if;
  if p_line_items is null or jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) > 100 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'line items must be an array (max 100)';
  end if;

  -- Keep only known, correctly typed sections.
  v_content := jsonb_build_object(
    'summary', coalesce(p_content ->> 'summary', ''),
    'scope', coalesce(p_content ->> 'scope', ''),
    'deliverables', case when jsonb_typeof(p_content -> 'deliverables') = 'array' then p_content -> 'deliverables' else '[]'::jsonb end,
    'timeline', coalesce(p_content ->> 'timeline', ''),
    'dependencies', case when jsonb_typeof(p_content -> 'dependencies') = 'array' then p_content -> 'dependencies' else '[]'::jsonb end,
    'assumptions', case when jsonb_typeof(p_content -> 'assumptions') = 'array' then p_content -> 'assumptions' else '[]'::jsonb end,
    'exclusions', case when jsonb_typeof(p_content -> 'exclusions') = 'array' then p_content -> 'exclusions' else '[]'::jsonb end,
    'terms', coalesce(p_content ->> 'terms', '')
  );
  if length(v_content::text) > 60000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'content is too long';
  end if;

  delete from public.proposal_line_items where version_id = v_version.id;
  delete from public.proposal_proof where version_id = v_version.id;

  for v_item in select * from jsonb_array_elements(p_line_items) loop
    begin
      v_quantity := (v_item ->> 'quantity')::numeric;
      v_unit_amount := (v_item ->> 'unit_amount_minor')::bigint;
      v_discount := coalesce((v_item ->> 'discount_minor')::bigint, 0);
      v_tax_bps := coalesce((v_item ->> 'tax_rate_bps')::integer, 0);
    exception when others then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('line item %s has invalid numbers', v_position + 1);
    end;

    if v_quantity is null or v_quantity <= 0 or v_quantity > 1000000 or v_quantity <> round(v_quantity, 2)
       or v_unit_amount is null or v_unit_amount < 0 or v_discount < 0
       or v_tax_bps < 0 or v_tax_bps > 10000 then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('line item %s is out of range', v_position + 1);
    end if;

    -- Server-side derivation; client-supplied totals are ignored (AT-005).
    v_gross := round(v_quantity * v_unit_amount);
    if v_discount > v_gross then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('line item %s discount exceeds its amount', v_position + 1);
    end if;
    v_net := v_gross - v_discount;
    v_tax := round(v_net * v_tax_bps / 10000.0);

    insert into public.proposal_line_items (
      organization_id, proposal_id, version_id, position, title, description, quantity, unit,
      unit_amount_minor, discount_minor, tax_rate_bps, billing_timing,
      gross_minor, net_minor, tax_minor, total_minor
    )
    values (
      v_version.organization_id, v_version.proposal_id, v_version.id, v_position,
      btrim(coalesce(v_item ->> 'title', '')), nullif(btrim(v_item ->> 'description'), ''),
      v_quantity, nullif(btrim(v_item ->> 'unit'), ''), v_unit_amount, v_discount, v_tax_bps,
      coalesce(v_item ->> 'billing_timing', 'upfront'),
      v_gross, v_net, v_tax, v_net + v_tax
    );

    v_subtotal := v_subtotal + v_gross;
    v_discount_total := v_discount_total + v_discount;
    v_tax_total := v_tax_total + v_tax;
    v_position := v_position + 1;
  end loop;

  v_position := 0;
  foreach v_proof_id in array coalesce(p_proof_ids, '{}') loop
    select * into v_proof from public.proof_assets
    where id = v_proof_id and organization_id = v_version.organization_id;
    if not found or not private.proof_is_visible(v_proof) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'only approved or published proof can be attached';
    end if;
    insert into public.proposal_proof (version_id, proof_asset_id, organization_id, proposal_id, position)
    values (v_version.id, v_proof_id, v_version.organization_id, v_version.proposal_id, v_position)
    on conflict do nothing;
    v_position := v_position + 1;
  end loop;

  -- PRD §5.2: discounts, non-standard clauses and margin exceptions need approval.
  if v_discount_total > 0 then v_reasons := array_append(v_reasons, 'discount'); end if;
  if p_non_standard_terms then v_reasons := array_append(v_reasons, 'non_standard_terms'); end if;
  if p_margin_exception then v_reasons := array_append(v_reasons, 'margin_exception'); end if;

  update public.proposal_versions set
    currency = upper(p_currency),
    valid_until = p_valid_until,
    content = v_content,
    payment_schedule = p_payment_schedule,
    subtotal_minor = v_subtotal,
    discount_minor = v_discount_total,
    tax_minor = v_tax_total,
    total_minor = v_subtotal - v_discount_total + v_tax_total,
    non_standard_terms = coalesce(p_non_standard_terms, false),
    margin_exception = coalesce(p_margin_exception, false),
    requires_approval = cardinality(v_reasons) > 0,
    approval_reasons = v_reasons
  where id = v_version.id
  returning * into v_version;

  if v_proposal.title is distinct from btrim(p_title) then
    update public.proposals set title = btrim(p_title) where id = v_proposal.id;
  end if;

  perform private.write_audit(v_version.organization_id, 'proposal.draft_saved', 'proposal_version', v_version.id,
    null,
    jsonb_build_object(
      'version_number', v_version.version_number, 'currency', v_version.currency,
      'total_minor', v_version.total_minor, 'discount_minor', v_version.discount_minor,
      'requires_approval', v_version.requires_approval
    ),
    null, p_correlation_id);
  return v_version;
end;
$$;

create function private.validate_payment_schedule(p_schedule jsonb, p_total bigint)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_basis text;
  v_first_basis text;
  v_sum numeric := 0;
begin
  if jsonb_array_length(p_schedule) = 0 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'payment schedule is required';
  end if;

  for v_item in select * from jsonb_array_elements(p_schedule) loop
    v_basis := v_item ->> 'basis';
    v_first_basis := coalesce(v_first_basis, v_basis);
    if coalesce(length(btrim(v_item ->> 'label')), 0) not between 1 and 120
       or v_basis not in ('percent', 'fixed')
       or v_basis <> v_first_basis
       or coalesce(v_item ->> 'due', '') not in ('on_acceptance', 'on_signing', 'on_date', 'on_milestone')
       or (v_item ->> 'due' = 'on_date' and (v_item ->> 'due_date') is null)
       or (v_item ->> 'due' = 'on_milestone' and coalesce(length(btrim(v_item ->> 'milestone')), 0) = 0) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'each instalment needs a label, one shared basis and a due rule';
    end if;
    begin
      v_sum := v_sum + case when v_basis = 'percent'
        then (v_item ->> 'percent_bps')::integer
        else (v_item ->> 'amount_minor')::bigint end;
    exception when others then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'invalid instalment amount';
    end;
  end loop;

  if (v_first_basis = 'percent' and v_sum <> 10000) or (v_first_basis = 'fixed' and v_sum <> p_total) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'payment schedule must add up to the proposal total';
  end if;
end;
$$;

create function public.submit_proposal_version(
  p_version_id uuid,
  p_correlation_id text default null
)
returns public.proposal_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_version public.proposal_versions;
  v_proposal public.proposals;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_version from public.proposal_versions where id = p_version_id for update;
  if not found or not private.can_manage_proposal(v_version.proposal_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_version.status <> 'draft' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'version is not a draft';
  end if;
  select * into v_proposal from public.proposals where id = v_version.proposal_id for update;
  if v_proposal.status in ('accepted', 'declined', 'withdrawn') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_proposal.status);
  end if;

  if not exists (select 1 from public.proposal_line_items where version_id = v_version.id) or v_version.total_minor <= 0 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'add at least one priced line item';
  end if;
  if coalesce(length(btrim(v_version.content ->> 'summary')), 0) = 0
     or coalesce(length(btrim(v_version.content ->> 'scope')), 0) = 0 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'summary and scope are required';
  end if;
  if v_version.valid_until is null or v_version.valid_until < private.today_ist()
     or v_version.valid_until > private.today_ist() + 365 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'valid-until must be between today and one year ahead';
  end if;
  perform private.validate_payment_schedule(v_version.payment_schedule, v_version.total_minor);

  update public.proposal_versions set
    status = case when requires_approval then 'pending_approval'::public.proposal_version_status
                  else 'approved'::public.proposal_version_status end,
    submitted_at = now(),
    approved_at = case when requires_approval then null else now() end,
    content_hash = encode(sha256(convert_to(private.version_terms_json(id)::text, 'UTF8')), 'hex')
  where id = v_version.id
  returning * into v_version;

  if v_proposal.sent_version_id is null then
    update public.proposals set status = case when v_version.requires_approval
      then 'internal_review'::public.proposal_status else 'approved'::public.proposal_status end
    where id = v_proposal.id
    returning * into v_proposal;
  end if;

  perform private.record_proposal_event(v_proposal, v_version.id,
    case when v_version.requires_approval then 'proposal.approval_requested' else 'proposal.version_ready' end,
    jsonb_build_object('version_number', v_version.version_number, 'approval_reasons', v_version.approval_reasons,
                       'total_minor', v_version.total_minor, 'currency', v_version.currency),
    p_correlation_id);
  return v_version;
end;
$$;

create function public.review_proposal_version(
  p_version_id uuid,
  p_decision text,
  p_note text default null,
  p_correlation_id text default null
)
returns public.proposal_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_version public.proposal_versions;
  v_proposal public.proposals;
begin
  perform private.require_correlation_id(p_correlation_id);
  if p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'decision must be approve or reject';
  end if;
  if p_decision = 'reject' then
    perform private.require_reason(p_note);
  end if;

  select * into v_version from public.proposal_versions where id = p_version_id for update;
  if not found or not private.has_permission(v_version.organization_id, 'proposals.approve') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_version.status <> 'pending_approval' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'version is not awaiting approval';
  end if;
  select * into v_proposal from public.proposals where id = v_version.proposal_id for update;

  update public.proposal_versions set
    status = case when p_decision = 'approve' then 'approved'::public.proposal_version_status
                  else 'draft'::public.proposal_version_status end,
    approved_by = case when p_decision = 'approve' then v_uid else null end,
    approved_at = case when p_decision = 'approve' then now() else null end,
    approval_note = p_note,
    content_hash = case when p_decision = 'approve' then content_hash else null end,
    submitted_at = case when p_decision = 'approve' then submitted_at else null end
  where id = v_version.id
  returning * into v_version;

  if v_proposal.sent_version_id is null then
    update public.proposals set status = case when p_decision = 'approve'
      then 'approved'::public.proposal_status else 'draft'::public.proposal_status end
    where id = v_proposal.id
    returning * into v_proposal;
  end if;

  perform private.write_audit(v_version.organization_id,
    case when p_decision = 'approve' then 'proposal.version_approved' else 'proposal.version_rejected' end,
    'proposal_version', v_version.id,
    jsonb_build_object('status', 'pending_approval'), jsonb_build_object('status', v_version.status),
    p_note, p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_version.id,
    case when p_decision = 'approve' then 'proposal.version_approved' else 'proposal.version_rejected' end,
    jsonb_build_object('version_number', v_version.version_number, 'note', p_note), p_correlation_id);
  return v_version;
end;
$$;

create function public.send_proposal_version(
  p_version_id uuid,
  p_correlation_id text default null
)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_version public.proposal_versions;
  v_proposal public.proposals;
  v_previous uuid;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_version from public.proposal_versions where id = p_version_id for update;
  if not found or not private.can_manage_proposal(v_version.proposal_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  -- AT-008: a version that needs approval can only be sent once approved by an approver.
  if v_version.status = 'pending_approval' or (v_version.requires_approval and v_version.approved_by is null) then
    raise exception using errcode = '42501', message = 'APPROVAL_REQUIRED';
  end if;
  if v_version.status <> 'approved' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'version is not ready to send';
  end if;
  if v_version.valid_until < private.today_ist() then
    raise exception using errcode = '55000', message = 'PROPOSAL_EXPIRED';
  end if;

  select * into v_proposal from public.proposals where id = v_version.proposal_id for update;
  if v_proposal.status in ('accepted', 'declined', 'withdrawn') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_proposal.status);
  end if;

  v_previous := v_proposal.sent_version_id;
  if v_previous is not null then
    update public.proposal_versions set status = 'superseded', superseded_at = now() where id = v_previous;
  end if;

  update public.proposal_versions set status = 'sent', sent_at = now() where id = v_version.id;

  update public.proposals set
    status = 'sent',
    sent_version_id = v_version.id,
    current_version_id = v_version.id,
    sent_at = now()
  where id = v_proposal.id
  returning * into v_proposal;

  perform private.write_audit(v_proposal.organization_id, 'proposal.version_sent', 'proposal', v_proposal.id,
    jsonb_build_object('sent_version_id', v_previous),
    jsonb_build_object('sent_version_id', v_version.id, 'version_number', v_version.version_number,
                       'total_minor', v_version.total_minor, 'currency', v_version.currency),
    null, p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_version.id, 'proposal.version_sent',
    jsonb_build_object('version_number', v_version.version_number, 'superseded_version_id', v_previous),
    p_correlation_id);
  return v_proposal;
end;
$$;

create function public.create_proposal_revision(
  p_proposal_id uuid,
  p_change_summary text,
  p_correlation_id text default null
)
returns public.proposal_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_proposal public.proposals;
  v_source public.proposal_versions;
  v_new public.proposal_versions;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_change_summary);

  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found or not private.can_manage_proposal(p_proposal_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_proposal.status in ('accepted', 'declined', 'withdrawn') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_proposal.status);
  end if;
  if exists (
    select 1 from public.proposal_versions
    where proposal_id = p_proposal_id and status in ('draft', 'pending_approval')
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'finish or discard the open draft first';
  end if;

  select * into v_source from public.proposal_versions
  where proposal_id = p_proposal_id
  order by version_number desc
  limit 1;

  -- An approved-but-unsent version is replaced by the new draft.
  if v_source.status = 'approved' then
    update public.proposal_versions set status = 'superseded', superseded_at = now() where id = v_source.id;
  end if;

  insert into public.proposal_versions (
    organization_id, proposal_id, version_number, currency, content, payment_schedule, valid_until,
    subtotal_minor, discount_minor, tax_minor, total_minor, non_standard_terms, margin_exception,
    requires_approval, approval_reasons, change_summary, created_by
  )
  values (
    v_source.organization_id, v_source.proposal_id, v_source.version_number + 1, v_source.currency,
    v_source.content, v_source.payment_schedule, v_source.valid_until, v_source.subtotal_minor,
    v_source.discount_minor, v_source.tax_minor, v_source.total_minor, v_source.non_standard_terms,
    v_source.margin_exception, v_source.requires_approval, v_source.approval_reasons,
    btrim(p_change_summary), v_uid
  )
  returning * into v_new;

  insert into public.proposal_line_items (
    organization_id, proposal_id, version_id, position, title, description, quantity, unit,
    unit_amount_minor, discount_minor, tax_rate_bps, billing_timing, gross_minor, net_minor, tax_minor, total_minor
  )
  select organization_id, proposal_id, v_new.id, position, title, description, quantity, unit,
    unit_amount_minor, discount_minor, tax_rate_bps, billing_timing, gross_minor, net_minor, tax_minor, total_minor
  from public.proposal_line_items
  where version_id = v_source.id;

  -- Carry forward only proof that is still visible.
  insert into public.proposal_proof (version_id, proof_asset_id, organization_id, proposal_id, position)
  select v_new.id, pp.proof_asset_id, pp.organization_id, pp.proposal_id, pp.position
  from public.proposal_proof pp
  join public.proof_assets a on a.id = pp.proof_asset_id
  where pp.version_id = v_source.id and private.proof_is_visible(a);

  update public.proposals set current_version_id = v_new.id where id = v_proposal.id
  returning * into v_proposal;

  perform private.record_proposal_event(v_proposal, v_new.id, 'proposal.revision_started',
    jsonb_build_object('version_number', v_new.version_number, 'from_version', v_source.version_number,
                       'change_summary', v_new.change_summary),
    p_correlation_id);
  return v_new;
end;
$$;

create function public.withdraw_proposal(
  p_proposal_id uuid,
  p_reason text,
  p_correlation_id text default null
)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.proposals;
  v_after public.proposals;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);

  select * into v_before from public.proposals where id = p_proposal_id for update;
  if not found or not private.can_manage_proposal(p_proposal_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.status in ('accepted', 'declined', 'withdrawn') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_before.status);
  end if;

  update public.proposals set status = 'withdrawn', withdrawn_at = now()
  where id = p_proposal_id
  returning * into v_after;

  perform private.write_audit(v_after.organization_id, 'proposal.withdrawn', 'proposal', v_after.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status),
    p_reason, p_correlation_id);
  perform private.record_proposal_event(v_after, v_after.sent_version_id, 'proposal.withdrawn',
    jsonb_build_object('reason', p_reason), p_correlation_id);
  return v_after;
end;
$$;

-- ===========================================================================
-- RPCs: invitations (staff)
-- ===========================================================================

create function private.assert_can_invite(p_prospect_id uuid, p_proposal_id uuid)
returns public.prospects
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects;
begin
  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found or not private.can_manage_prospect(p_prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_prospect.normalized_email is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'the prospect needs an email address before they can be invited';
  end if;
  if p_proposal_id is not null and not exists (
    select 1 from public.proposals where id = p_proposal_id and prospect_id = p_prospect_id
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'proposal does not belong to this prospect';
  end if;
  return v_prospect;
end;
$$;

create function public.create_invitation(
  p_prospect_id uuid,
  p_proposal_id uuid,
  p_token_hash text,
  p_expires_in_days integer default 14,
  p_correlation_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_prospect public.prospects;
  v_id uuid;
begin
  perform private.require_correlation_id(p_correlation_id);
  v_prospect := private.assert_can_invite(p_prospect_id, p_proposal_id);
  if p_expires_in_days is null or p_expires_in_days not between 1 and 30 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'expiry must be 1 to 30 days';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'token hash is malformed';
  end if;

  insert into public.invitations (organization_id, prospect_id, proposal_id, token_hash, expires_at, created_by)
  values (v_prospect.organization_id, v_prospect.id, p_proposal_id, p_token_hash,
          now() + make_interval(days => p_expires_in_days), v_uid)
  returning id into v_id;

  perform private.write_audit(v_prospect.organization_id, 'invitation.created', 'invitation', v_id, null,
    jsonb_build_object('prospect_id', p_prospect_id, 'proposal_id', p_proposal_id, 'expires_in_days', p_expires_in_days),
    null, p_correlation_id);
  return v_id;
end;
$$;

create function public.manage_invitation(
  p_invitation_id uuid,
  p_action text,
  p_reason text default null,
  p_extend_days integer default null,
  p_correlation_id text default null
)
returns public.invitations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.invitations;
  v_after public.invitations;
  v_state text;
begin
  perform private.require_correlation_id(p_correlation_id);
  if p_action not in ('mark_sent', 'revoke', 'extend') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown action';
  end if;

  select * into v_before from public.invitations where id = p_invitation_id for update;
  if not found or not private.can_manage_prospect(v_before.prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  v_state := private.invitation_state(v_before);

  if p_action = 'mark_sent' then
    if v_state <> 'created' then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'invitation already sent';
    end if;
    update public.invitations set sent_at = now() where id = p_invitation_id returning * into v_after;
    insert into public.outreach_events (
      organization_id, prospect_id, channel, direction, event_type, summary, actor_id, correlation_id
    )
    values (v_after.organization_id, v_after.prospect_id, 'email', 'outbound', 'invitation.sent',
            'Secure invitation link sent', v_uid, p_correlation_id);
  elsif p_action = 'revoke' then
    perform private.require_reason(p_reason);
    if v_state = 'revoked' then
      return v_before;
    end if;
    update public.invitations set revoked_at = now(), revoked_reason = p_reason
    where id = p_invitation_id returning * into v_after;
  else
    perform private.require_reason(p_reason);
    if v_state in ('revoked', 'redeemed') then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
        detail = 'revoked or redeemed invitations cannot be extended';
    end if;
    if p_extend_days is null or p_extend_days not between 1 and 30 then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'extension must be 1 to 30 days';
    end if;
    update public.invitations
    set expires_at = greatest(expires_at, now()) + make_interval(days => p_extend_days)
    where id = p_invitation_id returning * into v_after;
  end if;

  perform private.write_audit(v_after.organization_id, 'invitation.' || p_action, 'invitation', v_after.id,
    jsonb_build_object('state', v_state, 'expires_at', v_before.expires_at),
    jsonb_build_object('state', private.invitation_state(v_after), 'expires_at', v_after.expires_at),
    p_reason, p_correlation_id);
  return v_after;
end;
$$;

create function public.replace_invitation(
  p_invitation_id uuid,
  p_new_token_hash text,
  p_expires_in_days integer default 14,
  p_reason text default null,
  p_correlation_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_old public.invitations;
  v_new_id uuid;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);

  select * into v_old from public.invitations where id = p_invitation_id for update;
  if not found or not private.can_manage_prospect(v_old.prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  v_new_id := public.create_invitation(v_old.prospect_id, v_old.proposal_id, p_new_token_hash,
                                       p_expires_in_days, p_correlation_id);
  update public.invitations set
    revoked_at = coalesce(revoked_at, now()),
    revoked_reason = coalesce(revoked_reason, p_reason),
    replaced_by = v_new_id
  where id = v_old.id;

  perform private.write_audit(v_old.organization_id, 'invitation.replaced', 'invitation', v_old.id,
    null, jsonb_build_object('replaced_by', v_new_id), p_reason, p_correlation_id);
  return v_new_id;
end;
$$;

-- ===========================================================================
-- RPCs: invitation holders and clients
-- ===========================================================================

-- AT-001/002/003: the token unlocks only its own prospect and proposal, and
-- returns nothing once expired, revoked or redeemed.
create function public.invitation_view(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.invitations;
  v_state text;
  v_prospect public.prospects;
  v_org_name text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('state', 'invalid');
  end if;

  select * into v_invitation from public.invitations where token_hash = p_token_hash for update;
  if not found then
    return jsonb_build_object('state', 'invalid');
  end if;

  v_state := private.invitation_state(v_invitation);
  if v_state in ('revoked', 'expired') then
    return jsonb_build_object('state', v_state);
  end if;
  if v_state = 'redeemed' then
    -- The link has been bound to an account; continue by signing in.
    return jsonb_build_object('state', 'redeemed');
  end if;

  if v_invitation.opened_at is null then
    update public.invitations set opened_at = now() where id = v_invitation.id;
  end if;

  select * into v_prospect from public.prospects where id = v_invitation.prospect_id;
  select name into v_org_name from public.organizations where id = v_invitation.organization_id;

  return jsonb_build_object(
    'state', 'valid',
    'organization_name', v_org_name,
    'prospect_name', v_prospect.name,
    'masked_email', private.mask_email(v_prospect.normalized_email),
    'expires_at', v_invitation.expires_at,
    'proposal', case when v_invitation.proposal_id is not null
      then private.client_proposal_json(v_invitation.proposal_id, true) end
  );
end;
$$;

-- Server-only: the email the invitation is bound to, for starting sign-in.
create function public.invitation_contact(p_token_hash text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.normalized_email
  from public.invitations i
  join public.prospects p on p.id = i.prospect_id
  where i.token_hash = p_token_hash
    and private.invitation_state(i) in ('created', 'sent', 'opened', 'redeemed');
$$;

create function public.request_invitation_help(
  p_token_hash text,
  p_kind text,
  p_message text default null,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invitation public.invitations;
  v_proposal public.proposals;
  v_correlation text := coalesce(p_correlation_id, gen_random_uuid()::text);
begin
  if p_kind not in ('new_link', 'question', 'changes', 'call') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown request type';
  end if;
  if p_message is not null and length(p_message) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'message is too long';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;

  select * into v_invitation from public.invitations where token_hash = p_token_hash;
  -- Unknown tokens get the same response as known ones.
  if not found then
    return;
  end if;

  insert into public.outreach_events (
    organization_id, prospect_id, channel, direction, event_type, summary, correlation_id
  )
  values (
    v_invitation.organization_id, v_invitation.prospect_id, 'portal', 'inbound',
    'client.' || p_kind || '_requested', nullif(btrim(p_message), ''), v_correlation
  );
  update public.prospects set next_action_at = now() where id = v_invitation.prospect_id;

  if p_kind = 'changes' and v_invitation.proposal_id is not null
     and private.invitation_state(v_invitation) in ('created', 'sent', 'opened') then
    select * into v_proposal from public.proposals where id = v_invitation.proposal_id for update;
    if v_proposal.status in ('sent', 'viewed') then
      update public.proposals set status = 'negotiation' where id = v_proposal.id returning * into v_proposal;
    end if;
    perform private.record_proposal_event(v_proposal, v_proposal.sent_version_id, 'proposal.changes_requested',
      jsonb_build_object('message', p_message), v_correlation);
  end if;
end;
$$;

-- Binds an invitation to the signed-in account whose verified email matches
-- the prospect (PRD §11: bind redemption to the intended contact).
create function public.redeem_invitation(
  p_token_hash text,
  p_correlation_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_invitation public.invitations;
  v_prospect public.prospects;
  v_state text;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_invitation from public.invitations where token_hash = p_token_hash for update;
  if not found then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  v_state := private.invitation_state(v_invitation);
  if v_state = 'revoked' then
    raise exception using errcode = '55000', message = 'INVITATION_REVOKED';
  end if;
  if v_state = 'redeemed' then
    if v_invitation.redeemed_by = v_uid then
      return v_invitation.proposal_id;
    end if;
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_state = 'expired' then
    raise exception using errcode = '55000', message = 'INVITATION_EXPIRED';
  end if;

  select * into v_prospect from public.prospects where id = v_invitation.prospect_id;
  if v_prospect.normalized_email is null or private.current_user_email() is distinct from v_prospect.normalized_email then
    raise exception using errcode = '42501', message = 'FORBIDDEN',
      detail = 'signed-in email does not match the invitation';
  end if;

  update public.invitations set redeemed_at = now(), redeemed_by = v_uid where id = v_invitation.id;

  insert into public.client_access (organization_id, prospect_id, user_id, invitation_id)
  values (v_invitation.organization_id, v_invitation.prospect_id, v_uid, v_invitation.id)
  on conflict (prospect_id, user_id) do update
    set status = 'active', revoked_at = null, invitation_id = excluded.invitation_id;

  perform private.write_audit(v_invitation.organization_id, 'invitation.redeemed', 'invitation', v_invitation.id,
    null, jsonb_build_object('user_id', v_uid), null, p_correlation_id);
  return v_invitation.proposal_id;
end;
$$;

create function public.client_proposals()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'title', p.title,
    'status', p.status,
    'sent_at', p.sent_at,
    'total_minor', v.total_minor,
    'currency', v.currency,
    'valid_until', v.valid_until
  ) order by p.sent_at desc), '[]'::jsonb)
  from public.proposals p
  join public.proposal_versions v on v.id = p.sent_version_id
  where p.status <> 'withdrawn'
    and private.client_has_access(p.prospect_id);
$$;

create function public.client_proposal_view(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect_id uuid;
begin
  perform private.require_user();
  select prospect_id into v_prospect_id from public.proposals where id = p_proposal_id;
  -- Same answer for "missing" and "not yours" so IDs cannot be probed (AT-024).
  if v_prospect_id is null or not private.client_has_access(v_prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return private.client_proposal_json(p_proposal_id, true);
end;
$$;

-- AT-007: acceptance binds to the exact displayed version and its terms hash.
create function public.accept_proposal(
  p_proposal_id uuid,
  p_version_id uuid,
  p_content_hash text,
  p_correlation_id text default null
)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_proposal public.proposals;
  v_version public.proposal_versions;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found or not private.client_has_access(v_proposal.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_proposal.status not in ('sent', 'viewed', 'negotiation') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_proposal.status);
  end if;
  if v_proposal.sent_version_id is distinct from p_version_id then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;

  select * into v_version from public.proposal_versions where id = p_version_id for update;
  if v_version.content_hash is distinct from p_content_hash then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;
  if v_version.valid_until < private.today_ist() then
    raise exception using errcode = '55000', message = 'PROPOSAL_EXPIRED';
  end if;

  update public.proposal_versions set status = 'accepted' where id = v_version.id;
  update public.proposals set
    status = 'accepted',
    accepted_version_id = v_version.id,
    accepted_at = now(),
    accepted_by = v_uid
  where id = v_proposal.id
  returning * into v_proposal;

  perform private.write_audit(v_proposal.organization_id, 'proposal.accepted', 'proposal', v_proposal.id,
    null,
    jsonb_build_object('version_id', v_version.id, 'version_number', v_version.version_number,
                       'content_hash', v_version.content_hash, 'total_minor', v_version.total_minor,
                       'currency', v_version.currency, 'accepted_by', v_uid),
    null, p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_version.id, 'proposal.accepted',
    jsonb_build_object('version_number', v_version.version_number, 'content_hash', v_version.content_hash,
                       'total_minor', v_version.total_minor, 'currency', v_version.currency),
    p_correlation_id);
  update public.prospects set next_action_at = now() where id = v_proposal.prospect_id;
  return v_proposal;
end;
$$;

create function public.client_respond_to_proposal(
  p_proposal_id uuid,
  p_response text,
  p_message text default null,
  p_correlation_id text default null
)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_proposal public.proposals;
begin
  perform private.require_correlation_id(p_correlation_id);
  if p_response not in ('decline', 'request_changes') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown response';
  end if;
  if p_message is not null and length(p_message) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'message is too long';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found or not private.client_has_access(v_proposal.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_proposal.status not in ('sent', 'viewed', 'negotiation') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('proposal is %s', v_proposal.status);
  end if;

  if p_response = 'decline' then
    update public.proposals set status = 'declined', declined_at = now(), decline_reason = nullif(btrim(p_message), '')
    where id = v_proposal.id returning * into v_proposal;
  else
    update public.proposals set status = 'negotiation' where id = v_proposal.id returning * into v_proposal;
  end if;

  insert into public.outreach_events (
    organization_id, prospect_id, channel, direction, event_type, summary, actor_id, correlation_id
  )
  values (v_proposal.organization_id, v_proposal.prospect_id, 'portal', 'inbound',
          'client.' || p_response, nullif(btrim(p_message), ''), v_uid, p_correlation_id);
  update public.prospects set next_action_at = now() where id = v_proposal.prospect_id;

  perform private.write_audit(v_proposal.organization_id, 'proposal.client_' || p_response, 'proposal',
    v_proposal.id, null, jsonb_build_object('status', v_proposal.status), p_message, p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_proposal.sent_version_id,
    case when p_response = 'decline' then 'proposal.declined' else 'proposal.changes_requested' end,
    jsonb_build_object('message', p_message), p_correlation_id);
  return v_proposal;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.create_prospect(uuid, uuid, text, text, text, text, text, text, text, text, timestamptz, text)',
    'public.update_prospect(uuid, jsonb, text)',
    'public.transition_prospect(uuid, public.prospect_status, text, text)',
    'public.log_outreach(uuid, text, text, text, timestamptz, timestamptz, text)',
    'public.save_proof_asset(uuid, uuid, public.proof_kind, jsonb, text)',
    'public.transition_proof_asset(uuid, public.proof_publication_status, text, text)',
    'public.create_proposal(uuid, text, text, text)',
    'public.save_proposal_draft(uuid, text, text, date, jsonb, jsonb, jsonb, uuid[], boolean, boolean, text)',
    'public.submit_proposal_version(uuid, text)',
    'public.review_proposal_version(uuid, text, text, text)',
    'public.send_proposal_version(uuid, text)',
    'public.create_proposal_revision(uuid, text, text)',
    'public.withdraw_proposal(uuid, text, text)',
    'public.create_invitation(uuid, uuid, text, integer, text)',
    'public.manage_invitation(uuid, text, text, integer, text)',
    'public.replace_invitation(uuid, text, integer, text, text)',
    'public.redeem_invitation(text, text)',
    'public.client_proposals()',
    'public.client_proposal_view(uuid)',
    'public.accept_proposal(uuid, uuid, text, text)',
    'public.client_respond_to_proposal(uuid, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;

-- Token holders are not signed in; the 256-bit token is the credential.
revoke all on function public.invitation_view(text) from public;
grant execute on function public.invitation_view(text) to anon, authenticated;
revoke all on function public.request_invitation_help(text, text, text, text) from public;
grant execute on function public.request_invitation_help(text, text, text, text) to anon, authenticated;

-- Resolving the bound email is a server-side step only.
revoke all on function public.invitation_contact(text) from public, anon, authenticated;
grant execute on function public.invitation_contact(text) to service_role;
