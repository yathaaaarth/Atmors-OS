-- Phase 5: Atmors AI. Approved knowledge, conversation and usage logging,
-- proposed-action records with human confirmation, and onboarding AI notes
-- kept apart from client answers. PRD §6; acceptance tests AT-027–AT-030.
--
-- The model never reads tables. The server assembles each request's context
-- from the caller's own authorized views (client projections for clients,
-- RLS-bound queries for staff), so the context cannot contain records the
-- caller could not already see (AT-028). Business actions stay in RPCs and
-- run only after a human confirms them (AT-029).

-- ---------------------------------------------------------------------------
-- Permissions (policy v5)
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, permission_key, policy_version) values
  ('ceo', 'knowledge.manage', 5),
  ('cto_coo', 'knowledge.manage', 5),
  ('ceo', 'ai.monitor', 5),
  ('cto_coo', 'ai.monitor', 5),
  ('ceo', 'ai.copilot', 5),
  ('cto_coo', 'ai.copilot', 5),
  ('sales', 'ai.copilot', 5),
  ('delivery', 'ai.copilot', 5);

-- ---------------------------------------------------------------------------
-- Approved knowledge (FAQ for clients, SOPs for staff)
-- ---------------------------------------------------------------------------

create table public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null check (length(btrim(body)) between 1 and 20000),
  audience text not null check (audience in ('client', 'internal')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  version integer not null default 1 check (version > 0),
  created_by uuid references public.profiles (id) on delete set null,
  approved_by uuid references public.profiles (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index knowledge_documents_org_idx on public.knowledge_documents (organization_id, audience, status);

create trigger knowledge_documents_set_updated_at before update on public.knowledge_documents
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Conversations, messages, proposed actions
-- ---------------------------------------------------------------------------

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  assistant text not null check (assistant in ('sales', 'onboarding', 'copilot')),
  actor_type public.actor_type not null,
  actor_user_id uuid references auth.users (id) on delete set null,
  -- Invitation-holder conversations are keyed by the token hash's prefix, never the token.
  actor_key text not null check (length(actor_key) between 1 and 128),
  prospect_id uuid references public.prospects (id) on delete restrict,
  subject_type text check (subject_type in ('proposal', 'onboarding', 'prospect')),
  subject_id uuid,
  created_at timestamptz not null default now()
);

create index ai_conversations_org_idx on public.ai_conversations (organization_id, created_at desc);
create index ai_conversations_actor_idx on public.ai_conversations (actor_user_id, created_at desc);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid not null references public.ai_conversations (id) on delete restrict,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (length(content) <= 12000),
  grounded boolean,
  -- [{kind, id, title}] of the authorized context items the answer cites.
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  provider text check (length(provider) <= 40),
  model text check (length(model) <= 80),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  latency_ms integer check (latency_ms >= 0),
  finish_reason text check (length(finish_reason) <= 40),
  -- ok | fallback (limitation shown instead) | policy_blocked | error
  validation_status text check (validation_status in ('ok', 'fallback', 'policy_blocked', 'error')),
  policy_flags text[] not null default '{}',
  error_category text check (error_category in ('rate_limited', 'timeout', 'unavailable', 'invalid_request', 'policy_blocked', 'unknown', 'budget_exceeded')),
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  created_at timestamptz not null default now()
);

create index ai_messages_conversation_idx on public.ai_messages (conversation_id, created_at);
create index ai_messages_org_day_idx on public.ai_messages (organization_id, created_at);

create trigger ai_messages_append_only before update or delete on public.ai_messages
  for each row execute function private.reject_mutation();

-- AT-029: the assistant only ever proposes; a person confirms before anything runs.
create table public.ai_tool_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  conversation_id uuid not null references public.ai_conversations (id) on delete restrict,
  tool_name text not null check (tool_name in ('request_human_help', 'propose_task', 'draft_follow_up')),
  proposed_arguments jsonb not null default '{}'::jsonb,
  authorization_result text not null default 'allowed' check (authorization_result in ('allowed', 'denied')),
  human_confirmation text not null default 'pending' check (human_confirmation in ('pending', 'confirmed', 'rejected', 'not_required')),
  confirmed_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz,
  execution_result jsonb,
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  created_at timestamptz not null default now()
);

create index ai_tool_events_conversation_idx on public.ai_tool_events (conversation_id);

create function private.guard_ai_tool_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'APPEND_ONLY';
  end if;
  if (new.organization_id, new.conversation_id, new.tool_name, new.proposed_arguments, new.authorization_result, new.created_at)
     is distinct from (old.organization_id, old.conversation_id, old.tool_name, old.proposed_arguments, old.authorization_result, old.created_at)
     or old.human_confirmation <> 'pending' then
    raise exception using errcode = '42501', message = 'APPEND_ONLY', detail = 'a proposed action is decided once';
  end if;
  return new;
end;
$$;

create trigger ai_tool_events_guard before update or delete on public.ai_tool_events
  for each row execute function private.guard_ai_tool_event();

-- Onboarding strategist output: stored apart from the client's answers (AT-021).
create table public.onboarding_ai_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  onboarding_id uuid not null references public.onboardings (id) on delete restrict,
  submission_id uuid not null references public.onboarding_submissions (id) on delete restrict,
  -- {flags: [{question_key, issue, note}], clarifying_questions: [...], brief: {...}, missing_assets: [...]}
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'used', 'discarded')),
  provider text check (length(provider) <= 40),
  model text check (length(model) <= 80),
  created_by uuid references public.profiles (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index onboarding_ai_notes_onboarding_idx on public.onboarding_ai_notes (onboarding_id, created_at desc);

create trigger onboarding_ai_notes_set_updated_at before update on public.onboarding_ai_notes
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.knowledge_documents enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table public.ai_tool_events enable row level security;
alter table public.onboarding_ai_notes enable row level security;

revoke all on public.knowledge_documents, public.ai_conversations, public.ai_messages, public.ai_tool_events,
  public.onboarding_ai_notes from anon, authenticated;

grant select on public.knowledge_documents to authenticated;
create policy knowledge_documents_select on public.knowledge_documents
  for select to authenticated
  using (
    (select private.has_permission(organization_id, 'knowledge.manage'))
    or (status = 'approved' and (select private.is_active_member(organization_id)))
  );

-- Staff see their own copilot conversations; ai.monitor sees all for review.
grant select on public.ai_conversations to authenticated;
create policy ai_conversations_select on public.ai_conversations
  for select to authenticated
  using (
    (select private.has_permission(organization_id, 'ai.monitor'))
    or (actor_user_id = (select auth.uid()) and (select private.is_active_member(organization_id)))
  );

grant select on public.ai_messages to authenticated;
create policy ai_messages_select on public.ai_messages
  for select to authenticated
  using (exists (
    select 1 from public.ai_conversations c
    where c.id = conversation_id
      and (private.has_permission(c.organization_id, 'ai.monitor')
           or (c.actor_user_id = (select auth.uid()) and private.is_active_member(c.organization_id)))
  ));

grant select on public.ai_tool_events to authenticated;
create policy ai_tool_events_select on public.ai_tool_events
  for select to authenticated
  using (exists (
    select 1 from public.ai_conversations c
    where c.id = conversation_id
      and (private.has_permission(c.organization_id, 'ai.monitor')
           or (c.actor_user_id = (select auth.uid()) and private.is_active_member(c.organization_id)))
  ));

grant select on public.onboarding_ai_notes to authenticated;
create policy onboarding_ai_notes_select on public.onboarding_ai_notes
  for select to authenticated
  using ((select private.has_permission(organization_id, 'onboarding.manage')));

revoke update, delete, truncate on public.ai_messages from service_role;

-- ===========================================================================
-- RPCs: knowledge
-- ===========================================================================

create function public.save_knowledge_document(
  p_organization_id uuid,
  p_id uuid,
  p_title text,
  p_body text,
  p_audience text,
  p_correlation_id text default null
)
returns public.knowledge_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.knowledge_documents;
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id, 'knowledge.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_audience not in ('client', 'internal') or coalesce(length(btrim(p_title)), 0) not between 1 and 200
     or coalesce(length(btrim(p_body)), 0) not between 1 and 20000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'title, body and audience are required';
  end if;
  if p_id is null then
    insert into public.knowledge_documents (organization_id, title, body, audience, created_by)
    values (p_organization_id, btrim(p_title), btrim(p_body), p_audience, v_uid)
    returning * into v_row;
  else
    -- Editing approved knowledge sends it back for approval as a new version.
    update public.knowledge_documents set
      title = btrim(p_title), body = btrim(p_body), audience = p_audience,
      status = 'draft', version = version + 1, approved_by = null, approved_at = null
    where id = p_id and organization_id = p_organization_id
    returning * into v_row;
    if v_row.id is null then
      raise exception using errcode = '42501', message = 'FORBIDDEN';
    end if;
  end if;
  perform private.write_audit(p_organization_id, 'knowledge.saved', 'knowledge_document', v_row.id, null,
    jsonb_build_object('title', v_row.title, 'audience', v_row.audience, 'version', v_row.version), null, p_correlation_id);
  return v_row;
end;
$$;

create function public.set_knowledge_status(p_id uuid, p_status text, p_correlation_id text default null)
returns public.knowledge_documents
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.knowledge_documents;
  v_row public.knowledge_documents;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.knowledge_documents where id = p_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'knowledge.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_status not in ('approved', 'retired', 'draft') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'unknown status';
  end if;
  update public.knowledge_documents set
    status = p_status,
    approved_by = case when p_status = 'approved' then v_uid else approved_by end,
    approved_at = case when p_status = 'approved' then now() else approved_at end
  where id = p_id returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'knowledge.' || p_status, 'knowledge_document', v_row.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_row.status), null, p_correlation_id);
  return v_row;
end;
$$;

-- Approved client-facing knowledge for the caller's own organization only:
-- invitation holders by token, signed-in clients through client_access.
create function public.client_knowledge(p_token_hash text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_prospect public.prospects;
begin
  if p_token_hash is not null then
    v_prospect := private.token_prospect(p_token_hash);
    v_org := v_prospect.organization_id;
  elsif (select auth.uid()) is not null then
    select p.organization_id into v_org from public.client_access ca
    join public.prospects p on p.id = ca.prospect_id
    where ca.user_id = (select auth.uid()) and ca.status = 'active'
    order by ca.created_at limit 1;
  end if;
  if v_org is null then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'body', k.body) order by k.title)
    from public.knowledge_documents k
    where k.organization_id = v_org and k.audience = 'client' and k.status = 'approved'
  ), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- RPCs: logging, usage and budgets (system worker)
-- ===========================================================================

-- Records one exchange. The server has already authorized the caller and
-- built the context; this only persists what happened, including failures.
create function public.ai_record_exchange(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation uuid := nullif(p_payload ->> 'conversation_id', '')::uuid;
  v_org uuid := (p_payload ->> 'organization_id')::uuid;
  v_correlation text := coalesce(p_payload ->> 'correlation_id', gen_random_uuid()::text);
  v_action jsonb;
  v_action_ids jsonb := '[]'::jsonb;
  v_action_id uuid;
begin
  if v_org is null or p_payload ->> 'assistant' not in ('sales', 'onboarding', 'copilot') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'organization and assistant are required';
  end if;
  if v_conversation is not null and not exists (
    select 1 from public.ai_conversations
    where id = v_conversation and organization_id = v_org and actor_key = p_payload ->> 'actor_key'
  ) then
    v_conversation := null; -- never continue someone else's conversation
  end if;
  if v_conversation is null then
    insert into public.ai_conversations (organization_id, assistant, actor_type, actor_user_id, actor_key, prospect_id, subject_type, subject_id)
    values (v_org, p_payload ->> 'assistant', (p_payload ->> 'actor_type')::public.actor_type,
            nullif(p_payload ->> 'actor_user_id', '')::uuid, p_payload ->> 'actor_key',
            nullif(p_payload ->> 'prospect_id', '')::uuid, nullif(p_payload ->> 'subject_type', ''),
            nullif(p_payload ->> 'subject_id', '')::uuid)
    returning id into v_conversation;
  end if;

  insert into public.ai_messages (organization_id, conversation_id, role, content, correlation_id)
  values (v_org, v_conversation, 'user', left(coalesce(p_payload ->> 'question', ''), 12000), v_correlation);

  insert into public.ai_messages (
    organization_id, conversation_id, role, content, grounded, sources, provider, model, input_tokens,
    output_tokens, latency_ms, finish_reason, validation_status, policy_flags, error_category, correlation_id
  )
  values (
    v_org, v_conversation, 'assistant', left(coalesce(p_payload ->> 'answer', ''), 12000),
    (p_payload ->> 'grounded')::boolean, coalesce(p_payload -> 'sources', '[]'::jsonb),
    p_payload ->> 'provider', p_payload ->> 'model', (p_payload ->> 'input_tokens')::integer,
    (p_payload ->> 'output_tokens')::integer, (p_payload ->> 'latency_ms')::integer, p_payload ->> 'finish_reason',
    p_payload ->> 'validation_status',
    coalesce(array(select jsonb_array_elements_text(p_payload -> 'policy_flags')), '{}'),
    nullif(p_payload ->> 'error_category', ''), v_correlation
  );

  for v_action in select * from jsonb_array_elements(coalesce(p_payload -> 'actions', '[]'::jsonb)) loop
    insert into public.ai_tool_events (organization_id, conversation_id, tool_name, proposed_arguments, authorization_result,
                                       human_confirmation, correlation_id)
    values (v_org, v_conversation, v_action ->> 'tool_name', coalesce(v_action -> 'arguments', '{}'::jsonb),
            coalesce(v_action ->> 'authorization_result', 'allowed'),
            case when v_action ->> 'tool_name' = 'draft_follow_up' then 'not_required' else 'pending' end, v_correlation)
    returning id into v_action_id;
    v_action_ids := v_action_ids || to_jsonb(v_action_id);
  end loop;

  return jsonb_build_object('conversation_id', v_conversation, 'action_ids', v_action_ids);
end;
$$;

create function public.ai_usage_today(p_organization_id uuid, p_actor_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'org_tokens', coalesce((
      select sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0))
      from public.ai_messages m
      where m.organization_id = p_organization_id and m.role = 'assistant'
        and m.created_at >= (private.today_ist()::timestamp at time zone 'Asia/Kolkata')), 0),
    'actor_messages', coalesce((
      select count(*)
      from public.ai_messages m join public.ai_conversations c on c.id = m.conversation_id
      where c.organization_id = p_organization_id and c.actor_key = p_actor_key and m.role = 'user'
        and m.created_at >= (private.today_ist()::timestamp at time zone 'Asia/Kolkata')), 0)
  );
$$;

-- Marks a proposed action decided. Business effects run in their own RPCs,
-- called by the server as the confirming user, before this is recorded.
create function public.ai_resolve_action(p_event_id uuid, p_actor_key text, p_decision text, p_result jsonb, p_confirmed_by uuid)
returns public.ai_tool_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.ai_tool_events;
begin
  select e.* into v_event from public.ai_tool_events e
  join public.ai_conversations c on c.id = e.conversation_id
  where e.id = p_event_id and c.actor_key = p_actor_key
  for update of e;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_event.human_confirmation <> 'pending' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'already decided';
  end if;
  if p_decision not in ('confirmed', 'rejected') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'decision must be confirmed or rejected';
  end if;
  update public.ai_tool_events set human_confirmation = p_decision, confirmed_by = p_confirmed_by, confirmed_at = now(),
    execution_result = p_result
  where id = p_event_id returning * into v_event;
  perform private.write_audit(v_event.organization_id, 'ai.action_' || p_decision, 'ai_tool_event', v_event.id, null,
    jsonb_build_object('tool_name', v_event.tool_name, 'result', p_result), null, v_event.correlation_id);
  return v_event;
end;
$$;

-- ===========================================================================
-- RPCs: staff-side AI effects (run as the confirming user)
-- ===========================================================================

-- Copilot-proposed internal task, created only after the member confirms and
-- only for a prospect they can read (permissions re-checked at confirmation).
create function public.create_ops_task_for_prospect(
  p_prospect_id uuid,
  p_title text,
  p_detail text,
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
  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found or not private.can_read_prospect(p_prospect_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if coalesce(length(btrim(p_title)), 0) not between 3 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'task title is required';
  end if;
  v_id := private.create_ops_task(v_prospect.organization_id, 'follow_up', btrim(p_title), left(p_detail, 4000),
    'commercial', v_uid, v_prospect.id, 'prospect', v_prospect.id, null);
  perform private.write_audit(v_prospect.organization_id, 'ops_task.created', 'ops_task', v_id, null,
    jsonb_build_object('title', btrim(p_title), 'source', 'copilot_confirmed'), null, p_correlation_id);
  return v_id;
end;
$$;

create function public.save_onboarding_ai_note(
  p_onboarding_id uuid,
  p_submission_id uuid,
  p_content jsonb,
  p_provider text,
  p_model text,
  p_correlation_id text default null
)
returns public.onboarding_ai_notes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_onboarding public.onboardings;
  v_row public.onboarding_ai_notes;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_onboarding from public.onboardings where id = p_onboarding_id;
  if not found or not private.has_permission(v_onboarding.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if not exists (select 1 from public.onboarding_submissions where id = p_submission_id and onboarding_id = p_onboarding_id) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'submission does not belong to this onboarding';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' or length(p_content::text) > 60000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'content must be an object';
  end if;
  insert into public.onboarding_ai_notes (organization_id, onboarding_id, submission_id, content, provider, model, created_by)
  values (v_onboarding.organization_id, p_onboarding_id, p_submission_id, p_content, left(p_provider, 40), left(p_model, 80), v_uid)
  returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'onboarding.ai_note_created', 'onboarding', p_onboarding_id, null,
    jsonb_build_object('note_id', v_row.id, 'submission_id', p_submission_id, 'provider', p_provider), null, p_correlation_id);
  return v_row;
end;
$$;

create function public.set_onboarding_ai_note_status(p_note_id uuid, p_status text, p_correlation_id text default null)
returns public.onboarding_ai_notes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.onboarding_ai_notes;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_row from public.onboarding_ai_notes where id = p_note_id for update;
  if not found or not private.has_permission(v_row.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_status not in ('used', 'discarded') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'status must be used or discarded';
  end if;
  update public.onboarding_ai_notes set status = p_status, reviewed_by = v_uid where id = p_note_id returning * into v_row;
  return v_row;
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
    'public.save_knowledge_document(uuid, uuid, text, text, text, text)',
    'public.set_knowledge_status(uuid, text, text)',
    'public.create_ops_task_for_prospect(uuid, text, text, text)',
    'public.save_onboarding_ai_note(uuid, uuid, jsonb, text, text, text)',
    'public.set_onboarding_ai_note_status(uuid, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
  foreach v_fn in array array[
    'public.ai_record_exchange(jsonb)',
    'public.ai_usage_today(uuid, text)',
    'public.ai_resolve_action(uuid, text, text, jsonb, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;

revoke all on function public.client_knowledge(text) from public;
grant execute on function public.client_knowledge(text) to anon, authenticated;
