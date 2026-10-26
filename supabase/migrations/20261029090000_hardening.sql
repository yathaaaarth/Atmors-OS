-- Phase 6 hardening: idempotent notifications (AT-031), scheduled-job
-- records, shared rate limits for public endpoints, stale-payment and
-- meeting-reminder checks. PRD §13, §15, §16.

-- ---------------------------------------------------------------------------
-- Notifications: an outbox. Business events enqueue with a unique
-- idempotency key, so retries and replays never send twice (AT-031).
-- Messages carry secure portal links, not contract or payment details.
-- ---------------------------------------------------------------------------

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  template_key text not null check (template_key ~ '^[a-z_]{2,64}$'),
  channel text not null default 'email' check (channel in ('email')),
  recipient_email text not null check (length(recipient_email) between 3 and 320),
  related_type text check (length(related_type) <= 64),
  related_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  idempotency_key text not null unique check (length(idempotency_key) between 3 and 300),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  last_error text check (length(last_error) <= 500),
  provider text check (length(provider) <= 40),
  provider_message_id text check (length(provider_message_id) <= 200),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notifications_due_idx on public.notifications (next_attempt_at) where status = 'queued';
create index notifications_org_idx on public.notifications (organization_id, created_at desc);

create trigger notifications_set_updated_at before update on public.notifications
  for each row execute function private.set_updated_at();

create function private.enqueue_notification(
  p_organization_id uuid,
  p_template_key text,
  p_recipient_email text,
  p_related_type text,
  p_related_id uuid,
  p_payload jsonb,
  p_idempotency_key text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recipient_email is null or p_recipient_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return;
  end if;
  insert into public.notifications (organization_id, template_key, recipient_email, related_type, related_id, payload, idempotency_key)
  values (p_organization_id, p_template_key, lower(btrim(p_recipient_email)), p_related_type, p_related_id,
          coalesce(p_payload, '{}'::jsonb), p_idempotency_key)
  on conflict (idempotency_key) do nothing;
end;
$$;

-- The client contact for a prospect: the agreement signer when there is one.
create function private.client_email(p_prospect_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select c.signer_email from public.contracts c
     where c.prospect_id = p_prospect_id and c.supersedes_contract_id is null
       and c.status not in ('voided', 'declined', 'expired')
     order by c.created_at desc limit 1),
    (select p.normalized_email from public.prospects p where p.id = p_prospect_id)
  );
$$;

create function private.notify_contract_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'sent' and old.status is distinct from 'sent' then
    perform private.enqueue_notification(new.organization_id, 'contract_ready', new.signer_email, 'contract', new.id,
      jsonb_build_object('title', new.title, 'path', '/portal/contracts/' || new.id), 'contract_ready:' || new.id);
  elsif new.status = 'executed' and old.status is distinct from 'executed' then
    perform private.enqueue_notification(new.organization_id, 'contract_executed', new.signer_email, 'contract', new.id,
      jsonb_build_object('title', new.title, 'path', '/portal/contracts/' || new.id), 'contract_executed:' || new.id);
  end if;
  return new;
end;
$$;

create trigger contracts_notify after update of status on public.contracts
  for each row execute function private.notify_contract_change();

create function private.notify_invoice_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := private.client_email(new.prospect_id);
  v_payload jsonb := jsonb_build_object('invoice_number', new.invoice_number, 'label', new.label, 'path', '/portal/invoices/' || new.id);
begin
  if tg_op = 'INSERT' and new.status = 'issued' then
    perform private.enqueue_notification(new.organization_id, 'invoice_issued', v_email, 'invoice', new.id, v_payload, 'invoice_issued:' || new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'paid' then
      perform private.enqueue_notification(new.organization_id, 'payment_received', v_email, 'invoice', new.id, v_payload, 'invoice_paid:' || new.id);
    elsif new.status = 'overdue' then
      perform private.enqueue_notification(new.organization_id, 'invoice_overdue', v_email, 'invoice', new.id, v_payload, 'invoice_overdue:' || new.id);
    end if;
  end if;
  return new;
end;
$$;

create trigger invoices_notify after insert or update of status on public.invoices
  for each row execute function private.notify_invoice_change();

create function private.notify_meeting_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := private.client_email(new.prospect_id);
  v_host text;
  v_payload jsonb := jsonb_build_object('purpose', new.purpose, 'start_at', new.start_at, 'end_at', new.end_at, 'timezone', new.timezone, 'path', '/portal');
begin
  select email into v_host from public.profiles where id = new.host_user_id;
  if tg_op = 'INSERT' and new.status = 'booked' then
    perform private.enqueue_notification(new.organization_id, 'meeting_booked', v_email, 'meeting', new.id, v_payload, 'meeting_booked:' || new.id);
    perform private.enqueue_notification(new.organization_id, 'meeting_booked_host', v_host, 'meeting', new.id,
      v_payload || jsonb_build_object('path', '/dashboard/meetings'), 'meeting_booked_host:' || new.id);
  elsif tg_op = 'UPDATE' and new.status = 'rescheduled' and new.rescheduled_count > old.rescheduled_count then
    perform private.enqueue_notification(new.organization_id, 'meeting_rescheduled', v_email, 'meeting', new.id, v_payload,
      'meeting_rescheduled:' || new.id || ':' || new.rescheduled_count);
    perform private.enqueue_notification(new.organization_id, 'meeting_rescheduled', v_host, 'meeting', new.id,
      v_payload || jsonb_build_object('path', '/dashboard/meetings'), 'meeting_rescheduled_host:' || new.id || ':' || new.rescheduled_count);
  elsif tg_op = 'UPDATE' and new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    perform private.enqueue_notification(new.organization_id, 'meeting_cancelled', v_email, 'meeting', new.id, v_payload, 'meeting_cancelled:' || new.id);
    perform private.enqueue_notification(new.organization_id, 'meeting_cancelled', v_host, 'meeting', new.id,
      v_payload || jsonb_build_object('path', '/dashboard/meetings'), 'meeting_cancelled_host:' || new.id);
  end if;
  return new;
end;
$$;

create trigger meetings_notify after insert or update on public.meetings
  for each row execute function private.notify_meeting_change();

create function private.notify_onboarding_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'needs_information' and old.status is distinct from 'needs_information' then
    perform private.enqueue_notification(new.organization_id, 'onboarding_needs_information', private.client_email(new.prospect_id),
      'onboarding', new.id, jsonb_build_object('path', '/portal/onboarding'),
      'onboarding_needs_information:' || new.current_submission_id);
  elsif new.status = 'approved' and old.status is distinct from 'approved' then
    perform private.enqueue_notification(new.organization_id, 'onboarding_approved', private.client_email(new.prospect_id),
      'onboarding', new.id, jsonb_build_object('path', '/portal/onboarding'), 'onboarding_approved:' || new.id);
  end if;
  return new;
end;
$$;

create trigger onboardings_notify after update of status on public.onboardings
  for each row execute function private.notify_onboarding_change();

create function private.notify_workspace_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'active' and old.status is distinct from 'active' then
    perform private.enqueue_notification(new.organization_id, 'workspace_active', private.client_email(new.prospect_id),
      'workspace', new.id, jsonb_build_object('path', '/portal/workspace', 'client_name', new.client_name),
      'workspace_active:' || new.id || ':' || coalesce(new.activated_at::text, ''));
  end if;
  return new;
end;
$$;

create trigger workspaces_notify after update of status on public.workspaces
  for each row execute function private.notify_workspace_change();

-- Proposals: tell clients who already have portal access about a new version.
create function private.notify_proposal_sent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sent_version_id is distinct from old.sent_version_id and new.sent_version_id is not null
     and exists (select 1 from public.client_access ca where ca.prospect_id = new.prospect_id and ca.status = 'active') then
    perform private.enqueue_notification(new.organization_id, 'proposal_ready', private.client_email(new.prospect_id), 'proposal',
      new.id, jsonb_build_object('title', new.title, 'path', '/portal/proposals/' || new.id), 'proposal_ready:' || new.sent_version_id);
  end if;
  return new;
end;
$$;

create trigger proposals_notify after update of sent_version_id on public.proposals
  for each row execute function private.notify_proposal_sent();

-- Dispatcher: claim due messages (skip-locked, so parallel runs never take the same row).
create function public.claim_notifications(p_limit integer default 25)
returns setof public.notifications
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Recover messages whose sender crashed mid-send.
  update public.notifications set status = 'queued'
  where status = 'sending' and claimed_at < now() - interval '10 minutes';

  return query
  update public.notifications n set status = 'sending', attempts = n.attempts + 1, claimed_at = now()
  where n.id in (
    select id from public.notifications
    where status = 'queued' and next_attempt_at <= now()
    order by next_attempt_at
    limit least(greatest(coalesce(p_limit, 25), 1), 100)
    for update skip locked
  )
  returning n.*;
end;
$$;

create function public.complete_notification(
  p_id uuid,
  p_ok boolean,
  p_provider text,
  p_provider_message_id text,
  p_error text
)
returns public.notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.notifications;
begin
  select * into v_row from public.notifications where id = p_id for update;
  if not found or v_row.status <> 'sending' then
    return v_row; -- already completed by another run: never double-send
  end if;
  if p_ok then
    update public.notifications set status = 'sent', sent_at = now(), provider = p_provider,
      provider_message_id = left(p_provider_message_id, 200), last_error = null
    where id = p_id returning * into v_row;
  elsif v_row.attempts >= 5 then
    update public.notifications set status = 'failed', provider = p_provider, last_error = left(p_error, 500)
    where id = p_id returning * into v_row;
    perform private.create_ops_task(v_row.organization_id, 'notification_failed',
      'Email could not be sent: ' || v_row.template_key, left(p_error, 500), 'operations', null, null,
      v_row.related_type, v_row.related_id, 'notification_failed:' || v_row.id);
  else
    -- Bounded exponential backoff with jitter: about 2, 4, 8, 16 minutes.
    update public.notifications set status = 'queued', provider = p_provider, last_error = left(p_error, 500),
      next_attempt_at = now() + make_interval(mins => power(2, v_row.attempts)::integer) + make_interval(secs => floor(random() * 60)::integer)
    where id = p_id returning * into v_row;
  end if;
  return v_row;
end;
$$;

create function public.retry_notification(p_id uuid, p_correlation_id text default null)
returns public.notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.notifications;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_row from public.notifications where id = p_id for update;
  if not found or not private.has_permission(v_row.organization_id, 'operations.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_row.status <> 'failed' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'only failed messages are retried';
  end if;
  update public.notifications set status = 'queued', attempts = 0, next_attempt_at = now() where id = p_id returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'notification.retried', 'notification', v_row.id, null,
    jsonb_build_object('template_key', v_row.template_key), null, p_correlation_id);
  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Scheduled jobs: run log and the periodic checks
-- ---------------------------------------------------------------------------

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  job text not null check (job ~ '^[a-z_]{2,64}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  stats jsonb not null default '{}'::jsonb,
  error text check (length(error) <= 1000)
);

create index job_runs_job_idx on public.job_runs (job, started_at desc);

create function public.record_job_run(p_job text, p_status text, p_stats jsonb, p_error text, p_started_at timestamptz)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.job_runs (job, started_at, finished_at, status, stats, error)
  values (p_job, coalesce(p_started_at, now()), now(), p_status, coalesce(p_stats, '{}'::jsonb), left(p_error, 1000))
  returning id;
$$;

-- Meeting reminders a day ahead, and tasks for payments stuck pending.
create function public.run_periodic_checks()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meeting public.meetings;
  v_payment public.payments;
  v_reminders integer := 0;
  v_stale integer := 0;
  v_host text;
  v_prospect uuid;
begin
  for v_meeting in
    select * from public.meetings
    where status in ('booked', 'rescheduled') and start_at between now() + interval '1 hour' and now() + interval '24 hours'
  loop
    select email into v_host from public.profiles where id = v_meeting.host_user_id;
    perform private.enqueue_notification(v_meeting.organization_id, 'meeting_reminder', private.client_email(v_meeting.prospect_id),
      'meeting', v_meeting.id, jsonb_build_object('purpose', v_meeting.purpose, 'start_at', v_meeting.start_at, 'timezone', v_meeting.timezone, 'path', '/portal'),
      'meeting_reminder:' || v_meeting.id || ':' || v_meeting.start_at);
    perform private.enqueue_notification(v_meeting.organization_id, 'meeting_reminder', v_host, 'meeting', v_meeting.id,
      jsonb_build_object('purpose', v_meeting.purpose, 'start_at', v_meeting.start_at, 'timezone', 'Asia/Kolkata', 'path', '/dashboard/meetings'),
      'meeting_reminder_host:' || v_meeting.id || ':' || v_meeting.start_at);
    v_reminders := v_reminders + 1;
  end loop;

  for v_payment in
    select * from public.payments where status in ('created', 'pending') and created_at < now() - interval '24 hours'
  loop
    select prospect_id into v_prospect from public.invoices where id = v_payment.invoice_id;
    perform private.create_ops_task(v_payment.organization_id, 'stale_payment',
      'Payment still pending after 24 hours: check the provider dashboard', null, 'finance', null, v_prospect,
      'payment', v_payment.id, 'stale_payment:' || v_payment.id);
    v_stale := v_stale + 1;
  end loop;

  delete from public.rate_limits where window_start < now() - interval '2 days';
  return jsonb_build_object('meeting_reminders', v_reminders, 'stale_payments', v_stale);
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared rate limits (fixed window). Works across serverless instances.
-- ---------------------------------------------------------------------------

create table public.rate_limits (
  key text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

create function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (key, window_start, count) values (left(p_key, 200), v_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS and privileges
-- ---------------------------------------------------------------------------

alter table public.notifications enable row level security;
alter table public.job_runs enable row level security;
alter table public.rate_limits enable row level security;
revoke all on public.notifications, public.job_runs, public.rate_limits from anon, authenticated;

grant select on public.notifications to authenticated;
create policy notifications_select on public.notifications
  for select to authenticated using ((select private.has_permission(organization_id, 'operations.manage')));

grant select on public.job_runs to authenticated;
create policy job_runs_select on public.job_runs
  for select to authenticated
  using (exists (
    select 1 from public.organization_memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active'
      and private.has_permission(m.organization_id, 'operations.manage')
  ));
-- rate_limits: no client access at all.

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'public.claim_notifications(integer)',
    'public.complete_notification(uuid, boolean, text, text, text)',
    'public.record_job_run(text, text, jsonb, text, timestamptz)',
    'public.run_periodic_checks()',
    'public.rate_limit_hit(text, integer, integer)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

revoke all on function public.retry_notification(uuid, text) from public, anon;
grant execute on function public.retry_notification(uuid, text) to authenticated;
