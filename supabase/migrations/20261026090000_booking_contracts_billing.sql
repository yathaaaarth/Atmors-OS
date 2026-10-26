-- Phase 3: shared booking, contracts and e-signature, invoices and payments,
-- verified provider events and the activation evaluator.
-- PRD §4 (state machines), §5.4–5.6, §8, §9, §10; acceptance tests AT-010–AT-020.
--
-- Conventions follow Phase 2 (see docs/architecture/authorization.md):
--   * Staff read through RLS; every write is a SECURITY DEFINER RPC that
--     re-checks permission and records audit + workflow events atomically.
--   * Clients never read tables directly; they get client-safe JSON from RPCs.
--   * Provider callbacks enter through service-role-only ingest RPCs. The
--     application verifies the signature; the database records the outcome,
--     deduplicates on the provider event ID and applies business effects.
--   * Business state is never changed by an unverified event or a browser redirect.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.meeting_purpose as enum ('commercial', 'onboarding', 'delivery');
create type public.meeting_status as enum (
  'requested', 'booked', 'rescheduled', 'cancelled', 'completed', 'no_show'
);
create type public.contract_status as enum (
  'draft', 'ready_to_send', 'sent', 'viewed', 'partially_signed',
  'executed', 'declined', 'voided', 'expired'
);
create type public.invoice_status as enum (
  'draft', 'issued', 'partially_paid', 'paid', 'overdue', 'voided', 'disputed'
);
create type public.payment_status as enum (
  'created', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded', 'disputed'
);
create type public.ops_task_status as enum ('open', 'done', 'cancelled');

-- ---------------------------------------------------------------------------
-- Permissions (policy v3)
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, permission_key, policy_version) values
  ('ceo', 'meetings.read_all', 3),
  ('ceo', 'meetings.manage', 3),
  ('ceo', 'contracts.read', 3),
  ('ceo', 'contracts.templates', 3),
  ('ceo', 'billing.manage', 3),
  ('ceo', 'integrations.monitor', 3),
  ('cto_coo', 'meetings.read_all', 3),
  ('cto_coo', 'meetings.manage', 3),
  ('cto_coo', 'scheduling.configure', 3),
  ('cto_coo', 'integrations.monitor', 3);

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- Workflow event with an explicit source ('app', 'system' or 'webhook').
create function private.write_event(
  p_organization_id uuid,
  p_aggregate_type text,
  p_aggregate_id uuid,
  p_event_type text,
  p_payload jsonb,
  p_source text,
  p_correlation_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.workflow_events (
    organization_id, aggregate_type, aggregate_id, event_type, payload_json, source, correlation_id
  )
  values (
    p_organization_id, p_aggregate_type, p_aggregate_id, p_event_type,
    coalesce(p_payload, '{}'::jsonb), p_source, coalesce(p_correlation_id, gen_random_uuid()::text)
  );
end;
$$;

create function private.format_minor(p_minor bigint, p_currency text)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_currency || ' ' || to_char(p_minor / 100.0, 'FM999,999,999,999,990.00');
$$;

-- Split a total across a proposal payment schedule. Mirrors scheduleAmounts in
-- src/modules/proposals/money.ts: fixed amounts as given; percentages round
-- half up and the last instalment absorbs the remainder.
create function private.schedule_amounts(p_schedule jsonb, p_total bigint)
returns bigint[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_count integer := jsonb_array_length(p_schedule);
  v_amounts bigint[] := '{}';
  v_allocated bigint := 0;
  v_amount bigint;
  v_index integer;
begin
  if not exists (select 1 from jsonb_array_elements(p_schedule) e where e ->> 'basis' <> 'fixed') then
    select array_agg((e ->> 'amount_minor')::bigint order by ord) into v_amounts
    from jsonb_array_elements(p_schedule) with ordinality as t(e, ord);
    return coalesce(v_amounts, '{}');
  end if;
  for v_index in 0 .. v_count - 1 loop
    if v_index = v_count - 1 then
      v_amount := p_total - v_allocated;
    else
      v_amount := round(p_total * ((p_schedule -> v_index ->> 'percent_bps')::numeric) / 10000.0);
      v_allocated := v_allocated + v_amount;
    end if;
    v_amounts := array_append(v_amounts, v_amount);
  end loop;
  return v_amounts;
end;
$$;

-- ---------------------------------------------------------------------------
-- Internal operations tasks (follow-ups, reviews, exceptions)
-- ---------------------------------------------------------------------------

create table public.ops_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind ~ '^[a-z_]{2,64}$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  detail text check (length(detail) <= 4000),
  -- Who may see it besides the owner: operations (operations.manage),
  -- commercial (prospects.read_all) or finance (finance.read).
  visibility text not null check (visibility in ('operations', 'commercial', 'finance')),
  owner_user_id uuid references public.profiles (id) on delete set null,
  prospect_id uuid references public.prospects (id) on delete restrict,
  related_type text check (length(related_type) <= 64),
  related_id uuid,
  due_at timestamptz not null default now(),
  status public.ops_task_status not null default 'open',
  -- Retries and replays never create a second task for the same cause.
  dedupe_key text check (length(dedupe_key) <= 200),
  resolution text check (length(resolution) <= 2000),
  completed_at timestamptz,
  completed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, dedupe_key)
);

create index ops_tasks_open_idx on public.ops_tasks (organization_id, due_at) where status = 'open';
create index ops_tasks_owner_idx on public.ops_tasks (owner_user_id) where status = 'open';

create trigger ops_tasks_set_updated_at before update on public.ops_tasks
  for each row execute function private.set_updated_at();

create function private.create_ops_task(
  p_organization_id uuid,
  p_kind text,
  p_title text,
  p_detail text,
  p_visibility text,
  p_owner_user_id uuid,
  p_prospect_id uuid,
  p_related_type text,
  p_related_id uuid,
  p_dedupe_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.ops_tasks (
    organization_id, kind, title, detail, visibility, owner_user_id, prospect_id,
    related_type, related_id, dedupe_key
  )
  values (
    p_organization_id, p_kind, left(p_title, 200), left(p_detail, 4000), p_visibility, p_owner_user_id,
    p_prospect_id, p_related_type, p_related_id, p_dedupe_key
  )
  on conflict (organization_id, dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

create function private.can_see_ops_task(p_task public.ops_tasks)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_active_member(p_task.organization_id) and (
    p_task.owner_user_id = (select auth.uid())
    or (p_task.visibility = 'operations' and private.has_permission(p_task.organization_id, 'operations.manage'))
    or (p_task.visibility = 'commercial' and private.has_permission(p_task.organization_id, 'prospects.read_all'))
    or (p_task.visibility = 'finance' and private.has_permission(p_task.organization_id, 'finance.read'))
  );
$$;

-- ---------------------------------------------------------------------------
-- Integration accounts: which providers an organization has enabled
-- ---------------------------------------------------------------------------
-- Provider events are processed only for an enabled (organization, provider)
-- pair, and payment events must come from the expected merchant account
-- (AT-016). A sandbox provider therefore does nothing unless explicitly enabled.

create table public.integration_accounts (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null check (kind in ('payments', 'esign')),
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  account_id text not null check (length(account_id) between 1 and 200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, kind, provider)
);

create trigger integration_accounts_set_updated_at before update on public.integration_accounts
  for each row execute function private.set_updated_at();

create function private.integration_enabled(p_organization_id uuid, p_kind text, p_provider text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.integration_accounts a
    where a.organization_id = p_organization_id and a.kind = p_kind and a.provider = p_provider and a.active
  );
$$;

-- ===========================================================================
-- Shared booking
-- ===========================================================================

create table public.booking_hosts (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null,
  purposes public.meeting_purpose[] not null default '{commercial}' check (cardinality(purposes) between 1 and 3),
  timezone text not null default 'Asia/Kolkata' check (length(timezone) between 1 and 64),
  -- [{day: 1-7 (ISO, Monday = 1), start: "HH:MM", end: "HH:MM"}] in the host's timezone
  weekly_hours jsonb not null default '[]'::jsonb check (jsonb_typeof(weekly_hours) = 'array'),
  slot_minutes integer not null default 30 check (slot_minutes in (15, 30, 45, 60)),
  min_notice_hours integer not null default 12 check (min_notice_hours between 0 and 168),
  horizon_days integer not null default 21 check (horizon_days between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

create trigger booking_hosts_set_updated_at before update on public.booking_hosts
  for each row execute function private.set_updated_at();

create table public.meetings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  proposal_id uuid references public.proposals (id) on delete restrict,
  purpose public.meeting_purpose not null,
  host_user_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- The attendee's IANA timezone, kept for display; instants are UTC.
  timezone text not null check (length(timezone) between 1 and 64),
  status public.meeting_status not null default 'booked',
  provider text not null default 'internal' check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_booking_id text check (length(provider_booking_id) <= 200),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  booked_by_type public.actor_type not null,
  booked_by uuid,
  attendee_note text check (length(attendee_note) <= 2000),
  rescheduled_count integer not null default 0,
  cancelled_at timestamptz,
  cancel_reason text check (length(cancel_reason) <= 2000),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at > start_at and end_at - start_at <= interval '4 hours'),
  unique (organization_id, idempotency_key),
  unique (provider, provider_booking_id),
  foreign key (organization_id, host_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  -- AT-010: one host can never hold two active bookings that overlap, even
  -- when two requests race. Postgres enforces this, not application code.
  constraint meetings_no_host_overlap exclude using gist (
    host_user_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('booked', 'rescheduled'))
);

create index meetings_org_start_idx on public.meetings (organization_id, start_at);
create index meetings_prospect_idx on public.meetings (prospect_id, start_at desc);
create index meetings_host_idx on public.meetings (host_user_id, start_at);

create trigger meetings_set_updated_at before update on public.meetings
  for each row execute function private.set_updated_at();

create table public.meeting_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  meeting_id uuid not null references public.meetings (id) on delete restrict,
  event_type text not null check (event_type ~ '^[a-z_]+(\.[a-z_]+)+$'),
  actor_type public.actor_type not null,
  actor_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  occurred_at timestamptz not null default now()
);

create index meeting_events_meeting_idx on public.meeting_events (meeting_id, occurred_at);

create trigger meeting_events_append_only before update or delete on public.meeting_events
  for each row execute function private.reject_mutation();

create function private.validate_weekly_hours(p_hours jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_window jsonb;
begin
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 21 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'weekly hours must be an array (max 21)';
  end if;
  for v_window in select * from jsonb_array_elements(p_hours) loop
    if jsonb_typeof(v_window) <> 'object'
       or coalesce(v_window ->> 'day', '') !~ '^[1-7]$'
       or coalesce(v_window ->> 'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v_window ->> 'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or (v_window ->> 'end')::time <= (v_window ->> 'start')::time then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'each window needs day 1-7 and start < end as HH:MM';
    end if;
  end loop;
end;
$$;

create function private.validate_timezone(p_timezone text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_timezone is null or length(p_timezone) not between 1 and 64 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'timezone is required';
  end if;
  perform now() at time zone p_timezone;
exception
  when invalid_parameter_value then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown timezone';
end;
$$;

-- Open slots for one host in [p_from, p_to), honouring weekly hours in the
-- host's timezone, minimum notice, horizon and existing active bookings.
create function private.host_open_slots(
  p_host public.booking_hosts,
  p_from timestamptz,
  p_to timestamptz,
  p_ignore_meeting_id uuid default null
)
returns table (start_at timestamptz, end_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with bounds as (
    select greatest(p_from, now() + make_interval(hours => p_host.min_notice_hours)) as lo,
           least(p_to, now() + make_interval(days => p_host.horizon_days)) as hi
  ),
  days as (
    select d::date as day
    from bounds,
      generate_series((bounds.lo at time zone p_host.timezone)::date,
                      (bounds.hi at time zone p_host.timezone)::date,
                      interval '1 day') as d
  ),
  windows as (
    select days.day, (w ->> 'start')::time as w_start, (w ->> 'end')::time as w_end
    from days
    cross join jsonb_array_elements(p_host.weekly_hours) as w
    where (w ->> 'day')::integer = extract(isodow from days.day)::integer
  ),
  slots as (
    select (s at time zone p_host.timezone) as slot_start
    from windows,
      generate_series(windows.day + windows.w_start,
                      windows.day + windows.w_end - make_interval(mins => p_host.slot_minutes),
                      make_interval(mins => p_host.slot_minutes)) as s
  )
  select slots.slot_start, slots.slot_start + make_interval(mins => p_host.slot_minutes)
  from slots, bounds
  where p_host.active
    and slots.slot_start >= bounds.lo
    and slots.slot_start < bounds.hi
    and not exists (
      select 1 from public.meetings m
      where m.host_user_id = p_host.user_id
        and m.status in ('booked', 'rescheduled')
        and m.id is distinct from p_ignore_meeting_id
        and tstzrange(m.start_at, m.end_at, '[)')
            && tstzrange(slots.slot_start, slots.slot_start + make_interval(mins => p_host.slot_minutes), '[)')
    )
  order by 1;
$$;

-- Routing (PRD §5.4): commercial calls go to the prospect's owner when the
-- owner takes commercial bookings, otherwise to the commercial pool;
-- onboarding and delivery calls go to the pool configured for that purpose.
create function private.routing_hosts(p_prospect public.prospects, p_purpose public.meeting_purpose)
returns setof public.booking_hosts
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select h.*
    from public.booking_hosts h
    join public.organization_memberships m
      on m.organization_id = h.organization_id and m.user_id = h.user_id and m.status = 'active'
    where h.organization_id = p_prospect.organization_id
      and h.active
      and p_purpose = any (h.purposes)
  )
  select e.* from eligible e
  where p_purpose <> 'commercial'
     or e.user_id = p_prospect.owner_user_id
     or not exists (select 1 from eligible o where o.user_id = p_prospect.owner_user_id);
$$;

create function private.candidate_slots(
  p_prospect_id uuid,
  p_purpose public.meeting_purpose,
  p_from timestamptz,
  p_to timestamptz
)
returns table (host_user_id uuid, start_at timestamptz, end_at timestamptz, load integer)
language sql
stable
security definer
set search_path = ''
as $$
  select h.user_id, s.start_at, s.end_at,
    (select count(*)::integer from public.meetings m
     where m.host_user_id = h.user_id and m.status in ('booked', 'rescheduled')
       and m.start_at >= now() and m.start_at < now() + interval '14 days')
  from public.prospects p
  cross join lateral private.routing_hosts(p, p_purpose) h
  cross join lateral private.host_open_slots(h, p_from, p_to) s
  where p.id = p_prospect_id;
$$;

-- Distinct start times across the eligible pool (hosts are chosen at booking).
create function private.slots_json(
  p_prospect_id uuid,
  p_purpose public.meeting_purpose,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('start_at', s.start_at, 'end_at', s.end_at) order by s.start_at), '[]'::jsonb)
  from (
    select distinct on (c.start_at) c.start_at, c.end_at
    from private.candidate_slots(p_prospect_id, p_purpose, p_from, p_to) c
    order by c.start_at, c.end_at
    limit p_limit
  ) s;
$$;

create function private.client_meeting_json(p_meeting_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id,
    'purpose', m.purpose,
    'status', m.status,
    'start_at', m.start_at,
    'end_at', m.end_at,
    'timezone', m.timezone,
    'host_name', nullif(split_part(btrim(pr.display_name), ' ', 1), ''),
    'can_change', m.status in ('booked', 'rescheduled') and m.start_at > now()
  )
  from public.meetings m
  left join public.profiles pr on pr.id = m.host_user_id
  where m.id = p_meeting_id;
$$;

create function private.record_meeting_event(
  p_meeting public.meetings,
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
  insert into public.meeting_events (organization_id, meeting_id, event_type, actor_type, actor_id, metadata, correlation_id)
  values (
    p_meeting.organization_id, p_meeting.id, p_event_type,
    case
      when v_actor is null then 'system'::public.actor_type
      when private.is_active_member(p_meeting.organization_id) then 'user'::public.actor_type
      else 'client'::public.actor_type
    end,
    v_actor, coalesce(p_metadata, '{}'::jsonb), v_correlation
  );
  perform private.write_audit(p_meeting.organization_id, p_event_type, 'meeting', p_meeting.id, null,
    jsonb_build_object('status', p_meeting.status, 'start_at', p_meeting.start_at, 'host_user_id', p_meeting.host_user_id)
      || coalesce(p_metadata, '{}'::jsonb),
    p_metadata ->> 'reason', v_correlation);
  perform private.write_event(p_meeting.organization_id, 'meeting', p_meeting.id, p_event_type,
    jsonb_build_object('status', p_meeting.status, 'start_at', p_meeting.start_at, 'purpose', p_meeting.purpose),
    'app', v_correlation);
end;
$$;

-- Book the requested start time with the least-loaded eligible host. A host
-- whose slot was just taken by a concurrent request is skipped; if no host is
-- left the caller gets alternative slots instead of an error (AT-010).
create function private.book_meeting(
  p_prospect public.prospects,
  p_proposal_id uuid,
  p_purpose public.meeting_purpose,
  p_start timestamptz,
  p_timezone text,
  p_note text,
  p_idempotency_key text,
  p_booked_by_type public.actor_type,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing public.meetings;
  v_meeting public.meetings;
  v_candidate record;
begin
  if p_purpose is null or p_start is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'purpose and start time are required';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'idempotency key is required';
  end if;
  if p_note is not null and length(p_note) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'note is too long';
  end if;
  perform private.validate_timezone(p_timezone);
  if p_proposal_id is not null and not exists (
    select 1 from public.proposals where id = p_proposal_id and prospect_id = p_prospect.id
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'proposal does not belong to this prospect';
  end if;

  -- Retrying the same request returns the booking it already made.
  select * into v_existing from public.meetings
  where organization_id = p_prospect.organization_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.prospect_id <> p_prospect.id then
      raise exception using errcode = '42501', message = 'FORBIDDEN';
    end if;
    return jsonb_build_object('status', 'booked', 'replayed', true, 'meeting', private.client_meeting_json(v_existing.id));
  end if;

  for v_candidate in
    select c.host_user_id, c.start_at, c.end_at
    from private.candidate_slots(p_prospect.id, p_purpose, p_start, p_start + interval '1 second') c
    where c.start_at = p_start
    order by c.load, c.host_user_id
  loop
    begin
      insert into public.meetings (
        organization_id, prospect_id, proposal_id, purpose, host_user_id, start_at, end_at, timezone,
        status, provider, provider_booking_id, idempotency_key, booked_by_type, booked_by, attendee_note
      )
      values (
        p_prospect.organization_id, p_prospect.id, p_proposal_id, p_purpose, v_candidate.host_user_id,
        v_candidate.start_at, v_candidate.end_at, p_timezone, 'booked', 'internal',
        'int_' || replace(gen_random_uuid()::text, '-', ''), p_idempotency_key, p_booked_by_type,
        (select auth.uid()), nullif(btrim(p_note), '')
      )
      returning * into v_meeting;
      exit;
    exception
      when exclusion_violation then
        v_meeting := null;
      when unique_violation then
        -- A concurrent retry with the same key won; return its booking.
        select * into v_existing from public.meetings
        where organization_id = p_prospect.organization_id and idempotency_key = p_idempotency_key;
        if found and v_existing.prospect_id = p_prospect.id then
          return jsonb_build_object('status', 'booked', 'replayed', true, 'meeting', private.client_meeting_json(v_existing.id));
        end if;
        raise;
    end;
  end loop;

  if v_meeting.id is null then
    return jsonb_build_object(
      'status', 'slot_unavailable',
      'alternatives', private.slots_json(p_prospect.id, p_purpose, greatest(p_start - interval '1 day', now()),
                                         p_start + interval '7 days', 6)
    );
  end if;

  insert into public.outreach_events (
    organization_id, prospect_id, channel, direction, event_type, summary, actor_id, correlation_id
  )
  values (
    v_meeting.organization_id, v_meeting.prospect_id, 'meeting',
    case when p_booked_by_type = 'user' then 'outbound' else 'inbound' end,
    'meeting.booked', format('%s call booked', initcap(v_meeting.purpose::text)),
    (select auth.uid()), coalesce(p_correlation_id, gen_random_uuid()::text)
  );
  perform private.record_meeting_event(v_meeting, 'meeting.booked',
    jsonb_build_object('purpose', v_meeting.purpose, 'end_at', v_meeting.end_at), p_correlation_id);
  return jsonb_build_object('status', 'booked', 'replayed', false, 'meeting', private.client_meeting_json(v_meeting.id));
end;
$$;

create function private.reschedule_meeting(p_meeting_id uuid, p_start timestamptz, p_correlation_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings;
  v_host public.booking_hosts;
  v_slot record;
  v_previous timestamptz;
begin
  if p_start is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'new start time is required';
  end if;
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if v_meeting.status not in ('booked', 'rescheduled') or v_meeting.start_at <= now() then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'only upcoming bookings can be rescheduled';
  end if;
  select * into v_host from public.booking_hosts
  where organization_id = v_meeting.organization_id and user_id = v_meeting.host_user_id;

  select * into v_slot from private.host_open_slots(v_host, p_start, p_start + interval '1 second', v_meeting.id) s
  where s.start_at = p_start;
  if not found then
    return jsonb_build_object(
      'status', 'slot_unavailable',
      'alternatives', private.slots_json(v_meeting.prospect_id, v_meeting.purpose,
                                         greatest(p_start - interval '1 day', now()), p_start + interval '7 days', 6)
    );
  end if;

  v_previous := v_meeting.start_at;
  begin
    update public.meetings set
      start_at = v_slot.start_at,
      end_at = v_slot.end_at,
      status = 'rescheduled',
      rescheduled_count = rescheduled_count + 1
    where id = v_meeting.id
    returning * into v_meeting;
  exception when exclusion_violation then
    return jsonb_build_object(
      'status', 'slot_unavailable',
      'alternatives', private.slots_json(v_meeting.prospect_id, v_meeting.purpose,
                                         greatest(p_start - interval '1 day', now()), p_start + interval '7 days', 6)
    );
  end;

  perform private.record_meeting_event(v_meeting, 'meeting.rescheduled',
    jsonb_build_object('from_start_at', v_previous, 'to_start_at', v_meeting.start_at), p_correlation_id);
  return jsonb_build_object('status', 'booked', 'replayed', false, 'meeting', private.client_meeting_json(v_meeting.id));
end;
$$;

-- AT-011: when no slot works or the scheduler is down, the request becomes an
-- internal follow-up task for the right owner instead of a dead end.
create function private.request_callback(
  p_prospect public.prospects,
  p_purpose public.meeting_purpose,
  p_message text,
  p_idempotency_key text,
  p_correlation_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task uuid;
  v_correlation text := coalesce(p_correlation_id, gen_random_uuid()::text);
begin
  if p_message is not null and length(p_message) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'message is too long';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'idempotency key is required';
  end if;

  v_task := private.create_ops_task(
    p_prospect.organization_id, 'callback_request',
    format('Call back %s (%s call)', p_prospect.name, p_purpose),
    nullif(btrim(p_message), ''),
    case when p_purpose = 'commercial' then 'commercial' else 'operations' end,
    p_prospect.owner_user_id, p_prospect.id, 'prospect', p_prospect.id,
    'callback:' || p_idempotency_key
  );
  if v_task is null then
    return null; -- replayed request
  end if;

  insert into public.outreach_events (
    organization_id, prospect_id, channel, direction, event_type, summary, actor_id, correlation_id
  )
  values (p_prospect.organization_id, p_prospect.id, 'portal', 'inbound', 'client.callback_requested',
          nullif(btrim(p_message), ''), (select auth.uid()), v_correlation);
  update public.prospects set next_action_at = now() where id = p_prospect.id;
  perform private.write_event(p_prospect.organization_id, 'prospect', p_prospect.id, 'prospect.callback_requested',
    jsonb_build_object('purpose', p_purpose, 'task_id', v_task), 'app', v_correlation);
  return v_task;
end;
$$;

create function private.can_read_meeting(p_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meetings m
    where m.id = p_meeting_id
      and (
        private.has_permission(m.organization_id, 'meetings.read_all')
        or (m.host_user_id = (select auth.uid()) and private.is_active_member(m.organization_id))
        or private.can_read_prospect(m.prospect_id)
      )
  );
$$;

create function private.can_manage_meeting(p_meeting_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meetings m
    where m.id = p_meeting_id
      and (
        private.has_permission(m.organization_id, 'meetings.manage')
        or (m.host_user_id = (select auth.uid()) and private.is_active_member(m.organization_id))
      )
  );
$$;

-- A valid (unexpired, unrevoked, unredeemed) invitation's prospect, or null.
create function private.token_prospect(p_token_hash text)
returns public.prospects
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_invitation public.invitations;
  v_prospect public.prospects;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select * into v_invitation from public.invitations where token_hash = p_token_hash;
  if not found or private.invitation_state(v_invitation) not in ('created', 'sent', 'opened') then
    return null;
  end if;
  select * into v_prospect from public.prospects where id = v_invitation.prospect_id;
  return v_prospect;
end;
$$;

-- The prospect a signed-in client acts for; NOT_FOUND unless they have access.
create function private.client_prospect(p_prospect_id uuid)
returns public.prospects
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects;
  v_id uuid := p_prospect_id;
begin
  perform private.require_user();
  if v_id is null then
    select ca.prospect_id into v_id from public.client_access ca
    where ca.user_id = (select auth.uid()) and ca.status = 'active'
    order by ca.created_at
    limit 1;
  end if;
  if v_id is null or not private.client_has_access(v_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  select * into v_prospect from public.prospects where id = v_id;
  return v_prospect;
end;
$$;

-- ===========================================================================
-- Contracts and e-signature
-- ===========================================================================

create table public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9-]{2,64}$'),
  version integer not null check (version > 0),
  name text not null check (length(btrim(name)) between 1 and 200),
  body text not null check (length(body) between 1 and 100000),
  template_hash text not null check (template_hash ~ '^[0-9a-f]{64}$'),
  jurisdiction_review_status text not null default 'pending'
    check (jurisdiction_review_status in ('pending', 'approved', 'rejected')),
  review_note text check (length(review_note) <= 2000),
  active boolean not null default false,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key, version)
);

create unique index contract_templates_one_active_key on public.contract_templates (organization_id, key) where active;

create trigger contract_templates_set_updated_at before update on public.contract_templates
  for each row execute function private.set_updated_at();

create function private.guard_contract_template()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'templates are never deleted';
  end if;
  if (new.organization_id, new.key, new.version, new.body, new.template_hash)
     is distinct from (old.organization_id, old.key, old.version, old.body, old.template_hash) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'template versions are immutable; save a new version';
  end if;
  return new;
end;
$$;

create trigger contract_templates_guard before update or delete on public.contract_templates
  for each row execute function private.guard_contract_template();

create function private.template_placeholders_valid(p_body text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not exists (
    select 1 from regexp_matches(p_body, '\{\{([^}]*)\}\}', 'g') as m
    where btrim(m[1]) not in (
      'organization_name', 'client_legal_name', 'client_address', 'client_tax_line', 'proposal_title',
      'version_number', 'accepted_on', 'terms_hash', 'summary', 'scope', 'deliverables', 'timeline',
      'dependencies', 'assumptions', 'exclusions', 'fees', 'subtotal', 'discount', 'tax', 'total',
      'currency', 'payment_schedule', 'terms', 'signer_name', 'signer_email'
    )
  );
$$;

create function private.default_contract_template_body()
returns text
language sql
immutable
set search_path = ''
as $body$
  select $tpl$ATMORS SERVICES AGREEMENT

DRAFT TEMPLATE: this wording has not yet been reviewed by a qualified Indian legal professional. Approve or replace it before using it with clients.

This agreement is between {{organization_name}} ("Atmors") and {{client_legal_name}}, of {{client_address}}{{client_tax_line}} (the "Client").

It puts into effect proposal "{{proposal_title}}", version {{version_number}}, which the Client accepted on {{accepted_on}} (terms reference {{terms_hash}}). If this agreement and that proposal differ, this agreement applies.

1. Summary
{{summary}}

2. Scope of services
{{scope}}

3. Deliverables
{{deliverables}}

4. Timeline
{{timeline}}

5. Dependencies
{{dependencies}}

6. Assumptions
{{assumptions}}

7. Exclusions
{{exclusions}}

8. Fees
{{fees}}
Subtotal: {{subtotal}}
Discount: {{discount}}
Tax: {{tax}}
Total: {{total}}

9. Payment schedule
{{payment_schedule}}

10. Further terms
{{terms}}

11. Signatures
Signed for the Client by {{signer_name}} ({{signer_email}}).
Signed for Atmors by an authorised signatory.
$tpl$;
$body$;

create function private.seed_organization_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := private.default_contract_template_body();
begin
  insert into public.contract_templates (
    organization_id, key, version, name, body, template_hash, active
  )
  values (
    new.id, 'services-agreement', 1, 'Services agreement (draft, pending legal review)', v_body,
    encode(sha256(convert_to(v_body, 'UTF8')), 'hex'), true
  )
  on conflict (organization_id, key, version) do nothing;
  return new;
end;
$$;

create trigger organizations_seed_defaults after insert on public.organizations
  for each row execute function private.seed_organization_defaults();

-- Existing organizations get the default template too.
insert into public.contract_templates (organization_id, key, version, name, body, template_hash, active)
select o.id, 'services-agreement', 1, 'Services agreement (draft, pending legal review)',
       private.default_contract_template_body(),
       encode(sha256(convert_to(private.default_contract_template_body(), 'UTF8')), 'hex'), true
from public.organizations o
on conflict (organization_id, key, version) do nothing;

create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  proposal_id uuid not null references public.proposals (id) on delete restrict,
  -- AT-012: always the exact accepted proposal version.
  proposal_version_id uuid not null references public.proposal_versions (id) on delete restrict,
  template_id uuid not null references public.contract_templates (id) on delete restrict,
  template_version integer not null,
  template_hash text not null check (template_hash ~ '^[0-9a-f]{64}$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  status public.contract_status not null default 'draft',
  client_legal_name text not null check (length(btrim(client_legal_name)) between 2 and 200),
  client_address text not null check (length(btrim(client_address)) between 5 and 500),
  client_tax_id text check (length(client_tax_id) <= 32),
  signer_name text not null check (length(btrim(signer_name)) between 2 and 120),
  signer_email text not null check (length(signer_email) between 3 and 320),
  countersigner_user_id uuid not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor >= 0),
  rendered_document text not null check (length(rendered_document) <= 200000),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  -- {required_contract_state, required_payment_items[], required_onboarding_state, required_manual_review}
  activation_policy jsonb,
  activation_policy_version integer not null default 1,
  activation_eligible boolean not null default false,
  eligible_at timestamptz,
  activation_reviewed_at timestamptz,
  activation_reviewed_by uuid references public.profiles (id) on delete set null,
  provider text check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_document_id text check (length(provider_document_id) <= 200),
  sent_at timestamptz,
  first_viewed_at timestamptz,
  executed_at timestamptz,
  declined_at timestamptz,
  voided_at timestamptz,
  void_reason text check (length(void_reason) <= 2000),
  supersedes_contract_id uuid references public.contracts (id) on delete restrict,
  amendment_reason text check (length(amendment_reason) <= 2000),
  amendment_text text check (length(amendment_text) <= 20000),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_document_id),
  check (supersedes_contract_id is null or amendment_reason is not null),
  foreign key (organization_id, countersigner_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

-- One live agreement per accepted version; amendments link to the original.
create unique index contracts_one_live_per_version on public.contracts (proposal_version_id)
  where supersedes_contract_id is null and status not in ('voided', 'declined', 'expired');
create index contracts_org_status_idx on public.contracts (organization_id, status);
create index contracts_prospect_idx on public.contracts (prospect_id);

create trigger contracts_set_updated_at before update on public.contracts
  for each row execute function private.set_updated_at();

-- AT-013: the document, its inputs and its checksum freeze once the draft is
-- marked ready; an executed agreement cannot change state at all.
create function private.guard_contract()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'contracts are never deleted';
  end if;
  if (new.organization_id, new.prospect_id, new.proposal_id, new.proposal_version_id, new.template_id,
      new.template_version, new.template_hash, new.supersedes_contract_id)
     is distinct from
     (old.organization_id, old.prospect_id, old.proposal_id, old.proposal_version_id, old.template_id,
      old.template_version, old.template_hash, old.supersedes_contract_id) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'contract lineage is immutable';
  end if;
  if old.status <> 'draft' and (
       new.rendered_document, new.checksum, new.client_legal_name, new.client_address, new.client_tax_id,
       new.signer_name, new.signer_email, new.countersigner_user_id, new.currency, new.total_minor,
       new.activation_policy, new.activation_policy_version, new.amendment_text, new.title
     ) is distinct from (
       old.rendered_document, old.checksum, old.client_legal_name, old.client_address, old.client_tax_id,
       old.signer_name, old.signer_email, old.countersigner_user_id, old.currency, old.total_minor,
       old.activation_policy, old.activation_policy_version, old.amendment_text, old.title
     ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'contract content is immutable once ready to send; create an amendment';
  end if;
  if old.status = 'executed' and (
       new.status, new.provider, new.provider_document_id, new.sent_at, new.executed_at
     ) is distinct from (
       old.status, old.provider, old.provider_document_id, old.sent_at, old.executed_at
     ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'an executed contract cannot be edited in place; create an amendment';
  end if;
  return new;
end;
$$;

create trigger contracts_guard before update or delete on public.contracts
  for each row execute function private.guard_contract();

create table public.contract_signers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  role text not null check (role in ('client', 'atmors')),
  position integer not null check (position >= 0),
  name text not null check (length(btrim(name)) between 1 and 120),
  email text not null check (length(email) between 3 and 320),
  user_id uuid references public.profiles (id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'signed', 'declined')),
  signed_at timestamptz,
  -- Provider evidence reference (audit certificate ID, event ID), never raw payloads.
  evidence jsonb not null default '{}'::jsonb,
  unique (contract_id, role)
);

create table public.signature_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  contract_id uuid references public.contracts (id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  event_type text not null check (length(event_type) <= 64),
  signature_verified boolean not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  provider_document_id text check (length(provider_document_id) <= 200),
  -- Normalized, minimal fields only (signer role/email, occurred_at).
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processed', 'duplicate', 'quarantined', 'ignored')),
  error_code text check (length(error_code) <= 64),
  correlation_id text not null check (length(correlation_id) between 1 and 128)
);

-- Only verified events claim a provider event ID, so a forged event cannot
-- pre-empt (and suppress) the genuine one.
create unique index signature_events_verified_key on public.signature_events (provider, provider_event_id)
  where signature_verified;
create index signature_events_contract_idx on public.signature_events (contract_id, received_at);
create index signature_events_status_idx on public.signature_events (processing_status, received_at);

create table public.activation_evaluations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  eligible boolean not null,
  blocking_reasons text[] not null default '{}',
  policy_version integer not null,
  policy jsonb not null,
  source text not null check (source in ('app', 'system', 'webhook')),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  evaluated_at timestamptz not null default now()
);

create index activation_evaluations_contract_idx on public.activation_evaluations (contract_id, evaluated_at desc);

create trigger activation_evaluations_append_only before update or delete on public.activation_evaluations
  for each row execute function private.reject_mutation();

-- ===========================================================================
-- Billing
-- ===========================================================================

create table public.payment_schedule_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  schedule_version integer not null default 1 check (schedule_version > 0),
  position integer not null check (position >= 0),
  label text not null check (length(btrim(label)) between 1 and 120),
  due_rule text not null check (due_rule in ('on_acceptance', 'on_signing', 'on_date', 'on_milestone')),
  due_date date,
  milestone text check (length(milestone) <= 200),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  activation_relevant boolean not null default false,
  status text not null default 'scheduled' check (status in ('scheduled', 'invoiced', 'paid', 'cancelled')),
  created_at timestamptz not null default now(),
  unique (contract_id, schedule_version, position)
);

create function private.guard_schedule_item()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'schedule items are never deleted';
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'a materialized payment schedule is immutable';
  end if;
  return new;
end;
$$;

create trigger payment_schedule_items_guard before update or delete on public.payment_schedule_items
  for each row execute function private.guard_schedule_item();

-- Invoice numbering per Indian financial year (April-March). The format is a
-- placeholder pending accountant review (PRD §5.6).
create table public.invoice_counters (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  fiscal_year text not null check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_number integer not null default 0,
  primary key (organization_id, fiscal_year)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  schedule_item_id uuid not null references public.payment_schedule_items (id) on delete restrict,
  invoice_number text check (length(invoice_number) <= 40),
  label text not null check (length(btrim(label)) between 1 and 200),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  total_minor bigint not null check (total_minor > 0),
  paid_minor bigint not null default 0 check (paid_minor >= 0),
  balance_minor bigint not null,
  status public.invoice_status not null default 'issued',
  allow_partial boolean not null default false,
  tax_snapshot jsonb not null default '{}'::jsonb,
  issued_at timestamptz,
  due_at timestamptz,
  voided_at timestamptz,
  void_reason text check (length(void_reason) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, invoice_number),
  check (balance_minor = total_minor - paid_minor),
  check (paid_minor <= total_minor)
);

create unique index invoices_one_live_per_item on public.invoices (schedule_item_id) where status <> 'voided';
create index invoices_org_status_idx on public.invoices (organization_id, status, due_at);
create index invoices_contract_idx on public.invoices (contract_id);
create index invoices_prospect_idx on public.invoices (prospect_id);

create trigger invoices_set_updated_at before update on public.invoices
  for each row execute function private.set_updated_at();

create function private.guard_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'invoices are never deleted';
  end if;
  if (new.organization_id, new.prospect_id, new.contract_id, new.schedule_item_id, new.invoice_number,
      new.currency, new.total_minor, new.tax_snapshot, new.issued_at, new.label)
     is distinct from
     (old.organization_id, old.prospect_id, old.contract_id, old.schedule_item_id, old.invoice_number,
      old.currency, old.total_minor, old.tax_snapshot, old.issued_at, old.label) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'issued invoice details are immutable; void and reissue';
  end if;
  if old.status = 'voided' and new.status <> 'voided' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'a voided invoice stays voided';
  end if;
  return new;
end;
$$;

create trigger invoices_guard before update or delete on public.invoices
  for each row execute function private.guard_invoice();

-- Payment attempts and manual reconciliations. Status follows the PRD's
-- payment-attempt machine; refunds and disputes adjust, never erase.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  invoice_id uuid not null references public.invoices (id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_order_id text check (length(provider_order_id) <= 200),
  provider_payment_id text check (length(provider_payment_id) <= 200),
  idempotency_key text not null check (length(idempotency_key) between 8 and 128),
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  status public.payment_status not null default 'created',
  refunded_minor bigint not null default 0 check (refunded_minor >= 0),
  disputed_minor bigint not null default 0 check (disputed_minor >= 0),
  failure_code text check (length(failure_code) <= 64),
  -- Manual reconciliation is visibly marked and carries its reason and evidence (PRD §4).
  manual boolean not null default false,
  manual_reason text check (length(manual_reason) <= 2000),
  manual_reference text check (length(manual_reference) <= 200),
  initiated_by uuid references auth.users (id) on delete set null,
  succeeded_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (invoice_id, idempotency_key),
  unique (provider, provider_order_id),
  unique (provider, provider_payment_id),
  check (refunded_minor <= amount_minor),
  check (not manual or (manual_reason is not null and provider = 'manual'))
);

create index payments_invoice_idx on public.payments (invoice_id, created_at);
create index payments_stale_idx on public.payments (organization_id, created_at) where status in ('created', 'pending');

create trigger payments_set_updated_at before update on public.payments
  for each row execute function private.set_updated_at();

create function private.guard_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'payments are never deleted';
  end if;
  if (new.organization_id, new.invoice_id, new.provider, new.amount_minor, new.currency, new.idempotency_key, new.manual)
     is distinct from (old.organization_id, old.invoice_id, old.provider, old.amount_minor, old.currency, old.idempotency_key, old.manual) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'payment amount and identity are immutable';
  end if;
  if new.refunded_minor < old.refunded_minor then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'refunds cannot be reversed';
  end if;
  return new;
end;
$$;

create trigger payments_guard before update or delete on public.payments
  for each row execute function private.guard_payment();

create table public.payment_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  payment_id uuid not null references public.payments (id) on delete restrict,
  kind text not null check (kind in ('refund', 'dispute_opened', 'dispute_won', 'dispute_lost')),
  provider_ref text not null check (length(provider_ref) between 1 and 200),
  amount_minor bigint not null check (amount_minor >= 0),
  payment_event_id uuid,
  occurred_at timestamptz not null default now(),
  unique (payment_id, kind, provider_ref)
);

create trigger payment_adjustments_append_only before update or delete on public.payment_adjustments
  for each row execute function private.reject_mutation();

create table public.payment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations (id) on delete restrict,
  provider text not null check (provider ~ '^[a-z0-9_]{2,32}$'),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  event_type text not null check (length(event_type) <= 64),
  signature_verified boolean not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  -- Normalized fields only: order/payment/refund/dispute IDs, amount, currency, account.
  data jsonb not null default '{}'::jsonb,
  invoice_id uuid references public.invoices (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete restrict,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processed', 'duplicate', 'quarantined', 'ignored')),
  error_code text check (length(error_code) <= 64),
  correlation_id text not null check (length(correlation_id) between 1 and 128)
);

create unique index payment_events_verified_key on public.payment_events (provider, provider_event_id)
  where signature_verified;
create index payment_events_status_idx on public.payment_events (processing_status, received_at);
create index payment_events_invoice_idx on public.payment_events (invoice_id);

alter table public.payment_adjustments
  add constraint payment_adjustments_event_fkey
    foreign key (payment_event_id) references public.payment_events (id) on delete restrict;

-- Provider events: only the processing outcome may change (for safe replay).
create function private.guard_provider_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'APPEND_ONLY', detail = 'provider events are never deleted';
  end if;
  if (to_jsonb(new) - array['processed_at', 'processing_status', 'error_code', 'organization_id',
                            'invoice_id', 'payment_id', 'contract_id'])
     is distinct from
     (to_jsonb(old) - array['processed_at', 'processing_status', 'error_code', 'organization_id',
                            'invoice_id', 'payment_id', 'contract_id']) then
    raise exception using errcode = '42501', message = 'APPEND_ONLY', detail = 'provider event evidence is immutable';
  end if;
  return new;
end;
$$;

create trigger payment_events_guard before update or delete on public.payment_events
  for each row execute function private.guard_provider_event();
create trigger signature_events_guard before update or delete on public.signature_events
  for each row execute function private.guard_provider_event();

-- ---------------------------------------------------------------------------
-- Billing helpers
-- ---------------------------------------------------------------------------

create function private.next_invoice_number(p_organization_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.today_ist();
  v_start integer := case when extract(month from v_today) >= 4
                          then extract(year from v_today)::integer
                          else extract(year from v_today)::integer - 1 end;
  v_fy text := v_start::text || '-' || lpad(((v_start + 1) % 100)::text, 2, '0');
  v_number integer;
begin
  insert into public.invoice_counters (organization_id, fiscal_year, last_number)
  values (p_organization_id, v_fy, 1)
  on conflict (organization_id, fiscal_year) do update set last_number = public.invoice_counters.last_number + 1
  returning last_number into v_number;
  return 'INV-' || v_fy || '-' || lpad(v_number::text, 4, '0');
end;
$$;

create function private.issue_invoice(p_item_id uuid, p_due_at timestamptz, p_correlation_id text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.payment_schedule_items;
  v_contract public.contracts;
  v_version public.proposal_versions;
  v_invoice public.invoices;
begin
  select * into v_item from public.payment_schedule_items where id = p_item_id for update;
  if v_item.status <> 'scheduled' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'instalment is already invoiced';
  end if;
  select * into v_contract from public.contracts where id = v_item.contract_id;
  select * into v_version from public.proposal_versions where id = v_contract.proposal_version_id;

  insert into public.invoices (
    organization_id, prospect_id, contract_id, schedule_item_id, invoice_number, label, currency,
    total_minor, paid_minor, balance_minor, status, tax_snapshot, issued_at, due_at
  )
  values (
    v_item.organization_id, v_contract.prospect_id, v_contract.id, v_item.id,
    private.next_invoice_number(v_item.organization_id), v_item.label, v_item.currency,
    v_item.amount_minor, 0, v_item.amount_minor, 'issued',
    jsonb_build_object(
      'basis', 'proportional_estimate',
      'tax_minor', case when v_version.total_minor > 0
        then round(v_version.tax_minor::numeric * v_item.amount_minor / v_version.total_minor)::bigint else 0 end,
      'review_required', true
    ),
    now(), p_due_at
  )
  returning * into v_invoice;

  update public.payment_schedule_items set status = 'invoiced' where id = v_item.id;

  perform private.write_audit(v_invoice.organization_id, 'invoice.issued', 'invoice', v_invoice.id, null,
    jsonb_build_object('invoice_number', v_invoice.invoice_number, 'total_minor', v_invoice.total_minor,
                       'currency', v_invoice.currency, 'due_at', v_invoice.due_at),
    null, p_correlation_id);
  perform private.write_event(v_invoice.organization_id, 'invoice', v_invoice.id, 'invoice.issued',
    jsonb_build_object('contract_id', v_contract.id, 'schedule_item_id', v_item.id, 'total_minor', v_invoice.total_minor),
    case when (select auth.uid()) is null then 'system' else 'app' end, p_correlation_id);
  return v_invoice;
end;
$$;

-- Payment allocation is computed from payment records, never stored blindly.
create function private.recompute_invoice(p_invoice_id uuid, p_correlation_id text)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.invoices;
  v_after public.invoices;
  v_paid bigint;
  v_disputed boolean;
  v_status public.invoice_status;
begin
  select * into v_before from public.invoices where id = p_invoice_id for update;
  if v_before.status in ('voided', 'draft') then
    return v_before;
  end if;

  select coalesce(sum(p.amount_minor - p.refunded_minor), 0),
         coalesce(bool_or(p.status = 'disputed'), false)
  into v_paid, v_disputed
  from public.payments p
  where p.invoice_id = p_invoice_id and p.status in ('succeeded', 'refunded', 'disputed');

  v_status := case
    when v_disputed then 'disputed'
    when v_paid >= v_before.total_minor then 'paid'
    when v_paid > 0 then 'partially_paid'
    when v_before.due_at is not null and v_before.due_at < now() then 'overdue'
    else 'issued'
  end::public.invoice_status;

  update public.invoices set
    paid_minor = least(v_paid, total_minor),
    balance_minor = total_minor - least(v_paid, total_minor),
    status = v_status
  where id = p_invoice_id
  returning * into v_after;

  update public.payment_schedule_items
  set status = case when v_status = 'paid' then 'paid' else 'invoiced' end
  where id = v_after.schedule_item_id and status <> 'cancelled';

  if v_after.status is distinct from v_before.status or v_after.paid_minor <> v_before.paid_minor then
    perform private.write_event(v_after.organization_id, 'invoice', v_after.id, 'invoice.balance_changed',
      jsonb_build_object('from_status', v_before.status, 'to_status', v_after.status,
                         'paid_minor', v_after.paid_minor, 'balance_minor', v_after.balance_minor),
      case when (select auth.uid()) is null then 'webhook' else 'app' end, p_correlation_id);
  end if;
  return v_after;
end;
$$;

-- PRD §8 activation policy: reads authoritative records and returns
-- {eligible, evaluated_at, policy_version, blocking_reasons}. The client can
-- never set eligibility (AT-025 builds on this in Phase 4).
create function private.evaluate_activation(p_contract_id uuid, p_source text, p_correlation_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts;
  v_policy jsonb;
  v_reasons text[] := '{}';
  v_position integer;
  v_item_status text;
  v_eligible boolean;
  v_now timestamptz := now();
  v_correlation text := coalesce(p_correlation_id, gen_random_uuid()::text);
begin
  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found or v_contract.activation_policy is null then
    return null;
  end if;
  v_policy := v_contract.activation_policy;

  if v_policy ->> 'required_contract_state' = 'executed' and v_contract.status <> 'executed' then
    v_reasons := array_append(v_reasons, 'contract_not_executed');
  end if;

  for v_position in select jsonb_array_elements_text(v_policy -> 'required_payment_items')::integer loop
    select i.status into v_item_status
    from public.payment_schedule_items i
    where i.contract_id = v_contract.id and i.schedule_version = 1 and i.position = v_position;
    if v_item_status is distinct from 'paid' then
      v_reasons := array_append(v_reasons, 'payment_item_unpaid:' || v_position);
    end if;
  end loop;

  -- Onboarding arrives in Phase 4; until then a required approval blocks.
  if v_policy ->> 'required_onboarding_state' = 'approved' then
    v_reasons := array_append(v_reasons, 'onboarding_not_approved');
  end if;
  if coalesce((v_policy ->> 'required_manual_review')::boolean, false) and v_contract.activation_reviewed_at is null then
    v_reasons := array_append(v_reasons, 'manual_review_pending');
  end if;

  v_eligible := cardinality(v_reasons) = 0;

  insert into public.activation_evaluations (
    organization_id, contract_id, eligible, blocking_reasons, policy_version, policy, source, correlation_id, evaluated_at
  )
  values (v_contract.organization_id, v_contract.id, v_eligible, v_reasons, v_contract.activation_policy_version,
          v_policy, p_source, v_correlation, v_now);

  if v_eligible is distinct from v_contract.activation_eligible then
    update public.contracts set
      activation_eligible = v_eligible,
      eligible_at = case when v_eligible then coalesce(eligible_at, v_now) else eligible_at end
    where id = v_contract.id;
    perform private.write_event(v_contract.organization_id, 'contract', v_contract.id,
      case when v_eligible then 'contract.activation_eligible' else 'contract.activation_blocked' end,
      jsonb_build_object('blocking_reasons', v_reasons, 'policy_version', v_contract.activation_policy_version),
      p_source, v_correlation);
    if v_eligible then
      perform private.create_ops_task(v_contract.organization_id, 'kickoff_ready',
        'Activation conditions met: prepare kickoff', null, 'operations', null, v_contract.prospect_id,
        'contract', v_contract.id, 'kickoff:' || v_contract.id);
    elsif v_contract.eligible_at is not null then
      perform private.create_ops_task(v_contract.organization_id, 'activation_regressed',
        'Activation conditions no longer met', array_to_string(v_reasons, ', '), 'operations', null,
        v_contract.prospect_id, 'contract', v_contract.id, 'regressed:' || v_contract.id || ':' || v_correlation);
    end if;
  end if;

  return jsonb_build_object(
    'eligible', v_eligible,
    'evaluated_at', v_now,
    'policy_version', v_contract.activation_policy_version,
    'blocking_reasons', to_jsonb(v_reasons)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Contract helpers
-- ---------------------------------------------------------------------------

create function private.bullets(p_items jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select string_agg('- ' || btrim(value), E'\n' order by ord)
     from jsonb_array_elements_text(coalesce(p_items, '[]'::jsonb)) with ordinality as t(value, ord)
     where length(btrim(value)) > 0),
    'None.');
$$;

create function private.render_contract(
  p_template_body text,
  p_version_id uuid,
  p_legal jsonb,
  p_amendment_text text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version public.proposal_versions;
  v_proposal public.proposals;
  v_org_name text;
  v_amounts bigint[];
  v_vars jsonb;
  v_out text := p_template_body;
  v_key text;
  v_value text;
begin
  select * into v_version from public.proposal_versions where id = p_version_id;
  select * into v_proposal from public.proposals where id = v_version.proposal_id;
  select name into v_org_name from public.organizations where id = v_version.organization_id;
  v_amounts := private.schedule_amounts(v_version.payment_schedule, v_version.total_minor);

  v_vars := jsonb_build_object(
    'organization_name', v_org_name,
    'client_legal_name', btrim(p_legal ->> 'client_legal_name'),
    'client_address', btrim(p_legal ->> 'client_address'),
    'client_tax_line', case when nullif(btrim(p_legal ->> 'client_tax_id'), '') is not null
      then ' (tax ID ' || btrim(p_legal ->> 'client_tax_id') || ')' else '' end,
    'proposal_title', v_proposal.title,
    'version_number', v_version.version_number::text,
    'accepted_on', to_char((v_proposal.accepted_at at time zone 'Asia/Kolkata')::date, 'DD Mon YYYY'),
    'terms_hash', left(v_version.content_hash, 16),
    'summary', coalesce(nullif(btrim(v_version.content ->> 'summary'), ''), 'None.'),
    'scope', coalesce(nullif(btrim(v_version.content ->> 'scope'), ''), 'None.'),
    'deliverables', private.bullets(v_version.content -> 'deliverables'),
    'timeline', coalesce(nullif(btrim(v_version.content ->> 'timeline'), ''), 'None.'),
    'dependencies', private.bullets(v_version.content -> 'dependencies'),
    'assumptions', private.bullets(v_version.content -> 'assumptions'),
    'exclusions', private.bullets(v_version.content -> 'exclusions'),
    'terms', coalesce(nullif(btrim(v_version.content ->> 'terms'), ''), 'None.'),
    'fees', coalesce((
      select string_agg(format('- %s: %s x %s = %s (incl. tax %s%%)', li.title, li.quantity::text,
               private.format_minor(li.unit_amount_minor, v_version.currency),
               private.format_minor(li.total_minor, v_version.currency),
               trim_scale(li.tax_rate_bps / 100.0)::text), E'\n' order by li.position)
      from public.proposal_line_items li where li.version_id = v_version.id), 'None.'),
    'subtotal', private.format_minor(v_version.subtotal_minor, v_version.currency),
    'discount', private.format_minor(v_version.discount_minor, v_version.currency),
    'tax', private.format_minor(v_version.tax_minor, v_version.currency),
    'total', private.format_minor(v_version.total_minor, v_version.currency),
    'currency', v_version.currency,
    'payment_schedule', coalesce((
      select string_agg(format('- %s: %s, %s', item ->> 'label',
               private.format_minor(v_amounts[ord::integer], v_version.currency),
               case item ->> 'due'
                 when 'on_acceptance' then 'due on acceptance'
                 when 'on_signing' then 'due on signing'
                 when 'on_date' then 'due on ' || (item ->> 'due_date')
                 else 'due at milestone: ' || (item ->> 'milestone')
               end), E'\n' order by ord)
      from jsonb_array_elements(v_version.payment_schedule) with ordinality as t(item, ord)), 'None.'),
    'signer_name', btrim(p_legal ->> 'signer_name'),
    'signer_email', lower(btrim(p_legal ->> 'signer_email'))
  );

  for v_key, v_value in select key, value from jsonb_each_text(v_vars) loop
    v_out := regexp_replace(v_out, '\{\{\s*' || v_key || '\s*\}\}', replace(coalesce(v_value, ''), '\', '\\'), 'g');
  end loop;

  if p_amendment_text is not null then
    v_out := v_out || E'\n\nAMENDMENT\n' || p_amendment_text;
  end if;
  return v_out;
end;
$$;

create function private.validate_activation_policy(p_policy jsonb, p_schedule_count integer)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_position text;
begin
  if p_policy is null or jsonb_typeof(p_policy) <> 'object'
     or coalesce(p_policy ->> 'required_contract_state', '') not in ('executed', 'not_required')
     or coalesce(p_policy ->> 'required_onboarding_state', '') not in ('approved', 'not_required')
     or jsonb_typeof(p_policy -> 'required_manual_review') is distinct from 'boolean'
     or jsonb_typeof(p_policy -> 'required_payment_items') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'activation policy needs contract state, payment items, onboarding state and manual review';
  end if;
  for v_position in select jsonb_array_elements_text(p_policy -> 'required_payment_items') loop
    if v_position !~ '^[0-9]{1,2}$' or v_position::integer >= p_schedule_count then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = 'activation policy refers to an instalment that does not exist';
    end if;
  end loop;
end;
$$;

create function private.on_contract_executed(p_contract public.contracts, p_correlation_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.payment_schedule_items;
  v_prospect public.prospects;
begin
  -- Instalments due on acceptance or signing are invoiced now (PRD §5.6).
  for v_item in
    select * from public.payment_schedule_items
    where contract_id = p_contract.id and status = 'scheduled' and due_rule in ('on_acceptance', 'on_signing')
    order by position
  loop
    perform private.issue_invoice(v_item.id, now() + interval '7 days', p_correlation_id);
  end loop;

  select * into v_prospect from public.prospects where id = p_contract.prospect_id for update;
  if private.prospect_transition_allowed(v_prospect.status, 'converted') then
    update public.prospects set status = 'converted' where id = v_prospect.id;
    perform private.write_audit(v_prospect.organization_id, 'prospect.status_changed', 'prospect', v_prospect.id,
      jsonb_build_object('status', v_prospect.status), jsonb_build_object('status', 'converted'),
      'agreement executed', p_correlation_id);
  end if;

  perform private.evaluate_activation(p_contract.id, 'webhook', p_correlation_id);
end;
$$;

-- Apply one verified signature event. Returns the processing outcome.
create function private.process_signature_event(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.signature_events;
  v_contract public.contracts;
  v_signer public.contract_signers;
  v_status text := 'processed';
  v_error text;
  v_pending integer;
begin
  select * into v_event from public.signature_events where id = p_event_id for update;

  select * into v_contract from public.contracts
  where provider = v_event.provider and provider_document_id = v_event.provider_document_id
  for update;
  if not found then
    v_status := 'quarantined';
    v_error := 'UNKNOWN_DOCUMENT';
  elsif not private.integration_enabled(v_contract.organization_id, 'esign', v_event.provider) then
    v_status := 'quarantined';
    v_error := 'PROVIDER_NOT_ENABLED';
  elsif v_contract.status in ('voided', 'declined', 'expired', 'draft', 'ready_to_send') then
    v_status := 'ignored';
    v_error := 'CONTRACT_NOT_OPEN';
  elsif v_event.event_type = 'document.viewed' then
    if v_contract.status = 'sent' then
      update public.contracts set status = 'viewed', first_viewed_at = coalesce(first_viewed_at, now())
      where id = v_contract.id;
    else
      v_status := 'ignored';
    end if;
  elsif v_event.event_type in ('signer.signed', 'signer.declined') then
    select * into v_signer from public.contract_signers
    where contract_id = v_contract.id and role = v_event.data ->> 'signer_role'
    for update;
    if not found or lower(v_signer.email) is distinct from lower(v_event.data ->> 'signer_email') then
      v_status := 'quarantined';
      v_error := 'SIGNER_MISMATCH';
    elsif v_contract.status = 'executed' or v_signer.status <> 'pending' then
      v_status := 'ignored'; -- already applied (out-of-order or repeated)
    elsif v_event.event_type = 'signer.declined' then
      update public.contract_signers set status = 'declined',
        evidence = jsonb_build_object('event_id', v_event.provider_event_id)
      where id = v_signer.id;
      update public.contracts set status = 'declined', declined_at = now() where id = v_contract.id
      returning * into v_contract;
      perform private.create_ops_task(v_contract.organization_id, 'contract_declined',
        'Agreement declined by a signer', null, 'commercial', null, v_contract.prospect_id,
        'contract', v_contract.id, 'declined:' || v_contract.id);
    else
      update public.contract_signers set status = 'signed', signed_at = coalesce(v_event.occurred_at, now()),
        evidence = jsonb_build_object('event_id', v_event.provider_event_id, 'payload_hash', v_event.payload_hash)
      where id = v_signer.id;
      select count(*) into v_pending from public.contract_signers
      where contract_id = v_contract.id and status = 'pending';
      if v_pending = 0 then
        update public.contracts set status = 'executed', executed_at = now() where id = v_contract.id
        returning * into v_contract;
      else
        update public.contracts set status = 'partially_signed' where id = v_contract.id
        returning * into v_contract;
      end if;
    end if;
  elsif v_event.event_type = 'document.completed' then
    -- The provider says every party has signed; treat as authoritative.
    if v_contract.status = 'executed' then
      v_status := 'ignored';
    else
      update public.contract_signers set status = 'signed', signed_at = coalesce(signed_at, v_event.occurred_at, now()),
        evidence = evidence || jsonb_build_object('completed_event_id', v_event.provider_event_id)
      where contract_id = v_contract.id and status = 'pending';
      update public.contracts set status = 'executed', executed_at = now() where id = v_contract.id
      returning * into v_contract;
    end if;
  else
    v_status := 'ignored';
    v_error := 'UNHANDLED_EVENT_TYPE';
  end if;

  update public.signature_events set
    processing_status = v_status,
    error_code = v_error,
    processed_at = now(),
    organization_id = coalesce(v_contract.organization_id, organization_id),
    contract_id = coalesce(v_contract.id, contract_id)
  where id = v_event.id;

  if v_contract.id is not null and v_status = 'processed' then
    perform private.write_audit(v_contract.organization_id, 'contract.signature_event', 'contract', v_contract.id,
      null, jsonb_build_object('event_type', v_event.event_type, 'status', v_contract.status,
                               'provider_event_id', v_event.provider_event_id),
      null, v_event.correlation_id);
    perform private.write_event(v_contract.organization_id, 'contract', v_contract.id, 'contract.' ||
      replace(v_event.event_type, '.', '_'),
      jsonb_build_object('status', v_contract.status, 'provider_event_id', v_event.provider_event_id),
      'webhook', v_event.correlation_id);
    if v_contract.status = 'executed' and v_event.event_type in ('signer.signed', 'document.completed') then
      perform private.on_contract_executed(v_contract, v_event.correlation_id);
    end if;
  end if;

  if v_status = 'quarantined' and v_contract.id is not null then
    perform private.create_ops_task(v_contract.organization_id, 'signature_event_review',
      'Signature event needs review: ' || v_error, null, 'operations', null, v_contract.prospect_id,
      'signature_event', v_event.id, 'sigevent:' || v_event.id);
  end if;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment event processing
-- ---------------------------------------------------------------------------

create function private.process_payment_event(p_event_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.payment_events;
  v_payment public.payments;
  v_invoice public.invoices;
  v_status text := 'processed';
  v_error text;
  v_expected_account text;
  v_amount bigint;
  v_adjustment_id uuid;
  v_contract_id uuid;
  v_prospect_id uuid;
begin
  select * into v_event from public.payment_events where id = p_event_id for update;

  if v_event.event_type in ('payment.succeeded', 'payment.failed') then
    select * into v_payment from public.payments
    where provider = v_event.provider and provider_order_id = v_event.data ->> 'provider_order_id'
    for update;
  else
    select * into v_payment from public.payments
    where provider = v_event.provider and provider_payment_id = v_event.data ->> 'provider_payment_id'
    for update;
  end if;

  if v_event.event_type not in ('payment.succeeded', 'payment.failed', 'refund.processed',
                                'dispute.opened', 'dispute.won', 'dispute.lost') then
    v_status := 'ignored';
    v_error := 'UNHANDLED_EVENT_TYPE';
  elsif v_payment.id is null then
    v_status := 'quarantined';
    v_error := 'UNKNOWN_PAYMENT';
  else
    select * into v_invoice from public.invoices where id = v_payment.invoice_id for update;
    select a.account_id into v_expected_account from public.integration_accounts a
    where a.organization_id = v_payment.organization_id and a.kind = 'payments'
      and a.provider = v_event.provider and a.active;

    -- AT-016: an event must come from the merchant account we expect.
    if v_expected_account is null then
      v_status := 'quarantined';
      v_error := 'PROVIDER_NOT_ENABLED';
    elsif v_event.data ->> 'account_id' is distinct from v_expected_account then
      v_status := 'quarantined';
      v_error := 'PAYMENT_MISMATCH';
    elsif v_event.event_type = 'payment.succeeded' then
      v_amount := (v_event.data ->> 'amount_minor')::bigint;
      if v_amount is distinct from v_payment.amount_minor
         or (v_event.data ->> 'currency') is distinct from v_payment.currency then
        v_status := 'quarantined';
        v_error := 'PAYMENT_MISMATCH';
      elsif v_payment.status in ('succeeded', 'refunded', 'disputed') then
        v_status := 'duplicate'; -- another event already captured this payment (AT-015)
      elsif v_invoice.status = 'voided' or v_invoice.balance_minor < v_payment.amount_minor then
        v_status := 'quarantined';
        v_error := 'OVERPAYMENT';
      else
        -- A late success after a failure is still authoritative (out-of-order).
        update public.payments set
          status = 'succeeded',
          provider_payment_id = coalesce(v_event.data ->> 'provider_payment_id', provider_payment_id),
          succeeded_at = now(),
          failure_code = null
        where id = v_payment.id
        returning * into v_payment;
      end if;
    elsif v_event.event_type = 'payment.failed' then
      if v_payment.status in ('created', 'pending') then
        update public.payments set
          status = 'failed',
          provider_payment_id = coalesce(v_event.data ->> 'provider_payment_id', provider_payment_id),
          failure_code = left(coalesce(v_event.data ->> 'failure_code', 'FAILED'), 64),
          failed_at = now()
        where id = v_payment.id
        returning * into v_payment;
      else
        v_status := 'ignored';
      end if;
    elsif v_event.event_type = 'refund.processed' then
      v_amount := (v_event.data ->> 'amount_minor')::bigint;
      if v_amount is null or v_amount <= 0 or v_amount > v_payment.amount_minor - v_payment.refunded_minor then
        v_status := 'quarantined';
        v_error := 'PAYMENT_MISMATCH';
      else
        insert into public.payment_adjustments (organization_id, payment_id, kind, provider_ref, amount_minor, payment_event_id)
        values (v_payment.organization_id, v_payment.id, 'refund', coalesce(v_event.data ->> 'refund_id', v_event.provider_event_id),
                v_amount, v_event.id)
        on conflict (payment_id, kind, provider_ref) do nothing
        returning id into v_adjustment_id;
        if v_adjustment_id is null then
          v_status := 'duplicate';
        else
          update public.payments set
            refunded_minor = refunded_minor + v_amount,
            status = case when refunded_minor + v_amount >= amount_minor then 'refunded'::public.payment_status else status end
          where id = v_payment.id
          returning * into v_payment;
        end if;
      end if;
    else
      -- Disputes (chargebacks).
      v_amount := coalesce((v_event.data ->> 'amount_minor')::bigint, v_payment.amount_minor);
      insert into public.payment_adjustments (organization_id, payment_id, kind, provider_ref, amount_minor, payment_event_id)
      values (v_payment.organization_id, v_payment.id, replace(v_event.event_type, '.', '_'),
              coalesce(v_event.data ->> 'dispute_id', v_event.provider_event_id), v_amount, v_event.id)
      on conflict (payment_id, kind, provider_ref) do nothing
      returning id into v_adjustment_id;
      if v_adjustment_id is null then
        v_status := 'duplicate';
      elsif v_event.event_type = 'dispute.opened' then
        update public.payments set status = 'disputed', disputed_minor = least(v_amount, amount_minor - refunded_minor)
        where id = v_payment.id returning * into v_payment;
      elsif v_event.event_type = 'dispute.won' then
        update public.payments set
          status = case when refunded_minor >= amount_minor then 'refunded'::public.payment_status
                        else 'succeeded'::public.payment_status end,
          disputed_minor = 0
        where id = v_payment.id returning * into v_payment;
      else
        -- A lost dispute is money returned to the payer: record it as refunded.
        v_amount := least(greatest(v_payment.disputed_minor, v_amount), v_payment.amount_minor - v_payment.refunded_minor);
        update public.payments set
          refunded_minor = refunded_minor + v_amount,
          disputed_minor = 0,
          status = case when refunded_minor + v_amount >= amount_minor
                        then 'refunded'::public.payment_status else 'succeeded'::public.payment_status end
        where id = v_payment.id returning * into v_payment;
      end if;
    end if;
  end if;

  update public.payment_events set
    processing_status = v_status,
    error_code = v_error,
    processed_at = now(),
    organization_id = coalesce(v_payment.organization_id, organization_id),
    payment_id = coalesce(v_payment.id, payment_id),
    invoice_id = coalesce(v_payment.invoice_id, invoice_id)
  where id = v_event.id;

  if v_payment.id is null then
    return v_status;
  end if;
  select contract_id, prospect_id into v_contract_id, v_prospect_id from public.invoices where id = v_payment.invoice_id;

  if v_status = 'processed' then
    v_invoice := private.recompute_invoice(v_payment.invoice_id, v_event.correlation_id);
    perform private.write_audit(v_payment.organization_id, 'payment.' || replace(v_event.event_type, '.', '_'),
      'payment', v_payment.id, null,
      jsonb_build_object('status', v_payment.status, 'amount_minor', v_payment.amount_minor,
                         'refunded_minor', v_payment.refunded_minor, 'invoice_status', v_invoice.status,
                         'provider_event_id', v_event.provider_event_id),
      null, v_event.correlation_id);
    perform private.write_event(v_payment.organization_id, 'payment', v_payment.id,
      'payment.' || replace(v_event.event_type, '.', '_'),
      jsonb_build_object('status', v_payment.status, 'invoice_id', v_payment.invoice_id,
                         'invoice_status', v_invoice.status),
      'webhook', v_event.correlation_id);
    -- AT-020: refunds and disputes trigger a finance review.
    if v_event.event_type in ('refund.processed', 'dispute.opened', 'dispute.lost') then
      perform private.create_ops_task(v_payment.organization_id, 'payment_review',
        'Review ' || replace(v_event.event_type, '.', ' ') || ' on ' || coalesce(v_invoice.invoice_number, 'invoice'),
        null, 'finance', null, v_prospect_id, 'payment', v_payment.id, 'payreview:' || v_event.id);
    end if;
    perform private.evaluate_activation(v_contract_id, 'webhook', v_event.correlation_id);
  elsif v_status = 'quarantined' then
    perform private.create_ops_task(v_payment.organization_id, 'payment_exception',
      'Payment event quarantined: ' || v_error, null, 'finance', null, v_prospect_id,
      'payment_event', v_event.id, 'payevent:' || v_event.id);
  end if;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Client-safe projections (contracts and invoices)
-- ---------------------------------------------------------------------------

create function private.client_contract_json(p_contract_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'title', c.title,
    'status', c.status,
    'is_amendment', c.supersedes_contract_id is not null,
    'client_legal_name', c.client_legal_name,
    'currency', c.currency,
    'total_minor', c.total_minor,
    'rendered_document', c.rendered_document,
    'checksum', c.checksum,
    'sent_at', c.sent_at,
    'executed_at', c.executed_at,
    'signers', coalesce((
      select jsonb_agg(jsonb_build_object('role', s.role, 'name', s.name, 'status', s.status, 'signed_at', s.signed_at)
             order by s.position)
      from public.contract_signers s where s.contract_id = c.id), '[]'::jsonb),
    'schedule', coalesce((
      select jsonb_agg(jsonb_build_object('label', i.label, 'amount_minor', i.amount_minor, 'currency', i.currency,
               'due_rule', i.due_rule, 'due_date', i.due_date, 'milestone', i.milestone, 'status', i.status)
             order by i.position)
      from public.payment_schedule_items i where i.contract_id = c.id), '[]'::jsonb)
  )
  from public.contracts c
  where c.id = p_contract_id;
$$;

create function private.client_invoice_json(p_invoice_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', i.id,
    'invoice_number', i.invoice_number,
    'label', i.label,
    'currency', i.currency,
    'total_minor', i.total_minor,
    'paid_minor', i.paid_minor,
    'balance_minor', i.balance_minor,
    'status', i.status,
    'allow_partial', i.allow_partial,
    'issued_at', i.issued_at,
    'due_at', i.due_at,
    'can_pay', i.status in ('issued', 'partially_paid', 'overdue') and i.balance_minor > 0,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status, 'amount_minor', p.amount_minor,
               'refunded_minor', p.refunded_minor, 'manual', p.manual, 'created_at', p.created_at,
               'succeeded_at', p.succeeded_at) order by p.created_at desc)
      from public.payments p where p.invoice_id = i.id), '[]'::jsonb)
  )
  from public.invoices i
  where i.id = p_invoice_id;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security (staff reads; writes only through RPCs)
-- ---------------------------------------------------------------------------

alter table public.ops_tasks enable row level security;
alter table public.integration_accounts enable row level security;
alter table public.booking_hosts enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_events enable row level security;
alter table public.contract_templates enable row level security;
alter table public.contracts enable row level security;
alter table public.contract_signers enable row level security;
alter table public.signature_events enable row level security;
alter table public.activation_evaluations enable row level security;
alter table public.payment_schedule_items enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoices enable row level security;
alter table public.payments enable row level security;
alter table public.payment_adjustments enable row level security;
alter table public.payment_events enable row level security;

revoke all on public.ops_tasks, public.integration_accounts, public.booking_hosts, public.meetings,
  public.meeting_events, public.contract_templates, public.contracts, public.contract_signers,
  public.signature_events, public.activation_evaluations, public.payment_schedule_items,
  public.invoice_counters, public.invoices, public.payments, public.payment_adjustments,
  public.payment_events from anon, authenticated;

grant select on public.ops_tasks to authenticated;
create policy ops_tasks_select on public.ops_tasks
  for select to authenticated
  using (private.can_see_ops_task(ops_tasks));

grant select on public.integration_accounts to authenticated;
create policy integration_accounts_select on public.integration_accounts
  for select to authenticated
  using (
    (select private.has_permission(organization_id, 'integrations.monitor'))
    or (select private.has_permission(organization_id, 'billing.manage'))
  );

grant select on public.booking_hosts to authenticated;
create policy booking_hosts_select on public.booking_hosts
  for select to authenticated
  using ((select private.is_active_member(organization_id)));

grant select on public.meetings to authenticated;
create policy meetings_select on public.meetings
  for select to authenticated
  using ((select private.can_read_meeting(id)));

grant select on public.meeting_events to authenticated;
create policy meeting_events_select on public.meeting_events
  for select to authenticated
  using ((select private.can_read_meeting(meeting_id)));

grant select on public.contract_templates to authenticated;
create policy contract_templates_select on public.contract_templates
  for select to authenticated
  using ((select private.has_permission(organization_id, 'contracts.read')));

grant select on public.contracts to authenticated;
create policy contracts_select on public.contracts
  for select to authenticated
  using ((select private.has_permission(organization_id, 'contracts.read')));

grant select on public.contract_signers to authenticated;
create policy contract_signers_select on public.contract_signers
  for select to authenticated
  using ((select private.has_permission(organization_id, 'contracts.read')));

grant select on public.signature_events to authenticated;
create policy signature_events_select on public.signature_events
  for select to authenticated
  using (
    organization_id is not null
    and ((select private.has_permission(organization_id, 'contracts.read'))
         or (select private.has_permission(organization_id, 'integrations.monitor')))
  );

-- Operations needs activation status (not contract terms) to plan kickoff.
grant select on public.activation_evaluations to authenticated;
create policy activation_evaluations_select on public.activation_evaluations
  for select to authenticated
  using (
    (select private.has_permission(organization_id, 'contracts.read'))
    or (select private.has_permission(organization_id, 'operations.manage'))
  );

grant select on public.payment_schedule_items to authenticated;
create policy payment_schedule_items_select on public.payment_schedule_items
  for select to authenticated
  using (
    (select private.has_permission(organization_id, 'contracts.read'))
    or (select private.has_permission(organization_id, 'finance.read'))
  );

grant select on public.invoices to authenticated;
create policy invoices_select on public.invoices
  for select to authenticated
  using ((select private.has_permission(organization_id, 'finance.read')));

grant select on public.payments to authenticated;
create policy payments_select on public.payments
  for select to authenticated
  using ((select private.has_permission(organization_id, 'finance.read')));

grant select on public.payment_adjustments to authenticated;
create policy payment_adjustments_select on public.payment_adjustments
  for select to authenticated
  using ((select private.has_permission(organization_id, 'finance.read')));

grant select on public.payment_events to authenticated;
create policy payment_events_select on public.payment_events
  for select to authenticated
  using (organization_id is not null and (select private.has_permission(organization_id, 'finance.read')));

-- invoice_counters: no client-session access at all.

-- Provider evidence and history cannot be rewritten even by the service role;
-- the system worker goes through the ingest RPCs.
revoke update, delete, truncate on public.payment_events, public.signature_events, public.payment_adjustments,
  public.meeting_events, public.activation_evaluations from service_role;
revoke delete, truncate on public.payments, public.invoices, public.contracts, public.payment_schedule_items
  from service_role;

-- ===========================================================================
-- RPCs: internal tasks and integration configuration
-- ===========================================================================

create function public.complete_ops_task(
  p_task_id uuid,
  p_outcome text,
  p_resolution text default null,
  p_correlation_id text default null
)
returns public.ops_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_task public.ops_tasks;
begin
  perform private.require_correlation_id(p_correlation_id);
  if p_outcome not in ('done', 'cancelled') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'outcome must be done or cancelled';
  end if;
  if p_outcome = 'cancelled' then
    perform private.require_reason(p_resolution);
  end if;

  select * into v_task from public.ops_tasks where id = p_task_id for update;
  if not found or not private.can_see_ops_task(v_task) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_task.status <> 'open' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'task is already closed';
  end if;

  update public.ops_tasks set status = p_outcome::public.ops_task_status, resolution = nullif(btrim(p_resolution), ''),
    completed_at = now(), completed_by = v_uid
  where id = p_task_id
  returning * into v_task;

  perform private.write_audit(v_task.organization_id, 'ops_task.' || p_outcome, 'ops_task', v_task.id,
    jsonb_build_object('status', 'open'), jsonb_build_object('status', v_task.status, 'kind', v_task.kind),
    p_resolution, p_correlation_id);
  return v_task;
end;
$$;

create function public.configure_integration_account(
  p_organization_id uuid,
  p_kind text,
  p_provider text,
  p_account_id text,
  p_active boolean,
  p_correlation_id text default null
)
returns public.integration_accounts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.integration_accounts;
  v_row public.integration_accounts;
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id,
       case when p_kind = 'payments' then 'billing.manage' else 'contracts.manage' end) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_kind not in ('payments', 'esign') or p_provider is null or p_provider !~ '^[a-z0-9_]{2,32}$'
     or p_account_id is null or length(btrim(p_account_id)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'kind, provider and account ID are required';
  end if;

  select * into v_before from public.integration_accounts
  where organization_id = p_organization_id and kind = p_kind and provider = p_provider;

  insert into public.integration_accounts (organization_id, kind, provider, account_id, active)
  values (p_organization_id, p_kind, p_provider, btrim(p_account_id), coalesce(p_active, true))
  on conflict (organization_id, kind, provider) do update
    set account_id = excluded.account_id, active = excluded.active
  returning * into v_row;

  perform private.write_audit(p_organization_id, 'integration.configured', 'integration_account', null,
    case when v_before.provider is null then null
         else jsonb_build_object('account_id', v_before.account_id, 'active', v_before.active) end,
    jsonb_build_object('kind', p_kind, 'provider', p_provider, 'account_id', v_row.account_id, 'active', v_row.active),
    null, p_correlation_id);
  return v_row;
end;
$$;

-- Exception queue without amounts or payloads, for operations (PRD §5.9).
create function public.integration_exceptions(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_user();
  if not (private.has_permission(p_organization_id, 'integrations.monitor')
          or private.has_permission(p_organization_id, 'finance.read')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.received_at desc)
    from (
      select 'payment' as kind, e.id, e.provider, e.event_type, e.processing_status, e.error_code, e.received_at,
             e.signature_verified
      from public.payment_events e
      where e.processing_status = 'quarantined'
        and (e.organization_id = p_organization_id or (e.organization_id is null and not e.signature_verified))
      union all
      select 'signature', e.id, e.provider, e.event_type, e.processing_status, e.error_code, e.received_at,
             e.signature_verified
      from public.signature_events e
      where e.processing_status = 'quarantined'
        and (e.organization_id = p_organization_id or (e.organization_id is null and not e.signature_verified))
      order by received_at desc
      limit 100
    ) x
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- RPCs: booking
-- ===========================================================================

create function public.save_booking_host(
  p_organization_id uuid,
  p_user_id uuid,
  p_purposes public.meeting_purpose[],
  p_timezone text,
  p_weekly_hours jsonb,
  p_slot_minutes integer default 30,
  p_min_notice_hours integer default 12,
  p_horizon_days integer default 21,
  p_active boolean default true,
  p_correlation_id text default null
)
returns public.booking_hosts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.booking_hosts;
  v_row public.booking_hosts;
  v_configure boolean;
begin
  perform private.require_correlation_id(p_correlation_id);
  v_configure := private.has_permission(p_organization_id, 'scheduling.configure');

  select * into v_before from public.booking_hosts
  where organization_id = p_organization_id and user_id = p_user_id for update;

  -- Hosts may change their own hours; routing (purposes) is configured centrally.
  if not v_configure and not (
    p_user_id = v_uid and private.is_active_member(p_organization_id)
    and v_before.user_id is not null and v_before.purposes = p_purposes
  ) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'host must be an active member';
  end if;
  perform private.validate_weekly_hours(p_weekly_hours);
  perform private.validate_timezone(p_timezone);

  insert into public.booking_hosts (
    organization_id, user_id, purposes, timezone, weekly_hours, slot_minutes, min_notice_hours, horizon_days, active
  )
  values (p_organization_id, p_user_id, p_purposes, p_timezone, p_weekly_hours, p_slot_minutes, p_min_notice_hours,
          p_horizon_days, coalesce(p_active, true))
  on conflict (organization_id, user_id) do update set
    purposes = excluded.purposes, timezone = excluded.timezone, weekly_hours = excluded.weekly_hours,
    slot_minutes = excluded.slot_minutes, min_notice_hours = excluded.min_notice_hours,
    horizon_days = excluded.horizon_days, active = excluded.active
  returning * into v_row;

  perform private.write_audit(p_organization_id, 'booking_host.saved', 'booking_host', p_user_id,
    case when v_before.user_id is null then null else to_jsonb(v_before) - 'created_at' - 'updated_at' end,
    to_jsonb(v_row) - 'created_at' - 'updated_at', null, p_correlation_id);
  return v_row;
end;
$$;

create function public.booking_options_with_token(
  p_token_hash text,
  p_purpose public.meeting_purpose,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects;
begin
  v_prospect := private.token_prospect(p_token_hash);
  if v_prospect.id is null then
    return jsonb_build_object('state', 'invalid');
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'window must be up to 31 days';
  end if;
  return jsonb_build_object(
    'state', 'valid',
    'slots', private.slots_json(v_prospect.id, p_purpose, p_from, p_to, 200),
    'upcoming', coalesce((
      select jsonb_agg(private.client_meeting_json(m.id) order by m.start_at)
      from public.meetings m
      where m.prospect_id = v_prospect.id and m.status in ('booked', 'rescheduled') and m.end_at > now()), '[]'::jsonb)
  );
end;
$$;

create function public.book_meeting_with_token(
  p_token_hash text,
  p_purpose public.meeting_purpose,
  p_start timestamptz,
  p_timezone text,
  p_note text default null,
  p_idempotency_key text default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects;
  v_proposal_id uuid;
begin
  v_prospect := private.token_prospect(p_token_hash);
  if v_prospect.id is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  select proposal_id into v_proposal_id from public.invitations where token_hash = p_token_hash;
  return private.book_meeting(v_prospect, v_proposal_id, p_purpose, p_start, p_timezone, p_note,
                              p_idempotency_key, 'client', p_correlation_id);
end;
$$;

create function public.request_callback_with_token(
  p_token_hash text,
  p_purpose public.meeting_purpose,
  p_message text default null,
  p_idempotency_key text default null,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects;
begin
  v_prospect := private.token_prospect(p_token_hash);
  -- Unknown or unusable tokens get the same (empty) response.
  if v_prospect.id is null then
    return;
  end if;
  perform private.request_callback(v_prospect, coalesce(p_purpose, 'commercial'), p_message, p_idempotency_key,
                                   p_correlation_id);
end;
$$;

create function public.client_booking_options(
  p_prospect_id uuid,
  p_purpose public.meeting_purpose,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects := private.client_prospect(p_prospect_id);
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'window must be up to 31 days';
  end if;
  return jsonb_build_object(
    'state', 'valid',
    'slots', private.slots_json(v_prospect.id, p_purpose, p_from, p_to, 200),
    'upcoming', '[]'::jsonb
  );
end;
$$;

create function public.client_book_meeting(
  p_prospect_id uuid,
  p_purpose public.meeting_purpose,
  p_start timestamptz,
  p_timezone text,
  p_note text default null,
  p_idempotency_key text default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects := private.client_prospect(p_prospect_id);
begin
  perform private.require_correlation_id(p_correlation_id);
  return private.book_meeting(v_prospect, null, p_purpose, p_start, p_timezone, p_note,
                              p_idempotency_key, 'client', p_correlation_id);
end;
$$;

create function public.client_request_callback(
  p_prospect_id uuid,
  p_purpose public.meeting_purpose,
  p_message text default null,
  p_idempotency_key text default null,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prospect public.prospects := private.client_prospect(p_prospect_id);
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.request_callback(v_prospect, coalesce(p_purpose, 'commercial'), p_message, p_idempotency_key,
                                   p_correlation_id);
end;
$$;

create function public.client_meetings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.client_meeting_json(m.id) order by m.start_at desc), '[]'::jsonb)
  from public.meetings m
  where private.client_has_access(m.prospect_id);
$$;

create function public.client_change_meeting(
  p_meeting_id uuid,
  p_action text,
  p_start timestamptz default null,
  p_reason text default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found or not private.client_has_access(v_meeting.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_action = 'reschedule' then
    return private.reschedule_meeting(v_meeting.id, p_start, p_correlation_id);
  elsif p_action = 'cancel' then
    if v_meeting.status not in ('booked', 'rescheduled') or v_meeting.start_at <= now() then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
        detail = 'only upcoming bookings can be cancelled';
    end if;
    if p_reason is not null and length(p_reason) > 2000 then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'reason is too long';
    end if;
    update public.meetings set status = 'cancelled', cancelled_at = now(), cancel_reason = nullif(btrim(p_reason), '')
    where id = v_meeting.id returning * into v_meeting;
    perform private.record_meeting_event(v_meeting, 'meeting.cancelled',
      jsonb_build_object('reason', p_reason, 'by', 'client'), p_correlation_id);
    update public.prospects set next_action_at = now() where id = v_meeting.prospect_id;
    return jsonb_build_object('status', 'cancelled', 'meeting', private.client_meeting_json(v_meeting.id));
  end if;
  raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown action';
end;
$$;

create function public.update_meeting(
  p_meeting_id uuid,
  p_action text,
  p_start timestamptz default null,
  p_reason text default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_meeting public.meetings;
  v_to public.meeting_status;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_meeting from public.meetings where id = p_meeting_id for update;
  if not found or not private.can_manage_meeting(p_meeting_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if p_action = 'reschedule' then
    return private.reschedule_meeting(v_meeting.id, p_start, p_correlation_id);
  end if;

  v_to := case p_action
    when 'cancel' then 'cancelled'
    when 'complete' then 'completed'
    when 'no_show' then 'no_show'
  end::public.meeting_status;
  if v_to is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown action';
  end if;
  if v_meeting.status not in ('booked', 'rescheduled') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('meeting is %s', v_meeting.status);
  end if;
  if v_to = 'cancelled' then
    perform private.require_reason(p_reason);
  elsif v_meeting.start_at > now() then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'a meeting can only be completed or marked no-show once it has started';
  end if;

  update public.meetings set
    status = v_to,
    cancelled_at = case when v_to = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when v_to = 'cancelled' then p_reason else cancel_reason end,
    completed_at = case when v_to = 'completed' then now() else completed_at end
  where id = v_meeting.id
  returning * into v_meeting;

  perform private.record_meeting_event(v_meeting, 'meeting.' || v_to::text,
    jsonb_build_object('reason', p_reason), p_correlation_id);
  if v_to = 'no_show' then
    perform private.create_ops_task(v_meeting.organization_id, 'meeting_no_show',
      'Follow up after a missed call', null, 'commercial',
      (select owner_user_id from public.prospects where id = v_meeting.prospect_id), v_meeting.prospect_id,
      'meeting', v_meeting.id, 'noshow:' || v_meeting.id);
  end if;
  return jsonb_build_object('status', v_to, 'meeting', private.client_meeting_json(v_meeting.id));
end;
$$;

-- ===========================================================================
-- RPCs: contracts (staff)
-- ===========================================================================

create function public.save_contract_template(
  p_organization_id uuid,
  p_key text,
  p_name text,
  p_body text,
  p_correlation_id text default null
)
returns public.contract_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.contract_templates;
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id, 'contracts.templates') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_key is null or p_key !~ '^[a-z0-9-]{2,64}$' or p_name is null or length(btrim(p_name)) not between 1 and 200
     or p_body is null or length(p_body) not between 50 and 100000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'key, name and body are required';
  end if;
  if not private.template_placeholders_valid(p_body) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'template uses an unknown placeholder';
  end if;

  insert into public.contract_templates (organization_id, key, version, name, body, template_hash, created_by)
  values (
    p_organization_id, p_key,
    coalesce((select max(version) from public.contract_templates where organization_id = p_organization_id and key = p_key), 0) + 1,
    btrim(p_name), p_body, encode(sha256(convert_to(p_body, 'UTF8')), 'hex'), v_uid
  )
  returning * into v_row;

  perform private.write_audit(p_organization_id, 'contract_template.created', 'contract_template', v_row.id, null,
    jsonb_build_object('key', v_row.key, 'version', v_row.version, 'template_hash', v_row.template_hash),
    null, p_correlation_id);
  return v_row;
end;
$$;

create function public.set_contract_template_state(
  p_template_id uuid,
  p_active boolean,
  p_review_status text,
  p_note text default null,
  p_correlation_id text default null
)
returns public.contract_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.contract_templates;
  v_row public.contract_templates;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.contract_templates where id = p_template_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'contracts.templates') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_review_status not in ('pending', 'approved', 'rejected') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown review status';
  end if;
  if p_review_status <> v_before.jurisdiction_review_status then
    perform private.require_reason(p_note);
  end if;
  if p_active and p_review_status = 'rejected' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'a rejected template cannot be active';
  end if;

  if p_active then
    update public.contract_templates set active = false
    where organization_id = v_before.organization_id and key = v_before.key and id <> v_before.id and active;
  end if;
  update public.contract_templates set
    active = p_active,
    jurisdiction_review_status = p_review_status,
    review_note = coalesce(nullif(btrim(p_note), ''), review_note),
    approved_by = case when p_review_status = 'approved' then v_uid else approved_by end,
    approved_at = case when p_review_status = 'approved' then now() else approved_at end
  where id = p_template_id
  returning * into v_row;

  perform private.write_audit(v_row.organization_id, 'contract_template.state_changed', 'contract_template', v_row.id,
    jsonb_build_object('active', v_before.active, 'review', v_before.jurisdiction_review_status),
    jsonb_build_object('active', v_row.active, 'review', v_row.jurisdiction_review_status),
    p_note, p_correlation_id);
  return v_row;
end;
$$;

create function public.generate_contract(
  p_proposal_id uuid,
  p_template_id uuid,
  p_legal jsonb,
  p_countersigner_user_id uuid,
  p_activation_policy jsonb default null,
  p_correlation_id text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_proposal public.proposals;
  v_version public.proposal_versions;
  v_template public.contract_templates;
  v_prospect public.prospects;
  v_signer_email text := lower(btrim(p_legal ->> 'signer_email'));
  v_policy jsonb := p_activation_policy;
  v_schedule_count integer;
  v_amounts bigint[];
  v_document text;
  v_contract public.contracts;
  v_item jsonb;
  v_ord bigint;
begin
  perform private.require_correlation_id(p_correlation_id);

  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found or not private.has_permission(v_proposal.organization_id, 'contracts.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_proposal.status <> 'accepted' or v_proposal.accepted_version_id is null then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'a contract can only be generated from an accepted proposal';
  end if;
  select * into v_version from public.proposal_versions where id = v_proposal.accepted_version_id;
  if v_version.status <> 'accepted' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'accepted version is not accepted';
  end if;

  select * into v_template from public.contract_templates
  where id = p_template_id and organization_id = v_proposal.organization_id;
  if not found or not v_template.active then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'choose an active contract template';
  end if;

  if exists (
    select 1 from public.contracts
    where proposal_version_id = v_version.id and supersedes_contract_id is null
      and status not in ('voided', 'declined', 'expired')
  ) then
    raise exception using errcode = '23505', message = 'CONFLICT', detail = 'an agreement already exists for this version';
  end if;

  if p_legal is null or jsonb_typeof(p_legal) <> 'object'
     or coalesce(length(btrim(p_legal ->> 'client_legal_name')), 0) not between 2 and 200
     or coalesce(length(btrim(p_legal ->> 'client_address')), 0) not between 5 and 500
     or coalesce(length(btrim(p_legal ->> 'signer_name')), 0) not between 2 and 120
     or coalesce(length(p_legal ->> 'client_tax_id'), 0) > 32
     or v_signer_email is null or v_signer_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'legal name, address, signer name and signer email are required';
  end if;

  -- AT-004: the client signer must be able to sign in as a client of this prospect.
  select * into v_prospect from public.prospects where id = v_proposal.prospect_id;
  if v_signer_email is distinct from v_prospect.normalized_email and not exists (
    select 1 from public.client_access ca join auth.users u on u.id = ca.user_id
    where ca.prospect_id = v_prospect.id and ca.status = 'active' and lower(u.email) = v_signer_email
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'the signer must be the invited contact or another client with portal access';
  end if;

  if not exists (
    select 1 from public.organization_memberships m
    join public.role_permissions rp on rp.role = m.role and rp.permission_key = 'contracts.manage' and rp.allowed
    where m.organization_id = v_proposal.organization_id and m.user_id = p_countersigner_user_id and m.status = 'active'
  ) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'the Atmors signer must be an active member who can manage contracts';
  end if;

  v_schedule_count := jsonb_array_length(v_version.payment_schedule);
  v_amounts := private.schedule_amounts(v_version.payment_schedule, v_version.total_minor);
  if v_policy is null then
    -- Default: executed agreement plus the first instalment when it is due up front.
    v_policy := jsonb_build_object(
      'required_contract_state', 'executed',
      'required_payment_items', case
        when v_schedule_count > 0 and v_version.payment_schedule -> 0 ->> 'due' in ('on_acceptance', 'on_signing')
          then '[0]'::jsonb else '[]'::jsonb end,
      'required_onboarding_state', 'not_required',
      'required_manual_review', false
    );
  end if;
  perform private.validate_activation_policy(v_policy, v_schedule_count);

  v_document := private.render_contract(v_template.body, v_version.id, p_legal, null);

  insert into public.contracts (
    organization_id, prospect_id, proposal_id, proposal_version_id, template_id, template_version, template_hash,
    title, client_legal_name, client_address, client_tax_id, signer_name, signer_email, countersigner_user_id,
    currency, total_minor, rendered_document, checksum, activation_policy, created_by
  )
  values (
    v_proposal.organization_id, v_proposal.prospect_id, v_proposal.id, v_version.id, v_template.id,
    v_template.version, v_template.template_hash, v_proposal.title,
    btrim(p_legal ->> 'client_legal_name'), btrim(p_legal ->> 'client_address'),
    nullif(btrim(p_legal ->> 'client_tax_id'), ''), btrim(p_legal ->> 'signer_name'), v_signer_email,
    p_countersigner_user_id, v_version.currency, v_version.total_minor, v_document,
    encode(sha256(convert_to(v_document, 'UTF8')), 'hex'), v_policy, v_uid
  )
  returning * into v_contract;

  insert into public.contract_signers (organization_id, contract_id, role, position, name, email)
  values (v_contract.organization_id, v_contract.id, 'client', 0, v_contract.signer_name, v_contract.signer_email);
  insert into public.contract_signers (organization_id, contract_id, role, position, name, email, user_id)
  select v_contract.organization_id, v_contract.id, 'atmors', 1,
         coalesce(nullif(p.display_name, ''), p.email, 'Atmors'), coalesce(p.email, ''), p.id
  from public.profiles p where p.id = p_countersigner_user_id;

  -- AT-018: materialize the agreement's own payment schedule (version 1).
  for v_item, v_ord in select e, ord from jsonb_array_elements(v_version.payment_schedule) with ordinality as t(e, ord) loop
    insert into public.payment_schedule_items (
      organization_id, contract_id, schedule_version, position, label, due_rule, due_date, milestone,
      amount_minor, currency, activation_relevant
    )
    values (
      v_contract.organization_id, v_contract.id, 1, (v_ord - 1)::integer, btrim(v_item ->> 'label'),
      v_item ->> 'due', nullif(v_item ->> 'due_date', '')::date, nullif(btrim(v_item ->> 'milestone'), ''),
      v_amounts[v_ord::integer], v_contract.currency,
      (v_policy -> 'required_payment_items') @> to_jsonb((v_ord - 1)::integer)
    );
  end loop;

  perform private.write_audit(v_contract.organization_id, 'contract.generated', 'contract', v_contract.id, null,
    jsonb_build_object('proposal_version_id', v_version.id, 'version_number', v_version.version_number,
                       'template_id', v_template.id, 'template_version', v_template.version,
                       'checksum', v_contract.checksum, 'total_minor', v_contract.total_minor,
                       'activation_policy', v_policy),
    null, p_correlation_id);
  perform private.write_event(v_contract.organization_id, 'contract', v_contract.id, 'contract.generated',
    jsonb_build_object('proposal_id', v_proposal.id, 'proposal_version_id', v_version.id, 'checksum', v_contract.checksum),
    'app', p_correlation_id);
  perform private.record_proposal_event(v_proposal, v_version.id, 'proposal.contract_generated',
    jsonb_build_object('contract_id', v_contract.id), p_correlation_id);
  return v_contract;
end;
$$;

create function public.transition_contract(
  p_contract_id uuid,
  p_action text,
  p_reason text default null,
  p_correlation_id text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.contracts;
  v_after public.contracts;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.contracts where id = p_contract_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'contracts.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  if p_action = 'mark_ready' then
    if v_before.status <> 'draft' then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'only drafts can be marked ready';
    end if;
    if encode(sha256(convert_to(v_before.rendered_document, 'UTF8')), 'hex') <> v_before.checksum then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'document checksum mismatch';
    end if;
    update public.contracts set status = 'ready_to_send' where id = p_contract_id returning * into v_after;
  elsif p_action = 'void' then
    perform private.require_reason(p_reason);
    if v_before.status not in ('draft', 'ready_to_send', 'sent', 'viewed', 'partially_signed') then
      raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
        detail = case when v_before.status = 'executed'
          then 'an executed contract cannot be voided in place; create an amendment'
          else format('contract is %s', v_before.status) end;
    end if;
    update public.contracts set status = 'voided', voided_at = now(), void_reason = p_reason
    where id = p_contract_id returning * into v_after;
    update public.payment_schedule_items set status = 'cancelled' where contract_id = p_contract_id and status = 'scheduled';
  else
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown action';
  end if;

  perform private.write_audit(v_after.organization_id, 'contract.' || p_action, 'contract', v_after.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status), p_reason, p_correlation_id);
  perform private.write_event(v_after.organization_id, 'contract', v_after.id, 'contract.' || p_action,
    jsonb_build_object('from', v_before.status, 'to', v_after.status, 'reason', p_reason), 'app', p_correlation_id);
  return v_after;
end;
$$;

-- Called by the server after the e-signature adapter created the envelope.
create function public.record_contract_sent(
  p_contract_id uuid,
  p_provider text,
  p_provider_document_id text,
  p_correlation_id text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.contracts;
  v_after public.contracts;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.contracts where id = p_contract_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'contracts.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.status = 'sent' and v_before.provider = p_provider and v_before.provider_document_id = p_provider_document_id then
    return v_before; -- idempotent retry
  end if;
  if v_before.status <> 'ready_to_send' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'contract is not ready to send';
  end if;
  if not private.integration_enabled(v_before.organization_id, 'esign', p_provider) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'e-signature provider is not enabled';
  end if;
  if p_provider_document_id is null or length(p_provider_document_id) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'provider document ID is required';
  end if;

  update public.contracts set status = 'sent', provider = p_provider, provider_document_id = p_provider_document_id,
    sent_at = now()
  where id = p_contract_id
  returning * into v_after;

  perform private.write_audit(v_after.organization_id, 'contract.sent', 'contract', v_after.id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_after.status, 'provider', p_provider, 'provider_document_id', p_provider_document_id,
                       'checksum', v_after.checksum),
    null, p_correlation_id);
  perform private.write_event(v_after.organization_id, 'contract', v_after.id, 'contract.sent',
    jsonb_build_object('provider', p_provider), 'app', p_correlation_id);
  return v_after;
end;
$$;

-- AT-013: changes to an executed agreement are a new, linked record.
create function public.create_contract_amendment(
  p_contract_id uuid,
  p_reason text,
  p_amendment_text text,
  p_correlation_id text default null
)
returns public.contracts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_original public.contracts;
  v_template public.contract_templates;
  v_document text;
  v_amendment public.contracts;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);
  if p_amendment_text is null or length(btrim(p_amendment_text)) not between 10 and 20000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'describe the amendment (10+ characters)';
  end if;

  select * into v_original from public.contracts where id = p_contract_id for update;
  if not found or not private.has_permission(v_original.organization_id, 'contracts.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_original.status <> 'executed' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'only executed agreements are amended; edit or void a draft instead';
  end if;
  if exists (
    select 1 from public.contracts
    where supersedes_contract_id = v_original.id and status not in ('executed', 'voided', 'declined', 'expired')
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'an amendment is already in progress';
  end if;

  select * into v_template from public.contract_templates where id = v_original.template_id;
  v_document := private.render_contract(v_template.body, v_original.proposal_version_id,
    jsonb_build_object('client_legal_name', v_original.client_legal_name, 'client_address', v_original.client_address,
                       'client_tax_id', v_original.client_tax_id, 'signer_name', v_original.signer_name,
                       'signer_email', v_original.signer_email),
    format(E'This amends the agreement executed on %s (document %s).\nReason: %s\n\n%s',
           to_char((v_original.executed_at at time zone 'Asia/Kolkata')::date, 'DD Mon YYYY'),
           left(v_original.checksum, 16), btrim(p_reason), btrim(p_amendment_text)));

  insert into public.contracts (
    organization_id, prospect_id, proposal_id, proposal_version_id, template_id, template_version, template_hash,
    title, client_legal_name, client_address, client_tax_id, signer_name, signer_email, countersigner_user_id,
    currency, total_minor, rendered_document, checksum, activation_policy, supersedes_contract_id,
    amendment_reason, amendment_text, created_by
  )
  values (
    v_original.organization_id, v_original.prospect_id, v_original.proposal_id, v_original.proposal_version_id,
    v_original.template_id, v_original.template_version, v_original.template_hash,
    'Amendment: ' || left(v_original.title, 180), v_original.client_legal_name, v_original.client_address,
    v_original.client_tax_id, v_original.signer_name, v_original.signer_email, v_original.countersigner_user_id,
    v_original.currency, v_original.total_minor, v_document, encode(sha256(convert_to(v_document, 'UTF8')), 'hex'),
    null, v_original.id, btrim(p_reason), btrim(p_amendment_text), v_uid
  )
  returning * into v_amendment;

  insert into public.contract_signers (organization_id, contract_id, role, position, name, email, user_id)
  select organization_id, v_amendment.id, role, position, name, email, user_id
  from public.contract_signers where contract_id = v_original.id;

  perform private.write_audit(v_amendment.organization_id, 'contract.amendment_created', 'contract', v_amendment.id,
    null, jsonb_build_object('supersedes_contract_id', v_original.id, 'checksum', v_amendment.checksum),
    p_reason, p_correlation_id);
  perform private.write_event(v_amendment.organization_id, 'contract', v_original.id, 'contract.amendment_created',
    jsonb_build_object('amendment_id', v_amendment.id), 'app', p_correlation_id);
  return v_amendment;
end;
$$;

-- The Atmors countersignature step: the named signer, after the client.
create function public.prepare_countersignature(
  p_contract_id uuid,
  p_checksum text,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_contract public.contracts;
  v_signer public.contract_signers;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_contract from public.contracts where id = p_contract_id;
  if not found or not private.has_permission(v_contract.organization_id, 'contracts.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_contract.countersigner_user_id <> v_uid then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'only the named Atmors signer can countersign';
  end if;
  if v_contract.status <> 'partially_signed' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'the client signs first; countersign once their signature is recorded';
  end if;
  if v_contract.checksum <> p_checksum then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;
  select * into v_signer from public.contract_signers where contract_id = v_contract.id and role = 'atmors';
  if v_signer.status <> 'pending' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'already countersigned';
  end if;
  perform private.write_audit(v_contract.organization_id, 'contract.countersignature_started', 'contract',
    v_contract.id, null, jsonb_build_object('checksum', v_contract.checksum), null, p_correlation_id);
  return jsonb_build_object('provider', v_contract.provider, 'provider_document_id', v_contract.provider_document_id,
                            'signer_role', 'atmors', 'signer_email', v_signer.email);
end;
$$;

create function public.evaluate_contract_activation(p_contract_id uuid, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select * into v_contract from public.contracts where id = p_contract_id;
  if not found or not (private.has_permission(v_contract.organization_id, 'contracts.read')
                       or private.has_permission(v_contract.organization_id, 'operations.manage')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_contract.activation_policy is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'amendments have no activation policy';
  end if;
  return private.evaluate_activation(p_contract_id, 'app', p_correlation_id);
end;
$$;

create function public.record_activation_review(
  p_contract_id uuid,
  p_note text,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_contract public.contracts;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_note);
  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found or not (private.has_permission(v_contract.organization_id, 'operations.manage')
                       or private.has_permission(v_contract.organization_id, 'contracts.manage')) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_contract.activation_reviewed_at is null then
    update public.contracts set activation_reviewed_at = now(), activation_reviewed_by = v_uid where id = p_contract_id;
    perform private.write_audit(v_contract.organization_id, 'contract.activation_reviewed', 'contract', v_contract.id,
      null, jsonb_build_object('reviewed_by', v_uid), p_note, p_correlation_id);
  end if;
  return private.evaluate_activation(p_contract_id, 'app', p_correlation_id);
end;
$$;

-- ===========================================================================
-- RPCs: contracts (clients)
-- ===========================================================================

create function public.client_contracts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'title', c.title, 'status', c.status, 'sent_at', c.sent_at, 'executed_at', c.executed_at,
    'is_amendment', c.supersedes_contract_id is not null
  ) order by c.sent_at desc), '[]'::jsonb)
  from public.contracts c
  where c.status not in ('draft', 'ready_to_send')
    and private.client_has_access(c.prospect_id);
$$;

create function public.client_contract_view(p_contract_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts;
begin
  perform private.require_user();
  select * into v_contract from public.contracts where id = p_contract_id for update;
  if not found or v_contract.status in ('draft', 'ready_to_send') or not private.client_has_access(v_contract.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_contract.status = 'sent' then
    update public.contracts set status = 'viewed', first_viewed_at = coalesce(first_viewed_at, now())
    where id = v_contract.id;
    perform private.write_event(v_contract.organization_id, 'contract', v_contract.id, 'contract.viewed', '{}'::jsonb,
                                'app', null);
  end if;
  return private.client_contract_json(v_contract.id) || jsonb_build_object(
    'can_sign',
      v_contract.status in ('sent', 'viewed')
      and exists (select 1 from public.contract_signers s where s.contract_id = v_contract.id and s.role = 'client'
                  and s.status = 'pending' and lower(s.email) = private.current_user_email()),
    'signer_matches_user', lower(v_contract.signer_email) = private.current_user_email()
  );
end;
$$;

-- AT-004: signing needs an authenticated client whose email is the signer's,
-- looking at the exact document (checksum) that will be signed.
create function public.client_prepare_signature(
  p_contract_id uuid,
  p_checksum text,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contract public.contracts;
  v_signer public.contract_signers;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select * into v_contract from public.contracts where id = p_contract_id;
  if not found or v_contract.status in ('draft', 'ready_to_send') or not private.client_has_access(v_contract.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_contract.status not in ('sent', 'viewed') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = format('contract is %s', v_contract.status);
  end if;
  if v_contract.checksum is distinct from p_checksum then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;
  select * into v_signer from public.contract_signers where contract_id = v_contract.id and role = 'client';
  if v_signer.status <> 'pending' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'already signed';
  end if;
  if lower(v_signer.email) is distinct from private.current_user_email() then
    raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'signed-in user is not the named signer';
  end if;
  perform private.write_audit(v_contract.organization_id, 'contract.signature_started', 'contract', v_contract.id,
    null, jsonb_build_object('checksum', v_contract.checksum, 'signer_role', 'client'), null, p_correlation_id);
  return jsonb_build_object('provider', v_contract.provider, 'provider_document_id', v_contract.provider_document_id,
                            'signer_role', 'client', 'signer_email', v_signer.email);
end;
$$;

-- ===========================================================================
-- RPCs: billing (staff)
-- ===========================================================================

create function public.issue_invoice_for_item(
  p_item_id uuid,
  p_due_in_days integer default 7,
  p_allow_partial boolean default false,
  p_correlation_id text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_item public.payment_schedule_items;
  v_contract public.contracts;
  v_invoice public.invoices;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_item from public.payment_schedule_items where id = p_item_id;
  if not found or not private.has_permission(v_item.organization_id, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  select * into v_contract from public.contracts where id = v_item.contract_id;
  if v_contract.status <> 'executed' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'invoices are issued only under an executed agreement';
  end if;
  if p_due_in_days is null or p_due_in_days not between 0 and 90 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'due in 0 to 90 days';
  end if;
  v_invoice := private.issue_invoice(p_item_id, now() + make_interval(days => p_due_in_days), p_correlation_id);
  if p_allow_partial then
    update public.invoices set allow_partial = true where id = v_invoice.id returning * into v_invoice;
  end if;
  return v_invoice;
end;
$$;

create function public.void_invoice(
  p_invoice_id uuid,
  p_reason text,
  p_correlation_id text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.invoices;
  v_after public.invoices;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);
  select * into v_before from public.invoices where id = p_invoice_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.status = 'voided' or exists (
    select 1 from public.payments where invoice_id = p_invoice_id and status in ('succeeded', 'refunded', 'disputed', 'pending')
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'only unpaid invoices without pending payments can be voided';
  end if;
  update public.invoices set status = 'voided', voided_at = now(), void_reason = p_reason
  where id = p_invoice_id returning * into v_after;
  update public.payment_schedule_items set status = 'scheduled' where id = v_after.schedule_item_id and status = 'invoiced';
  perform private.write_audit(v_after.organization_id, 'invoice.voided', 'invoice', v_after.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', 'voided'), p_reason, p_correlation_id);
  perform private.write_event(v_after.organization_id, 'invoice', v_after.id, 'invoice.voided',
    jsonb_build_object('reason', p_reason), 'app', p_correlation_id);
  return v_after;
end;
$$;

-- Approved reconciliation (for example a bank transfer). Visibly marked as
-- manual, with reason and reference; never disguised as provider evidence.
create function public.record_manual_payment(
  p_invoice_id uuid,
  p_amount_minor bigint,
  p_reference text,
  p_reason text,
  p_correlation_id text default null
)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_invoice public.invoices;
  v_payment public.payments;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found or not private.has_permission(v_invoice.organization_id, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_invoice.status not in ('issued', 'partially_paid', 'overdue') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('invoice is %s', v_invoice.status);
  end if;
  if p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > v_invoice.balance_minor then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'amount must be between 1 and the balance';
  end if;
  if p_reference is null or length(btrim(p_reference)) not between 3 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'a bank or receipt reference is required';
  end if;

  insert into public.payments (
    organization_id, invoice_id, provider, idempotency_key, amount_minor, currency, status, manual,
    manual_reason, manual_reference, initiated_by, succeeded_at
  )
  values (
    v_invoice.organization_id, v_invoice.id, 'manual', 'manual:' || p_correlation_id, p_amount_minor, v_invoice.currency,
    'succeeded', true, p_reason, btrim(p_reference), v_uid, now()
  )
  returning * into v_payment;

  v_invoice := private.recompute_invoice(v_invoice.id, p_correlation_id);
  perform private.write_audit(v_invoice.organization_id, 'payment.manual_recorded', 'payment', v_payment.id, null,
    jsonb_build_object('invoice_id', v_invoice.id, 'amount_minor', p_amount_minor, 'reference', btrim(p_reference),
                       'invoice_status', v_invoice.status, 'override', true),
    p_reason, p_correlation_id);
  perform private.write_event(v_invoice.organization_id, 'payment', v_payment.id, 'payment.manual_recorded',
    jsonb_build_object('invoice_id', v_invoice.id, 'override', true), 'app', p_correlation_id);
  perform private.evaluate_activation(v_invoice.contract_id, 'app', p_correlation_id);
  return v_payment;
end;
$$;

create function public.reprocess_payment_event(p_event_id uuid, p_correlation_id text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_event public.payment_events;
  v_org uuid;
  v_status text;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_event from public.payment_events where id = p_event_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  v_org := coalesce(v_event.organization_id,
    (select p.organization_id from public.payments p
     where p.provider = v_event.provider
       and (p.provider_order_id = v_event.data ->> 'provider_order_id'
            or p.provider_payment_id = v_event.data ->> 'provider_payment_id')
     limit 1));
  if v_org is null or not private.has_permission(v_org, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  -- Only verified, quarantined events are replayed; forged ones never are.
  if not v_event.signature_verified or v_event.processing_status <> 'quarantined' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'only verified, quarantined events can be replayed';
  end if;
  v_status := private.process_payment_event(p_event_id);
  perform private.write_audit(v_org, 'payment_event.reprocessed', 'payment_event', p_event_id,
    jsonb_build_object('processing_status', 'quarantined', 'error_code', v_event.error_code),
    jsonb_build_object('processing_status', v_status), null, p_correlation_id);
  return v_status;
end;
$$;

-- Due-date work: issue dated instalments a week ahead and flag overdue
-- invoices with an owner task. Safe to run repeatedly (idempotent).
create function public.run_billing_checks(p_organization_id uuid, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_correlation text := coalesce(p_correlation_id, gen_random_uuid()::text);
  v_item public.payment_schedule_items;
  v_invoice public.invoices;
  v_issued integer := 0;
  v_overdue integer := 0;
begin
  -- Staff need billing.manage; the system worker (service role) has no user.
  if v_uid is not null and not private.has_permission(p_organization_id, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;

  for v_item in
    select i.* from public.payment_schedule_items i
    join public.contracts c on c.id = i.contract_id
    where i.organization_id = p_organization_id and i.status = 'scheduled' and i.due_rule = 'on_date'
      and c.status = 'executed' and i.due_date <= private.today_ist() + 7
  loop
    perform private.issue_invoice(v_item.id, (v_item.due_date + time '23:59:59') at time zone 'Asia/Kolkata', v_correlation);
    v_issued := v_issued + 1;
  end loop;

  for v_invoice in
    select * from public.invoices
    where organization_id = p_organization_id and status in ('issued', 'partially_paid') and due_at < now()
  loop
    perform private.recompute_invoice(v_invoice.id, v_correlation);
    perform private.create_ops_task(p_organization_id, 'invoice_overdue',
      'Invoice ' || coalesce(v_invoice.invoice_number, '') || ' is overdue', null, 'finance', null,
      v_invoice.prospect_id, 'invoice', v_invoice.id, 'overdue:' || v_invoice.id);
    v_overdue := v_overdue + 1;
  end loop;

  return jsonb_build_object('issued', v_issued, 'overdue', v_overdue);
end;
$$;

-- ===========================================================================
-- RPCs: billing (clients)
-- ===========================================================================

create function public.client_invoices()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.client_invoice_json(i.id) - 'payments' order by i.issued_at desc), '[]'::jsonb)
  from public.invoices i
  where i.status <> 'draft' and private.client_has_access(i.prospect_id);
$$;

create function public.client_invoice_view(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prospect_id uuid;
begin
  perform private.require_user();
  select prospect_id into v_prospect_id from public.invoices where id = p_invoice_id and status <> 'draft';
  if v_prospect_id is null or not private.client_has_access(v_prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return private.client_invoice_json(p_invoice_id);
end;
$$;

-- Create a payment attempt for the exact amount; the server then opens the
-- provider order. Payment requires an authenticated client (PRD §11).
create function public.client_start_payment(
  p_invoice_id uuid,
  p_provider text,
  p_amount_minor bigint default null,
  p_idempotency_key text default null,
  p_correlation_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_invoice public.invoices;
  v_payment public.payments;
  v_amount bigint;
begin
  perform private.require_correlation_id(p_correlation_id);
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 128 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'idempotency key is required';
  end if;
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found or v_invoice.status = 'draft' or not private.client_has_access(v_invoice.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;

  select * into v_payment from public.payments where invoice_id = p_invoice_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('payment_id', v_payment.id, 'amount_minor', v_payment.amount_minor,
      'currency', v_payment.currency, 'provider', v_payment.provider, 'status', v_payment.status,
      'provider_order_id', v_payment.provider_order_id, 'replayed', true);
  end if;

  if v_invoice.status not in ('issued', 'partially_paid', 'overdue') or v_invoice.balance_minor <= 0 then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('invoice is %s', v_invoice.status);
  end if;
  if not private.integration_enabled(v_invoice.organization_id, 'payments', p_provider) then
    raise exception using errcode = '55000', message = 'PROVIDER_UNAVAILABLE';
  end if;
  v_amount := coalesce(p_amount_minor, v_invoice.balance_minor);
  if v_amount <= 0 or v_amount > v_invoice.balance_minor
     or (not v_invoice.allow_partial and v_amount <> v_invoice.balance_minor) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'amount must equal the balance unless part payment is allowed';
  end if;

  insert into public.payments (organization_id, invoice_id, provider, idempotency_key, amount_minor, currency, initiated_by)
  values (v_invoice.organization_id, v_invoice.id, p_provider, p_idempotency_key, v_amount, v_invoice.currency, v_uid)
  returning * into v_payment;

  perform private.write_audit(v_invoice.organization_id, 'payment.started', 'payment', v_payment.id, null,
    jsonb_build_object('invoice_id', v_invoice.id, 'amount_minor', v_amount, 'provider', p_provider), null, p_correlation_id);
  return jsonb_build_object('payment_id', v_payment.id, 'amount_minor', v_payment.amount_minor,
    'currency', v_payment.currency, 'provider', v_payment.provider, 'status', v_payment.status,
    'provider_order_id', null, 'replayed', false);
end;
$$;

-- AT-017: the return page reads this; only verified events move it to succeeded.
create function public.client_payment_status(p_payment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_invoice public.invoices;
begin
  perform private.require_user();
  select * into v_payment from public.payments where id = p_payment_id;
  if found then
    select * into v_invoice from public.invoices where id = v_payment.invoice_id;
  end if;
  if v_invoice.id is null or not private.client_has_access(v_invoice.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  return jsonb_build_object(
    'payment_id', v_payment.id, 'status', v_payment.status, 'amount_minor', v_payment.amount_minor,
    'currency', v_payment.currency, 'provider', v_payment.provider, 'provider_order_id', v_payment.provider_order_id,
    'invoice_id', v_invoice.id, 'invoice_number', v_invoice.invoice_number, 'invoice_status', v_invoice.status,
    'balance_minor', v_invoice.balance_minor
  );
end;
$$;

-- ===========================================================================
-- RPCs: system worker (service role only)
-- ===========================================================================

create function public.attach_payment_order(p_payment_id uuid, p_provider_order_id text)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  select * into v_payment from public.payments where id = p_payment_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_payment.provider_order_id = p_provider_order_id then
    return v_payment;
  end if;
  if v_payment.status <> 'created' or v_payment.provider_order_id is not null then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'payment already has an order';
  end if;
  update public.payments set provider_order_id = p_provider_order_id, status = 'pending'
  where id = p_payment_id returning * into v_payment;
  return v_payment;
end;
$$;

create function public.fail_payment_start(p_payment_id uuid, p_error_code text)
returns public.payments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
begin
  update public.payments set status = 'failed', failure_code = left(p_error_code, 64), failed_at = now()
  where id = p_payment_id and status = 'created'
  returning * into v_payment;
  return v_payment;
end;
$$;

-- AT-014/015: record every inbound payment webhook. Unverified events are
-- quarantined without touching business state; verified events are
-- deduplicated on the provider event ID and then applied.
create function public.ingest_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_signature_verified boolean,
  p_payload_hash text,
  p_data jsonb,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,32}$' or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'malformed event envelope';
  end if;

  if not coalesce(p_signature_verified, false) then
    insert into public.payment_events (
      provider, provider_event_id, event_type, signature_verified, payload_hash, data,
      processing_status, error_code, processed_at, correlation_id
    )
    values (p_provider, left(coalesce(p_provider_event_id, 'unverified'), 200), left(coalesce(p_event_type, 'unknown'), 64),
            false, p_payload_hash, '{}'::jsonb, 'quarantined', 'SIGNATURE_INVALID', now(),
            coalesce(p_correlation_id, gen_random_uuid()::text))
    returning id into v_id;
    return jsonb_build_object('event_id', v_id, 'status', 'quarantined', 'error_code', 'SIGNATURE_INVALID');
  end if;

  insert into public.payment_events (
    provider, provider_event_id, event_type, signature_verified, payload_hash, data, correlation_id
  )
  values (p_provider, p_provider_event_id, p_event_type, true, p_payload_hash, coalesce(p_data, '{}'::jsonb),
          coalesce(p_correlation_id, gen_random_uuid()::text))
  on conflict (provider, provider_event_id) where signature_verified do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.payment_events
    where provider = p_provider and provider_event_id = p_provider_event_id and signature_verified;
    return jsonb_build_object('event_id', v_id, 'status', 'duplicate');
  end if;

  v_status := private.process_payment_event(v_id);
  return jsonb_build_object('event_id', v_id, 'status', v_status,
    'error_code', (select error_code from public.payment_events where id = v_id));
end;
$$;

create function public.ingest_signature_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_signature_verified boolean,
  p_payload_hash text,
  p_provider_document_id text,
  p_data jsonb,
  p_occurred_at timestamptz,
  p_correlation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_status text;
begin
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,32}$' or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'malformed event envelope';
  end if;

  if not coalesce(p_signature_verified, false) then
    insert into public.signature_events (
      provider, provider_event_id, event_type, signature_verified, payload_hash, processing_status, error_code,
      processed_at, correlation_id
    )
    values (p_provider, left(coalesce(p_provider_event_id, 'unverified'), 200), left(coalesce(p_event_type, 'unknown'), 64),
            false, p_payload_hash, 'quarantined', 'SIGNATURE_INVALID', now(),
            coalesce(p_correlation_id, gen_random_uuid()::text))
    returning id into v_id;
    return jsonb_build_object('event_id', v_id, 'status', 'quarantined', 'error_code', 'SIGNATURE_INVALID');
  end if;

  insert into public.signature_events (
    provider, provider_event_id, event_type, signature_verified, payload_hash, provider_document_id, data,
    occurred_at, correlation_id
  )
  values (p_provider, p_provider_event_id, p_event_type, true, p_payload_hash, p_provider_document_id,
          coalesce(p_data, '{}'::jsonb), p_occurred_at, coalesce(p_correlation_id, gen_random_uuid()::text))
  on conflict (provider, provider_event_id) where signature_verified do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.signature_events
    where provider = p_provider and provider_event_id = p_provider_event_id and signature_verified;
    return jsonb_build_object('event_id', v_id, 'status', 'duplicate');
  end if;

  v_status := private.process_signature_event(v_id);
  return jsonb_build_object('event_id', v_id, 'status', v_status,
    'error_code', (select error_code from public.signature_events where id = v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

do $$
declare
  v_fn text;
begin
  -- Signed-in staff or clients; each function authorizes the caller itself.
  foreach v_fn in array array[
    'public.complete_ops_task(uuid, text, text, text)',
    'public.configure_integration_account(uuid, text, text, text, boolean, text)',
    'public.integration_exceptions(uuid)',
    'public.save_booking_host(uuid, uuid, public.meeting_purpose[], text, jsonb, integer, integer, integer, boolean, text)',
    'public.client_booking_options(uuid, public.meeting_purpose, timestamptz, timestamptz)',
    'public.client_book_meeting(uuid, public.meeting_purpose, timestamptz, text, text, text, text)',
    'public.client_request_callback(uuid, public.meeting_purpose, text, text, text)',
    'public.client_meetings()',
    'public.client_change_meeting(uuid, text, timestamptz, text, text)',
    'public.update_meeting(uuid, text, timestamptz, text, text)',
    'public.save_contract_template(uuid, text, text, text, text)',
    'public.set_contract_template_state(uuid, boolean, text, text, text)',
    'public.generate_contract(uuid, uuid, jsonb, uuid, jsonb, text)',
    'public.transition_contract(uuid, text, text, text)',
    'public.record_contract_sent(uuid, text, text, text)',
    'public.create_contract_amendment(uuid, text, text, text)',
    'public.prepare_countersignature(uuid, text, text)',
    'public.evaluate_contract_activation(uuid, text)',
    'public.record_activation_review(uuid, text, text)',
    'public.client_contracts()',
    'public.client_contract_view(uuid)',
    'public.client_prepare_signature(uuid, text, text)',
    'public.issue_invoice_for_item(uuid, integer, boolean, text)',
    'public.void_invoice(uuid, text, text)',
    'public.record_manual_payment(uuid, bigint, text, text, text)',
    'public.reprocess_payment_event(uuid, text)',
    'public.client_invoices()',
    'public.client_invoice_view(uuid)',
    'public.client_start_payment(uuid, text, bigint, text, text)',
    'public.client_payment_status(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;

  -- Invitation-token holders (not signed in); the token is the credential.
  foreach v_fn in array array[
    'public.booking_options_with_token(text, public.meeting_purpose, timestamptz, timestamptz)',
    'public.book_meeting_with_token(text, public.meeting_purpose, timestamptz, text, text, text, text)',
    'public.request_callback_with_token(text, public.meeting_purpose, text, text, text)'
  ] loop
    execute format('revoke all on function %s from public', v_fn);
    execute format('grant execute on function %s to anon, authenticated', v_fn);
  end loop;

  -- System worker only: provider events, provider orders and scheduled checks.
  foreach v_fn in array array[
    'public.attach_payment_order(uuid, text)',
    'public.fail_payment_start(uuid, text)',
    'public.ingest_payment_event(text, text, text, boolean, text, jsonb, text)',
    'public.ingest_signature_event(text, text, text, boolean, text, text, jsonb, timestamptz, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

-- Staff run billing checks with billing.manage; the scheduler uses the service role.
revoke all on function public.run_billing_checks(uuid, text) from public, anon;
grant execute on function public.run_billing_checks(uuid, text) to authenticated, service_role;
