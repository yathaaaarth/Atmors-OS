-- Phase 4: onboarding questionnaires, submission revisions and review, private
-- client assets, access-grant tracking, client workspaces with activation,
-- milestones, delivery tasks and assignment-based least privilege.
-- PRD §4, §5.7, §5.8, §8; acceptance tests AT-021–AT-026.
--
-- Conventions follow Phases 2-3: staff read through RLS, every write is an
-- audited SECURITY DEFINER RPC, clients only see client-safe JSON projections.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.onboarding_status as enum (
  'not_started', 'in_progress', 'submitted', 'needs_information', 'resubmitted', 'approved'
);
create type public.workspace_status as enum ('blocked', 'eligible', 'active', 'suspended', 'closed');
create type public.delivery_status as enum ('not_ready', 'kickoff_ready', 'in_progress', 'paused', 'completed');
create type public.task_status as enum ('todo', 'in_progress', 'blocked', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');
create type public.access_grant_status as enum ('requested', 'client_confirmed', 'verified', 'declined', 'revoked');

-- ---------------------------------------------------------------------------
-- Permissions (policy v4)
-- ---------------------------------------------------------------------------

insert into public.role_permissions (role, permission_key, policy_version) values
  ('cto_coo', 'onboarding.manage', 4),
  ('cto_coo', 'workspaces.read_all', 4),
  ('cto_coo', 'workspaces.manage', 4),
  ('cto_coo', 'workspaces.override', 4),
  ('ceo', 'onboarding.manage', 4),
  ('ceo', 'workspaces.read_all', 4);

-- ---------------------------------------------------------------------------
-- Questionnaire templates (versioned, immutable)
-- ---------------------------------------------------------------------------

create table public.questionnaire_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  key text not null check (key ~ '^[a-z0-9-]{2,64}$'),
  version integer not null check (version > 0),
  name text not null check (length(btrim(name)) between 1 and 200),
  -- [{key, label, help?, type, required, options?, max_length?, show_if?: {question, equals}}]
  questions jsonb not null check (jsonb_typeof(questions) = 'array'),
  active boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, key, version)
);

create unique index questionnaire_templates_one_active on public.questionnaire_templates (organization_id, key) where active;

create function private.guard_questionnaire_template()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'templates are never deleted';
  end if;
  if (new.organization_id, new.key, new.version, new.questions, new.name)
     is distinct from (old.organization_id, old.key, old.version, old.questions, old.name) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'questionnaire versions are immutable; save a new version';
  end if;
  return new;
end;
$$;

create trigger questionnaire_templates_guard before update or delete on public.questionnaire_templates
  for each row execute function private.guard_questionnaire_template();

create function private.validate_questionnaire(p_questions jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_question jsonb;
  v_keys text[] := '{}';
  v_key text;
  v_type text;
begin
  if p_questions is null or jsonb_typeof(p_questions) <> 'array' or jsonb_array_length(p_questions) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'a questionnaire needs 1 to 100 questions';
  end if;
  for v_question in select * from jsonb_array_elements(p_questions) loop
    v_key := v_question ->> 'key';
    v_type := v_question ->> 'type';
    if jsonb_typeof(v_question) <> 'object'
       or coalesce(v_key, '') !~ '^[a-z][a-z0-9_]{0,63}$'
       or v_key = any (v_keys)
       or coalesce(length(btrim(v_question ->> 'label')), 0) not between 1 and 300
       or coalesce(v_type, '') not in ('text', 'long_text', 'url', 'email', 'number', 'boolean', 'date', 'single_choice', 'multi_choice')
       or jsonb_typeof(v_question -> 'required') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('question %s needs a unique key, label, known type and required flag', coalesce(v_key, '?'));
    end if;
    if v_type in ('single_choice', 'multi_choice') and (
         jsonb_typeof(v_question -> 'options') is distinct from 'array'
         or jsonb_array_length(v_question -> 'options') not between 1 and 50) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('question %s needs 1 to 50 options', v_key);
    end if;
    -- Follow-ups may depend only on an earlier question.
    if v_question ? 'show_if' and not ((v_question -> 'show_if' ->> 'question') = any (v_keys)) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
        detail = format('question %s depends on an unknown or later question', v_key);
    end if;
    v_keys := array_append(v_keys, v_key);
  end loop;
end;
$$;

create function private.question_visible(p_question jsonb, p_answers jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when not (p_question ? 'show_if') then true
    when jsonb_typeof(p_answers -> (p_question -> 'show_if' ->> 'question')) = 'array'
      then (p_answers -> (p_question -> 'show_if' ->> 'question')) @> jsonb_build_array(p_question -> 'show_if' -> 'equals')
    else (p_answers -> (p_question -> 'show_if' ->> 'question')) = (p_question -> 'show_if' -> 'equals')
  end;
$$;

-- Keep only answers to known, currently visible questions, type-checked.
-- With p_final, every visible required question must be answered.
create function private.clean_answers(p_questions jsonb, p_answers jsonb, p_final boolean)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_question jsonb;
  v_key text;
  v_type text;
  v_value jsonb;
  v_clean jsonb := '{}'::jsonb;
  v_text text;
  v_max integer;
  v_missing text[] := '{}';
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'answers must be an object';
  end if;
  for v_question in select * from jsonb_array_elements(p_questions) loop
    v_key := v_question ->> 'key';
    v_type := v_question ->> 'type';
    v_value := p_answers -> v_key;
    if not private.question_visible(v_question, v_clean) then
      continue; -- hidden follow-ups are dropped, never stored
    end if;
    if v_value is null or v_value = 'null'::jsonb or v_value = '""'::jsonb or v_value = '[]'::jsonb then
      if p_final and (v_question ->> 'required')::boolean then
        v_missing := array_append(v_missing, v_key);
      end if;
      continue;
    end if;

    v_max := coalesce((v_question ->> 'max_length')::integer, case when v_type = 'long_text' then 10000 else 2000 end);
    if v_type in ('text', 'long_text', 'url', 'email', 'date', 'single_choice') then
      if jsonb_typeof(v_value) <> 'string' then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = format('%s must be text', v_key);
      end if;
      v_text := btrim(v_value #>> '{}');
      if length(v_text) > v_max
         or (v_type = 'url' and v_text !~* '^https?://[^\s]+$')
         or (v_type = 'email' and v_text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
         or (v_type = 'date' and v_text !~ '^\d{4}-\d{2}-\d{2}$')
         or (v_type = 'single_choice' and not ((v_question -> 'options') @> jsonb_build_array(v_text))) then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = format('%s is not a valid %s', v_key, v_type);
      end if;
      v_value := to_jsonb(v_text);
    elsif v_type = 'number' then
      if jsonb_typeof(v_value) <> 'number' then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = format('%s must be a number', v_key);
      end if;
    elsif v_type = 'boolean' then
      if jsonb_typeof(v_value) <> 'boolean' then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = format('%s must be yes or no', v_key);
      end if;
    elsif v_type = 'multi_choice' then
      if jsonb_typeof(v_value) <> 'array' or not ((v_question -> 'options') @> v_value) then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = format('%s has an unknown option', v_key);
      end if;
    end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_value);
  end loop;

  if cardinality(v_missing) > 0 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'required: ' || array_to_string(v_missing, ', ');
  end if;
  return v_clean;
end;
$$;

create function private.default_questionnaire()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select $q$[
    {"key": "business_name", "label": "Business or brand name", "type": "text", "required": true},
    {"key": "website", "label": "Website", "type": "url", "required": false, "help": "Starting with https://"},
    {"key": "offer_summary", "label": "What do you sell, and to whom?", "type": "long_text", "required": true},
    {"key": "target_audience", "label": "Who is your ideal customer? Role, industry, company size, region.", "type": "long_text", "required": true},
    {"key": "goals", "label": "What should this engagement achieve in the first 90 days?", "type": "long_text", "required": true},
    {"key": "channels", "label": "Which channels are in scope?", "type": "multi_choice", "required": true, "options": ["LinkedIn personal profile", "LinkedIn company page", "Newsletter", "Website blog"]},
    {"key": "has_brand_guide", "label": "Do you have brand or tone-of-voice guidelines?", "type": "boolean", "required": true},
    {"key": "brand_guide_notes", "label": "Please upload them below, or describe where to find them.", "type": "long_text", "required": false, "show_if": {"question": "has_brand_guide", "equals": true}},
    {"key": "voice", "label": "Describe your voice in a few words (for example: direct, warm, technical).", "type": "text", "required": true},
    {"key": "competitors", "label": "Competitors or peers you admire or want to stand apart from", "type": "long_text", "required": false},
    {"key": "approver_email", "label": "Who approves content before it goes live? (email)", "type": "email", "required": true},
    {"key": "anything_else", "label": "Anything else we should know?", "type": "long_text", "required": false}
  ]$q$::jsonb;
$$;

-- ---------------------------------------------------------------------------
-- Onboarding: one per client, immutable submission revisions
-- ---------------------------------------------------------------------------

create table public.onboardings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null unique references public.prospects (id) on delete restrict,
  template_id uuid not null references public.questionnaire_templates (id) on delete restrict,
  status public.onboarding_status not null default 'not_started',
  -- The client's unsaved-to-revision work in progress; the only mutable answers.
  draft_answers jsonb not null default '{}'::jsonb check (jsonb_typeof(draft_answers) = 'object'),
  current_submission_id uuid,
  -- Latest "needs information" request: [{question_key?, message}]
  info_requests jsonb not null default '[]'::jsonb check (jsonb_typeof(info_requests) = 'array'),
  approved_at timestamptz,
  approved_by uuid references public.profiles (id) on delete set null,
  started_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index onboardings_org_status_idx on public.onboardings (organization_id, status);

create trigger onboardings_set_updated_at before update on public.onboardings
  for each row execute function private.set_updated_at();

create table public.onboarding_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  onboarding_id uuid not null references public.onboardings (id) on delete restrict,
  template_id uuid not null references public.questionnaire_templates (id) on delete restrict,
  revision integer not null check (revision > 0),
  supersedes_submission_id uuid references public.onboarding_submissions (id) on delete restrict,
  submitted_by uuid references auth.users (id) on delete set null,
  submitted_at timestamptz not null default now(),
  answers_hash text not null check (answers_hash ~ '^[0-9a-f]{64}$'),
  unique (onboarding_id, revision)
);

alter table public.onboardings
  add constraint onboardings_current_submission_fkey
    foreign key (current_submission_id) references public.onboarding_submissions (id) on delete restrict;

create table public.onboarding_answers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  submission_id uuid not null references public.onboarding_submissions (id) on delete restrict,
  question_key text not null check (question_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  answer_json jsonb not null,
  -- Who supplied it. AI interpretations live elsewhere and never here (AT-021).
  answer_source text not null default 'client' check (answer_source in ('client')),
  created_at timestamptz not null default now(),
  unique (submission_id, question_key)
);

create table public.onboarding_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  onboarding_id uuid not null references public.onboardings (id) on delete restrict,
  submission_id uuid not null references public.onboarding_submissions (id) on delete restrict,
  decision text not null check (decision in ('approved', 'needs_information')),
  reasons jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  reviewer_id uuid references public.profiles (id) on delete set null,
  correlation_id text not null check (length(correlation_id) between 1 and 128),
  created_at timestamptz not null default now()
);

create index onboarding_reviews_onboarding_idx on public.onboarding_reviews (onboarding_id, created_at);

-- Submissions, answers and reviews are history: append-only (AT-021).
create trigger onboarding_submissions_append_only before update or delete on public.onboarding_submissions
  for each row execute function private.reject_mutation();
create trigger onboarding_answers_append_only before update or delete on public.onboarding_answers
  for each row execute function private.reject_mutation();
create trigger onboarding_reviews_append_only before update or delete on public.onboarding_reviews
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------
-- Private client assets (metadata; bytes live in a private storage bucket)
-- ---------------------------------------------------------------------------

create table public.client_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  onboarding_id uuid references public.onboardings (id) on delete restrict,
  storage_key text not null unique check (length(storage_key) between 1 and 500 and storage_key !~ '\.\.'),
  filename text not null check (length(filename) between 1 and 200),
  content_type text not null check (length(content_type) <= 120),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  -- No malware scanner is wired yet; content is validated by type signature.
  scan_status text not null default 'not_scanned' check (scan_status in ('not_scanned', 'clean', 'rejected')),
  status text not null default 'pending' check (status in ('pending', 'ready', 'rejected', 'removed')),
  access_class text not null default 'client_confidential' check (access_class in ('client_confidential')),
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index client_assets_prospect_idx on public.client_assets (prospect_id, created_at desc);

create trigger client_assets_set_updated_at before update on public.client_assets
  for each row execute function private.set_updated_at();

-- The bucket is private and has no storage policies: only the server's
-- system identity reads or writes objects, after an authorization RPC.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('client-assets', 'client-assets', false, 10485760, array[
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ])
    on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access grants (never passwords; PRD §5.7, §11)
-- ---------------------------------------------------------------------------

create table public.access_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null references public.prospects (id) on delete restrict,
  platform text not null check (length(btrim(platform)) between 1 and 120),
  requested_scope text not null check (length(btrim(requested_scope)) between 1 and 500),
  instructions text check (length(instructions) <= 4000),
  owner_user_id uuid references public.profiles (id) on delete set null,
  status public.access_grant_status not null default 'requested',
  client_note text check (length(client_note) <= 2000),
  granted_at timestamptz,
  verified_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index access_grants_prospect_idx on public.access_grants (prospect_id);

create trigger access_grants_set_updated_at before update on public.access_grants
  for each row execute function private.set_updated_at();

-- Refuse text that looks like a credential being handed over.
create function private.reject_credentials(p_text text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_text ~* '(pass(word|wd|code)?|pwd|otp|2fa code)\s*[:=]' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED',
      detail = 'never share passwords here; grant access through the platform instead';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspaces, members, milestones, tasks and updates
-- ---------------------------------------------------------------------------

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  prospect_id uuid not null unique references public.prospects (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  -- Display name, so delivery staff need no access to the CRM record.
  client_name text not null check (length(btrim(client_name)) between 1 and 200),
  status public.workspace_status not null default 'blocked',
  blocked_reasons text[] not null default '{}',
  activation_policy_version integer not null default 1,
  eligible_at timestamptz,
  activated_at timestamptz,
  -- AT-026: a manual activation is permitted, reasoned, audited and visibly marked.
  override_active boolean not null default false,
  override_reason text check (length(override_reason) <= 2000),
  override_by uuid references public.profiles (id) on delete set null,
  override_at timestamptz,
  status_reason text check (length(status_reason) <= 2000),
  delivery_status public.delivery_status not null default 'not_ready',
  kickoff_blockers text[] not null default '{}',
  kickoff_ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not override_active or (override_reason is not null and override_by is not null))
);

create index workspaces_org_status_idx on public.workspaces (organization_id, status);

create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function private.set_updated_at();

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  role text not null default 'member' check (role in ('lead', 'member')),
  added_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

create unique index workspace_members_one_lead on public.workspace_members (workspace_id) where role = 'lead';
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  due_at timestamptz,
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'done', 'cancelled')),
  client_visible boolean not null default true,
  position integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index milestones_workspace_idx on public.milestones (workspace_id, position);

create trigger milestones_set_updated_at before update on public.milestones
  for each row execute function private.set_updated_at();

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  milestone_id uuid references public.milestones (id) on delete restrict,
  title text not null check (length(btrim(title)) between 1 and 200),
  description text check (length(description) <= 4000),
  internal_notes text check (length(internal_notes) <= 4000),
  owner_user_id uuid references public.profiles (id) on delete set null,
  due_at timestamptz,
  status public.task_status not null default 'todo',
  priority public.task_priority not null default 'normal',
  client_visible boolean not null default false,
  dependency_id uuid references public.tasks (id) on delete restrict,
  completion_evidence text check (length(completion_evidence) <= 2000),
  completed_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (dependency_id is distinct from id)
);

create index tasks_workspace_idx on public.tasks (workspace_id, status);
create index tasks_owner_idx on public.tasks (owner_user_id, due_at) where status not in ('done', 'cancelled');

create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function private.set_updated_at();

create table public.workspace_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete restrict,
  -- Client-visible updates and internal notes never mix (PRD §5.9).
  visibility text not null check (visibility in ('client', 'internal')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  author_type public.actor_type not null,
  author_id uuid,
  created_at timestamptz not null default now()
);

create index workspace_updates_workspace_idx on public.workspace_updates (workspace_id, created_at desc);

create trigger workspace_updates_append_only before update or delete on public.workspace_updates
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create function private.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid())
      and private.is_active_member(w.organization_id)
  );
$$;

create function private.can_read_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id
      and (private.has_permission(w.organization_id, 'workspaces.read_all') or private.is_workspace_member(w.id))
  );
$$;

create function private.can_manage_workspace(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspaces w
    where w.id = p_workspace_id
      and (
        private.has_permission(w.organization_id, 'workspaces.manage')
        or exists (
          select 1 from public.workspace_members wm
          where wm.workspace_id = w.id and wm.user_id = (select auth.uid()) and wm.role = 'lead'
            and private.is_active_member(w.organization_id)
        )
      )
  );
$$;

-- Onboarding material: reviewers always; assigned delivery staff once approved
-- (PRD §2: "approved briefs/assets").
create function private.can_read_onboarding(p_prospect_id uuid)
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
        private.has_permission(p.organization_id, 'onboarding.manage')
        or exists (
          select 1 from public.workspaces w
          join public.onboardings o on o.prospect_id = w.prospect_id
          where w.prospect_id = p.id and o.status = 'approved' and private.is_workspace_member(w.id)
        )
      )
  );
$$;

create function private.workspace_member_names(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', nullif(split_part(btrim(pr.display_name), ' ', 1), ''), 'role', wm.role) order by wm.role, pr.display_name), '[]'::jsonb)
  from public.workspace_members wm
  join public.profiles pr on pr.id = wm.user_id
  where wm.workspace_id = p_workspace_id;
$$;

create function private.add_workspace_update(p_workspace public.workspaces, p_visibility text, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
begin
  insert into public.workspace_updates (organization_id, workspace_id, visibility, body, author_type, author_id)
  values (
    p_workspace.organization_id, p_workspace.id, p_visibility, p_body,
    case when v_actor is null then 'system'::public.actor_type
         when private.is_active_member(p_workspace.organization_id) then 'user'::public.actor_type
         else 'client'::public.actor_type end,
    v_actor
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Onboarding lifecycle helpers
-- ---------------------------------------------------------------------------

create function private.ensure_onboarding(p_prospect_id uuid)
returns public.onboardings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.onboardings;
  v_prospect public.prospects;
  v_template uuid;
begin
  select * into v_row from public.onboardings where prospect_id = p_prospect_id;
  if found then
    return v_row;
  end if;
  select * into v_prospect from public.prospects where id = p_prospect_id;
  select id into v_template from public.questionnaire_templates
  where organization_id = v_prospect.organization_id and active
  order by created_at desc limit 1;
  if v_template is null then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'no active questionnaire template';
  end if;
  insert into public.onboardings (organization_id, prospect_id, template_id, started_by)
  values (v_prospect.organization_id, v_prospect.id, v_template,
          case when private.is_active_member(v_prospect.organization_id) then (select auth.uid()) end)
  on conflict (prospect_id) do nothing
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.onboardings where prospect_id = p_prospect_id;
  else
    perform private.write_event(v_row.organization_id, 'onboarding', v_row.id, 'onboarding.started', '{}'::jsonb,
      case when (select auth.uid()) is null then 'system' else 'app' end, null);
  end if;
  return v_row;
end;
$$;

-- Kickoff readiness (PRD §5.8): active workspace, approved onboarding and a lead.
create function private.evaluate_kickoff(p_workspace_id uuid, p_correlation_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
  v_blockers text[] := '{}';
begin
  select * into v_workspace from public.workspaces where id = p_workspace_id for update;
  if v_workspace.delivery_status <> 'not_ready' then
    return;
  end if;
  if v_workspace.status <> 'active' then
    v_blockers := array_append(v_blockers, 'workspace_not_active');
  end if;
  if not exists (select 1 from public.onboardings where prospect_id = v_workspace.prospect_id and status = 'approved') then
    v_blockers := array_append(v_blockers, 'onboarding_not_approved');
  end if;
  if not exists (select 1 from public.workspace_members where workspace_id = v_workspace.id and role = 'lead') then
    v_blockers := array_append(v_blockers, 'no_delivery_lead');
  end if;

  if cardinality(v_blockers) = 0 then
    update public.workspaces set delivery_status = 'kickoff_ready', kickoff_ready_at = now(), kickoff_blockers = '{}'
    where id = v_workspace.id returning * into v_workspace;
    perform private.write_event(v_workspace.organization_id, 'workspace', v_workspace.id, 'workspace.kickoff_ready',
      '{}'::jsonb, case when (select auth.uid()) is null then 'system' else 'app' end, p_correlation_id);
    perform private.create_ops_task(v_workspace.organization_id, 'schedule_kickoff',
      'Schedule the kickoff with ' || v_workspace.client_name, null, 'operations', null, v_workspace.prospect_id,
      'workspace', v_workspace.id, 'kickoff_meeting:' || v_workspace.id);
  else
    update public.workspaces set kickoff_blockers = v_blockers where id = v_workspace.id;
  end if;
end;
$$;

-- Sync a workspace with its agreement's latest activation evaluation. Never
-- demotes automatically: losing eligibility after activation is a human call.
create function private.sync_workspace(p_contract_id uuid, p_eligible boolean, p_reasons text[], p_correlation_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
begin
  select * into v_workspace from public.workspaces where contract_id = p_contract_id for update;
  if not found or v_workspace.status in ('suspended', 'closed') then
    return;
  end if;
  if v_workspace.status = 'active' then
    if not p_eligible then
      update public.workspaces set blocked_reasons = p_reasons where id = v_workspace.id;
    end if;
    perform private.evaluate_kickoff(v_workspace.id, p_correlation_id);
    return;
  end if;

  if p_eligible then
    update public.workspaces set
      status = 'active', blocked_reasons = '{}', eligible_at = coalesce(eligible_at, now()), activated_at = now()
    where id = v_workspace.id
    returning * into v_workspace;
    perform private.write_event(v_workspace.organization_id, 'workspace', v_workspace.id, 'workspace.activated',
      jsonb_build_object('override', false), case when (select auth.uid()) is null then 'system' else 'app' end, p_correlation_id);
    perform private.write_audit(v_workspace.organization_id, 'workspace.activated', 'workspace', v_workspace.id,
      jsonb_build_object('status', 'blocked'), jsonb_build_object('status', 'active', 'override', false), null, p_correlation_id);
    perform private.add_workspace_update(v_workspace, 'client', 'Your workspace is active. Your delivery team will be in touch to plan the kickoff.');
  else
    update public.workspaces set blocked_reasons = p_reasons where id = v_workspace.id;
  end if;
  perform private.evaluate_kickoff(v_workspace.id, p_correlation_id);
end;
$$;

-- Evaluator from Phase 3, now with real onboarding state and workspace sync (AT-025).
create or replace function private.evaluate_activation(p_contract_id uuid, p_source text, p_correlation_id text)
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
  if v_policy ->> 'required_onboarding_state' = 'approved' and not exists (
    select 1 from public.onboardings where prospect_id = v_contract.prospect_id and status = 'approved'
  ) then
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

  perform private.sync_workspace(v_contract.id, v_eligible, v_reasons, v_correlation);

  return jsonb_build_object(
    'eligible', v_eligible,
    'evaluated_at', v_now,
    'policy_version', v_contract.activation_policy_version,
    'blocking_reasons', to_jsonb(v_reasons)
  );
end;
$$;

-- Executing the agreement now also creates the workspace and starts onboarding.
create or replace function private.on_contract_executed(p_contract public.contracts, p_correlation_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.payment_schedule_items;
  v_prospect public.prospects;
begin
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

  if p_contract.supersedes_contract_id is null then
    insert into public.workspaces (organization_id, prospect_id, contract_id, client_name)
    values (p_contract.organization_id, p_contract.prospect_id, p_contract.id,
            coalesce(nullif(btrim(v_prospect.company), ''), p_contract.client_legal_name))
    on conflict (prospect_id) do nothing;
    if exists (select 1 from public.questionnaire_templates where organization_id = p_contract.organization_id and active) then
      perform private.ensure_onboarding(p_contract.prospect_id);
    end if;
  end if;

  perform private.evaluate_activation(p_contract.id, 'webhook', p_correlation_id);
end;
$$;

-- New organizations also get the default questionnaire.
create or replace function private.seed_organization_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_body text := private.default_contract_template_body();
begin
  insert into public.contract_templates (organization_id, key, version, name, body, template_hash, active)
  values (new.id, 'services-agreement', 1, 'Services agreement (draft, pending legal review)', v_body,
          encode(sha256(convert_to(v_body, 'UTF8')), 'hex'), true)
  on conflict (organization_id, key, version) do nothing;
  insert into public.questionnaire_templates (organization_id, key, version, name, questions, active)
  values (new.id, 'client-onboarding', 1, 'Client onboarding', private.default_questionnaire(), true)
  on conflict (organization_id, key, version) do nothing;
  return new;
end;
$$;

insert into public.questionnaire_templates (organization_id, key, version, name, questions, active)
select o.id, 'client-onboarding', 1, 'Client onboarding', private.default_questionnaire(), true
from public.organizations o
on conflict (organization_id, key, version) do nothing;

-- Agreements executed before this migration get their workspace now.
insert into public.workspaces (organization_id, prospect_id, contract_id, client_name, status)
select distinct on (c.prospect_id) c.organization_id, c.prospect_id, c.id,
       coalesce(nullif(btrim(p.company), ''), c.client_legal_name),
       case when c.activation_eligible then 'active'::public.workspace_status else 'blocked'::public.workspace_status end
from public.contracts c
join public.prospects p on p.id = c.prospect_id
where c.status = 'executed' and c.supersedes_contract_id is null
order by c.prospect_id, c.executed_at
on conflict (prospect_id) do nothing;

-- ---------------------------------------------------------------------------
-- Client-safe projections
-- ---------------------------------------------------------------------------

create function private.client_onboarding_json(p_onboarding_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'status', o.status,
    'questions', t.questions,
    'draft_answers', o.draft_answers,
    'info_requests', case when o.status = 'needs_information' then o.info_requests else '[]'::jsonb end,
    'submitted_revision', s.revision,
    'submitted_at', s.submitted_at,
    'submitted_answers', coalesce((
      select jsonb_object_agg(a.question_key, a.answer_json) from public.onboarding_answers a where a.submission_id = s.id
    ), '{}'::jsonb),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', ca.id, 'filename', ca.filename, 'content_type', ca.content_type,
               'size_bytes', ca.size_bytes, 'created_at', ca.created_at) order by ca.created_at)
      from public.client_assets ca where ca.prospect_id = o.prospect_id and ca.status = 'ready'), '[]'::jsonb),
    'access_grants', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'platform', g.platform, 'requested_scope', g.requested_scope,
               'instructions', g.instructions, 'status', g.status, 'client_note', g.client_note) order by g.created_at)
      from public.access_grants g where g.prospect_id = o.prospect_id and g.status <> 'revoked'), '[]'::jsonb)
  )
  from public.onboardings o
  join public.questionnaire_templates t on t.id = o.template_id
  left join public.onboarding_submissions s on s.id = o.current_submission_id
  where o.id = p_onboarding_id;
$$;

create function private.client_workspace_json(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', w.id,
    'client_name', w.client_name,
    -- Clients see a simple state, never internal blocking reasons.
    'status', case when w.status = 'active' then 'active' when w.status in ('suspended', 'closed') then w.status::text
                   else 'setting_up' end,
    'delivery_status', w.delivery_status,
    'activated_at', w.activated_at,
    'team', private.workspace_member_names(w.id),
    'milestones', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'description', m.description,
               'due_at', m.due_at, 'status', m.status, 'completed_at', m.completed_at) order by m.position, m.due_at)
      from public.milestones m where m.workspace_id = w.id and m.client_visible and m.status <> 'cancelled'), '[]'::jsonb),
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'description', t.description,
               'due_at', t.due_at, 'status', t.status) order by t.due_at nulls last)
      from public.tasks t where t.workspace_id = w.id and t.client_visible and t.status <> 'cancelled'), '[]'::jsonb),
    'updates', coalesce((
      select jsonb_agg(jsonb_build_object('body', u.body, 'created_at', u.created_at) order by u.created_at desc)
      from (select * from public.workspace_updates where workspace_id = w.id and visibility = 'client'
            order by created_at desc limit 30) u), '[]'::jsonb)
  )
  from public.workspaces w
  where w.id = p_workspace_id;
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.questionnaire_templates enable row level security;
alter table public.onboardings enable row level security;
alter table public.onboarding_submissions enable row level security;
alter table public.onboarding_answers enable row level security;
alter table public.onboarding_reviews enable row level security;
alter table public.client_assets enable row level security;
alter table public.access_grants enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.milestones enable row level security;
alter table public.tasks enable row level security;
alter table public.workspace_updates enable row level security;

revoke all on public.questionnaire_templates, public.onboardings, public.onboarding_submissions,
  public.onboarding_answers, public.onboarding_reviews, public.client_assets, public.access_grants,
  public.workspaces, public.workspace_members, public.milestones, public.tasks, public.workspace_updates
  from anon, authenticated;

grant select on public.questionnaire_templates to authenticated;
create policy questionnaire_templates_select on public.questionnaire_templates
  for select to authenticated using ((select private.has_permission(organization_id, 'onboarding.manage')));

grant select on public.onboardings to authenticated;
create policy onboardings_select on public.onboardings
  for select to authenticated using ((select private.can_read_onboarding(prospect_id)));

grant select on public.onboarding_submissions to authenticated;
create policy onboarding_submissions_select on public.onboarding_submissions
  for select to authenticated
  using (exists (select 1 from public.onboardings o where o.id = onboarding_id and private.can_read_onboarding(o.prospect_id)));

grant select on public.onboarding_answers to authenticated;
create policy onboarding_answers_select on public.onboarding_answers
  for select to authenticated
  using (exists (
    select 1 from public.onboarding_submissions s join public.onboardings o on o.id = s.onboarding_id
    where s.id = submission_id and private.can_read_onboarding(o.prospect_id)));

grant select on public.onboarding_reviews to authenticated;
create policy onboarding_reviews_select on public.onboarding_reviews
  for select to authenticated
  using (exists (select 1 from public.onboardings o where o.id = onboarding_id and private.can_read_onboarding(o.prospect_id)));

grant select on public.client_assets to authenticated;
create policy client_assets_select on public.client_assets
  for select to authenticated using ((select private.can_read_onboarding(prospect_id)));

grant select on public.access_grants to authenticated;
create policy access_grants_select on public.access_grants
  for select to authenticated
  using (
    (select private.can_read_onboarding(prospect_id))
    or exists (select 1 from public.workspaces w where w.prospect_id = access_grants.prospect_id and private.is_workspace_member(w.id))
  );

grant select on public.workspaces to authenticated;
create policy workspaces_select on public.workspaces
  for select to authenticated using ((select private.can_read_workspace(id)));

grant select on public.workspace_members to authenticated;
create policy workspace_members_select on public.workspace_members
  for select to authenticated using ((select private.can_read_workspace(workspace_id)));

grant select on public.milestones to authenticated;
create policy milestones_select on public.milestones
  for select to authenticated using ((select private.can_read_workspace(workspace_id)));

grant select on public.tasks to authenticated;
create policy tasks_select on public.tasks
  for select to authenticated using ((select private.can_read_workspace(workspace_id)));

grant select on public.workspace_updates to authenticated;
create policy workspace_updates_select on public.workspace_updates
  for select to authenticated using ((select private.can_read_workspace(workspace_id)));

revoke update, delete, truncate on public.onboarding_submissions, public.onboarding_answers, public.onboarding_reviews,
  public.workspace_updates from service_role;

-- ===========================================================================
-- RPCs: questionnaires and onboarding (staff)
-- ===========================================================================

create function public.save_questionnaire_template(
  p_organization_id uuid,
  p_key text,
  p_name text,
  p_questions jsonb,
  p_activate boolean default false,
  p_correlation_id text default null
)
returns public.questionnaire_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.questionnaire_templates;
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_key is null or p_key !~ '^[a-z0-9-]{2,64}$' or p_name is null or length(btrim(p_name)) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'key and name are required';
  end if;
  perform private.validate_questionnaire(p_questions);
  if p_activate then
    update public.questionnaire_templates set active = false
    where organization_id = p_organization_id and key = p_key and active;
  end if;
  insert into public.questionnaire_templates (organization_id, key, version, name, questions, active, created_by)
  values (
    p_organization_id, p_key,
    coalesce((select max(version) from public.questionnaire_templates where organization_id = p_organization_id and key = p_key), 0) + 1,
    btrim(p_name), p_questions, coalesce(p_activate, false), v_uid
  )
  returning * into v_row;
  perform private.write_audit(p_organization_id, 'questionnaire.created', 'questionnaire_template', v_row.id, null,
    jsonb_build_object('key', v_row.key, 'version', v_row.version, 'active', v_row.active), null, p_correlation_id);
  return v_row;
end;
$$;

-- Onboarding may start before payment or signature when policy allows (PRD §4).
create function public.start_onboarding(p_prospect_id uuid, p_correlation_id text default null)
returns public.onboardings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_prospect public.prospects;
  v_row public.onboardings;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found or not private.has_permission(v_prospect.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  v_row := private.ensure_onboarding(p_prospect_id);
  perform private.write_audit(v_row.organization_id, 'onboarding.started', 'onboarding', v_row.id, null,
    jsonb_build_object('prospect_id', p_prospect_id), null, p_correlation_id);
  return v_row;
end;
$$;

create function public.review_onboarding(
  p_onboarding_id uuid,
  p_submission_id uuid,
  p_decision text,
  p_reasons jsonb default '[]'::jsonb,
  p_correlation_id text default null
)
returns public.onboardings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.onboardings;
  v_reason jsonb;
  v_contract uuid;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_row from public.onboardings where id = p_onboarding_id for update;
  if not found or not private.has_permission(v_row.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_row.status not in ('submitted', 'resubmitted') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'nothing is waiting for review';
  end if;
  -- Reviews always target the latest revision.
  if v_row.current_submission_id is distinct from p_submission_id then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;
  if p_decision not in ('approved', 'needs_information') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'decision must be approved or needs_information';
  end if;
  if p_reasons is null or jsonb_typeof(p_reasons) <> 'array' or jsonb_array_length(p_reasons) > 30 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'reasons must be an array';
  end if;
  if p_decision = 'needs_information' then
    if jsonb_array_length(p_reasons) = 0 then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'say what information is missing';
    end if;
    for v_reason in select * from jsonb_array_elements(p_reasons) loop
      if coalesce(length(btrim(v_reason ->> 'message')), 0) not between 3 and 1000 then
        raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'each request needs a specific message';
      end if;
    end loop;
  end if;

  insert into public.onboarding_reviews (organization_id, onboarding_id, submission_id, decision, reasons, reviewer_id, correlation_id)
  values (v_row.organization_id, v_row.id, p_submission_id, p_decision, p_reasons, v_uid, p_correlation_id);

  update public.onboardings set
    status = p_decision::public.onboarding_status,
    info_requests = case when p_decision = 'needs_information' then p_reasons else '[]'::jsonb end,
    approved_at = case when p_decision = 'approved' then now() else null end,
    approved_by = case when p_decision = 'approved' then v_uid else null end
  where id = v_row.id
  returning * into v_row;

  perform private.write_audit(v_row.organization_id, 'onboarding.' || p_decision, 'onboarding', v_row.id,
    null, jsonb_build_object('status', v_row.status, 'submission_id', p_submission_id, 'reasons', p_reasons),
    null, p_correlation_id);
  perform private.write_event(v_row.organization_id, 'onboarding', v_row.id, 'onboarding.' || p_decision,
    jsonb_build_object('submission_id', p_submission_id), 'app', p_correlation_id);

  if p_decision = 'approved' then
    for v_contract in
      select id from public.contracts
      where prospect_id = v_row.prospect_id and supersedes_contract_id is null and activation_policy is not null
        and status not in ('voided', 'declined', 'expired')
    loop
      perform private.evaluate_activation(v_contract, 'app', p_correlation_id);
    end loop;
  else
    update public.prospects set next_action_at = now() where id = v_row.prospect_id;
  end if;
  return v_row;
end;
$$;

-- ===========================================================================
-- RPCs: onboarding (clients)
-- ===========================================================================

create function public.client_onboarding()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_user();
  select o.id into v_id from public.onboardings o
  where private.client_has_access(o.prospect_id)
  order by o.created_at
  limit 1;
  if v_id is null then
    return null;
  end if;
  return private.client_onboarding_json(v_id);
end;
$$;

create function public.client_save_onboarding_draft(p_answers jsonb, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.onboardings;
  v_questions jsonb;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select o.* into v_row from public.onboardings o
  where private.client_has_access(o.prospect_id)
  order by o.created_at limit 1
  for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_row.status in ('submitted', 'resubmitted', 'approved') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = 'your answers are with Atmors for review';
  end if;
  select questions into v_questions from public.questionnaire_templates where id = v_row.template_id;
  update public.onboardings set
    draft_answers = private.clean_answers(v_questions, p_answers, false),
    status = case when status = 'not_started' then 'in_progress'::public.onboarding_status else status end
  where id = v_row.id
  returning * into v_row;
  return private.client_onboarding_json(v_row.id);
end;
$$;

-- AT-021: every submission is a new immutable revision; the previous one and
-- its answers stay untouched.
create function public.client_submit_onboarding(p_answers jsonb, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.onboardings;
  v_questions jsonb;
  v_clean jsonb;
  v_revision integer;
  v_submission public.onboarding_submissions;
  v_key text;
  v_value jsonb;
  v_was public.onboarding_status;
begin
  perform private.require_correlation_id(p_correlation_id);
  select o.* into v_row from public.onboardings o
  where private.client_has_access(o.prospect_id)
  order by o.created_at limit 1
  for update;
  if v_row.id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_row.status not in ('not_started', 'in_progress', 'needs_information') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('onboarding is %s', v_row.status);
  end if;
  v_was := v_row.status;
  select questions into v_questions from public.questionnaire_templates where id = v_row.template_id;
  v_clean := private.clean_answers(v_questions, p_answers, true);

  select coalesce(max(revision), 0) + 1 into v_revision from public.onboarding_submissions where onboarding_id = v_row.id;
  insert into public.onboarding_submissions (
    organization_id, onboarding_id, template_id, revision, supersedes_submission_id, submitted_by, answers_hash
  )
  values (v_row.organization_id, v_row.id, v_row.template_id, v_revision, v_row.current_submission_id, v_uid,
          encode(sha256(convert_to(v_clean::text, 'UTF8')), 'hex'))
  returning * into v_submission;

  for v_key, v_value in select key, value from jsonb_each(v_clean) loop
    insert into public.onboarding_answers (organization_id, submission_id, question_key, answer_json, answer_source)
    values (v_row.organization_id, v_submission.id, v_key, v_value, 'client');
  end loop;

  update public.onboardings set
    status = case when v_was = 'needs_information' then 'resubmitted'::public.onboarding_status
                  else 'submitted'::public.onboarding_status end,
    current_submission_id = v_submission.id,
    draft_answers = v_clean
  where id = v_row.id
  returning * into v_row;

  perform private.write_audit(v_row.organization_id, 'onboarding.submitted', 'onboarding', v_row.id, null,
    jsonb_build_object('revision', v_revision, 'answers_hash', v_submission.answers_hash), null, p_correlation_id);
  perform private.write_event(v_row.organization_id, 'onboarding', v_row.id, 'onboarding.submitted',
    jsonb_build_object('revision', v_revision), 'app', p_correlation_id);
  perform private.create_ops_task(v_row.organization_id, 'onboarding_review',
    'Review onboarding (revision ' || v_revision || ')', null, 'operations', null, v_row.prospect_id,
    'onboarding', v_row.id, 'onboarding_review:' || v_submission.id);
  return private.client_onboarding_json(v_row.id);
end;
$$;

-- ===========================================================================
-- RPCs: client assets
-- ===========================================================================

-- Called by the upload route as the client, after it validated the bytes.
create function public.client_register_asset(
  p_filename text,
  p_content_type text,
  p_size_bytes bigint,
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
  v_onboarding public.onboardings;
  v_asset public.client_assets;
  v_id uuid := gen_random_uuid();
  v_safe text;
begin
  perform private.require_correlation_id(p_correlation_id);
  select o.* into v_onboarding from public.onboardings o
  where private.client_has_access(o.prospect_id)
  order by o.created_at limit 1;
  if v_onboarding.id is null then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'files must be 10 MB or smaller';
  end if;
  if p_content_type not in (
    'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf', 'text/plain', 'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'file type is not allowed';
  end if;
  if p_checksum is null or p_checksum !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'checksum is required';
  end if;
  if (select count(*) from public.client_assets where prospect_id = v_onboarding.prospect_id and status in ('pending', 'ready')) >= 100 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'upload limit reached';
  end if;

  -- The storage path never uses the client's filename (no traversal).
  v_safe := lower(regexp_replace(coalesce(nullif(btrim(p_filename), ''), 'file'), '[^A-Za-z0-9._-]+', '_', 'g'));
  v_safe := left(regexp_replace(v_safe, '\.{2,}', '.', 'g'), 120);
  insert into public.client_assets (
    id, organization_id, prospect_id, onboarding_id, storage_key, filename, content_type, size_bytes, checksum, uploaded_by
  )
  values (
    v_id, v_onboarding.organization_id, v_onboarding.prospect_id, v_onboarding.id,
    v_onboarding.organization_id || '/' || v_onboarding.prospect_id || '/' || v_id,
    left(btrim(p_filename), 200), p_content_type, p_size_bytes, p_checksum, v_uid
  )
  returning * into v_asset;

  perform private.write_audit(v_asset.organization_id, 'asset.registered', 'client_asset', v_asset.id, null,
    jsonb_build_object('filename', v_asset.filename, 'content_type', v_asset.content_type, 'size_bytes', v_asset.size_bytes),
    null, p_correlation_id);
  return jsonb_build_object('asset_id', v_asset.id, 'storage_key', v_asset.storage_key, 'safe_name', v_safe);
end;
$$;

-- System worker: record the outcome of storing the bytes.
create function public.mark_asset_stored(p_asset_id uuid, p_ok boolean)
returns public.client_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_asset public.client_assets;
begin
  update public.client_assets set status = case when p_ok then 'ready' else 'rejected' end
  where id = p_asset_id and status = 'pending'
  returning * into v_asset;
  return v_asset;
end;
$$;

-- Authorize a download and audit it (PRD §2: audit sensitive downloads). The
-- server then issues a short-lived signed URL for the returned key.
create function public.asset_download_target(p_asset_id uuid, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_asset public.client_assets;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_asset from public.client_assets where id = p_asset_id;
  if not found or v_asset.status <> 'ready'
     or not (private.client_has_access(v_asset.prospect_id) or private.can_read_onboarding(v_asset.prospect_id)) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  perform private.write_audit(v_asset.organization_id, 'asset.downloaded', 'client_asset', v_asset.id, null,
    jsonb_build_object('filename', v_asset.filename), null, p_correlation_id);
  return jsonb_build_object('storage_key', v_asset.storage_key, 'filename', v_asset.filename,
                            'content_type', v_asset.content_type);
end;
$$;

create function public.remove_asset(p_asset_id uuid, p_correlation_id text default null)
returns public.client_assets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_asset public.client_assets;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_asset from public.client_assets where id = p_asset_id for update;
  if not found or not (
    (private.client_has_access(v_asset.prospect_id) and v_asset.uploaded_by = v_uid)
    or private.has_permission(v_asset.organization_id, 'onboarding.manage')) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  update public.client_assets set status = 'removed' where id = p_asset_id returning * into v_asset;
  perform private.write_audit(v_asset.organization_id, 'asset.removed', 'client_asset', v_asset.id, null,
    jsonb_build_object('filename', v_asset.filename), null, p_correlation_id);
  return v_asset;
end;
$$;

-- ===========================================================================
-- RPCs: access grants
-- ===========================================================================

create function public.request_access_grant(
  p_prospect_id uuid,
  p_platform text,
  p_requested_scope text,
  p_instructions text,
  p_owner_user_id uuid default null,
  p_correlation_id text default null
)
returns public.access_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_prospect public.prospects;
  v_row public.access_grants;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_prospect from public.prospects where id = p_prospect_id;
  if not found or not private.has_permission(v_prospect.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  perform private.reject_credentials(p_instructions);
  insert into public.access_grants (organization_id, prospect_id, platform, requested_scope, instructions, owner_user_id, created_by)
  values (v_prospect.organization_id, v_prospect.id, btrim(p_platform), btrim(p_requested_scope),
          nullif(btrim(p_instructions), ''), coalesce(p_owner_user_id, v_uid), v_uid)
  returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'access_grant.requested', 'access_grant', v_row.id, null,
    jsonb_build_object('platform', v_row.platform, 'scope', v_row.requested_scope), null, p_correlation_id);
  return v_row;
end;
$$;

create function public.update_access_grant(
  p_grant_id uuid,
  p_status public.access_grant_status,
  p_expires_at timestamptz default null,
  p_correlation_id text default null
)
returns public.access_grants
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.access_grants;
  v_row public.access_grants;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.access_grants where id = p_grant_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'onboarding.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if not (
    (v_before.status in ('requested', 'client_confirmed') and p_status in ('verified', 'declined'))
    or (v_before.status in ('requested', 'client_confirmed', 'verified') and p_status = 'revoked')
    or (v_before.status = 'declined' and p_status = 'requested')
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('access grant %s -> %s', v_before.status, p_status);
  end if;
  update public.access_grants set
    status = p_status,
    verified_at = case when p_status = 'verified' then now() else verified_at end,
    revoked_at = case when p_status = 'revoked' then now() else revoked_at end,
    expires_at = coalesce(p_expires_at, expires_at)
  where id = p_grant_id
  returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'access_grant.' || p_status::text, 'access_grant', v_row.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_row.status), null, p_correlation_id);
  return v_row;
end;
$$;

create function public.client_confirm_access_grant(p_grant_id uuid, p_note text default null, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.access_grants;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select * into v_row from public.access_grants where id = p_grant_id for update;
  if not found or not private.client_has_access(v_row.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_row.status not in ('requested', 'declined') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = format('access is %s', v_row.status);
  end if;
  if p_note is not null and length(p_note) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'note is too long';
  end if;
  perform private.reject_credentials(p_note);
  update public.access_grants set status = 'client_confirmed', granted_at = now(), client_note = nullif(btrim(p_note), '')
  where id = p_grant_id returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'access_grant.client_confirmed', 'access_grant', v_row.id, null,
    jsonb_build_object('status', v_row.status), null, p_correlation_id);
  perform private.create_ops_task(v_row.organization_id, 'verify_access',
    'Verify access to ' || v_row.platform, null, 'operations', v_row.owner_user_id, v_row.prospect_id,
    'access_grant', v_row.id, 'verify_access:' || v_row.id || ':' || coalesce(v_row.granted_at::text, ''));
  return jsonb_build_object('id', v_row.id, 'status', v_row.status);
end;
$$;

-- ===========================================================================
-- RPCs: workspaces (staff)
-- ===========================================================================

create function public.set_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role text,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_workspace from public.workspaces where id = p_workspace_id for update;
  if not found or not private.has_permission(v_workspace.organization_id, 'workspaces.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_role not in ('lead', 'member', 'remove') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'role must be lead, member or remove';
  end if;
  if p_role = 'remove' then
    delete from public.workspace_members where workspace_id = p_workspace_id and user_id = p_user_id;
  else
    if not exists (
      select 1 from public.organization_memberships m
      where m.organization_id = v_workspace.organization_id and m.user_id = p_user_id and m.status = 'active'
    ) then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'member must be active';
    end if;
    if p_role = 'lead' then
      update public.workspace_members set role = 'member' where workspace_id = p_workspace_id and role = 'lead' and user_id <> p_user_id;
    end if;
    insert into public.workspace_members (workspace_id, user_id, organization_id, role, added_by)
    values (p_workspace_id, p_user_id, v_workspace.organization_id, p_role, v_uid)
    on conflict (workspace_id, user_id) do update set role = excluded.role;
  end if;
  perform private.write_audit(v_workspace.organization_id, 'workspace.member_' || p_role, 'workspace', v_workspace.id,
    null, jsonb_build_object('user_id', p_user_id, 'role', p_role), null, p_correlation_id);
  perform private.evaluate_kickoff(v_workspace.id, p_correlation_id);
end;
$$;

-- AT-026: manual activation needs workspaces.override and a reason; it is
-- audited and stays visibly marked. It does not touch payment or signature records.
create function public.override_workspace_activation(p_workspace_id uuid, p_reason text, p_correlation_id text default null)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.workspaces;
  v_row public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);
  select * into v_before from public.workspaces where id = p_workspace_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'workspaces.override') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.status not in ('blocked', 'eligible') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = format('workspace is %s', v_before.status);
  end if;
  update public.workspaces set
    status = 'active', activated_at = now(), override_active = true, override_reason = btrim(p_reason),
    override_by = v_uid, override_at = now()
  where id = p_workspace_id
  returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'workspace.activation_overridden', 'workspace', v_row.id,
    jsonb_build_object('status', v_before.status, 'blocked_reasons', v_before.blocked_reasons),
    jsonb_build_object('status', 'active', 'override', true), p_reason, p_correlation_id);
  perform private.write_event(v_row.organization_id, 'workspace', v_row.id, 'workspace.activated',
    jsonb_build_object('override', true, 'blocked_reasons', v_before.blocked_reasons), 'app', p_correlation_id);
  perform private.add_workspace_update(v_row, 'internal', 'Activated by manual override: ' || btrim(p_reason));
  perform private.add_workspace_update(v_row, 'client', 'Your workspace is active. Your delivery team will be in touch to plan the kickoff.');
  perform private.evaluate_kickoff(v_row.id, p_correlation_id);
  return v_row;
end;
$$;

create function public.transition_workspace(
  p_workspace_id uuid,
  p_to public.workspace_status,
  p_reason text,
  p_correlation_id text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.workspaces;
  v_row public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  perform private.require_reason(p_reason);
  select * into v_before from public.workspaces where id = p_workspace_id for update;
  if not found or not private.has_permission(v_before.organization_id, 'workspaces.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  -- Resuming re-enters through the evaluator, never straight to active.
  if not (
    (v_before.status = 'active' and p_to in ('suspended', 'closed'))
    or (v_before.status = 'suspended' and p_to in ('blocked', 'closed'))
    or (v_before.status in ('blocked', 'eligible') and p_to = 'closed')
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('workspace %s -> %s', v_before.status, p_to);
  end if;
  update public.workspaces set status = p_to, status_reason = btrim(p_reason),
    override_active = case when p_to = 'blocked' then false else override_active end
  where id = p_workspace_id returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'workspace.status_changed', 'workspace', v_row.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_row.status), p_reason, p_correlation_id);
  perform private.write_event(v_row.organization_id, 'workspace', v_row.id, 'workspace.status_changed',
    jsonb_build_object('from', v_before.status, 'to', v_row.status), 'app', p_correlation_id);
  if p_to = 'blocked' then
    perform private.evaluate_activation(v_row.contract_id, 'app', p_correlation_id);
  end if;
  return v_row;
end;
$$;

create function public.set_delivery_status(
  p_workspace_id uuid,
  p_to public.delivery_status,
  p_reason text default null,
  p_correlation_id text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.workspaces;
  v_row public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.workspaces where id = p_workspace_id for update;
  if not found or not private.can_manage_workspace(p_workspace_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if not (
    (v_before.delivery_status = 'kickoff_ready' and p_to = 'in_progress')
    or (v_before.delivery_status = 'in_progress' and p_to in ('paused', 'completed'))
    or (v_before.delivery_status = 'paused' and p_to = 'in_progress')
  ) or v_before.status <> 'active' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION',
      detail = format('delivery %s -> %s (workspace %s)', v_before.delivery_status, p_to, v_before.status);
  end if;
  if p_to in ('paused', 'completed') then
    perform private.require_reason(p_reason);
  end if;
  update public.workspaces set delivery_status = p_to where id = p_workspace_id returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'workspace.delivery_status_changed', 'workspace', v_row.id,
    jsonb_build_object('delivery_status', v_before.delivery_status), jsonb_build_object('delivery_status', p_to),
    p_reason, p_correlation_id);
  perform private.write_event(v_row.organization_id, 'workspace', v_row.id, 'workspace.delivery_status_changed',
    jsonb_build_object('from', v_before.delivery_status, 'to', p_to), 'app', p_correlation_id);
  return v_row;
end;
$$;

create function public.save_milestone(
  p_workspace_id uuid,
  p_milestone_id uuid,
  p_fields jsonb,
  p_correlation_id text default null
)
returns public.milestones
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace public.workspaces;
  v_before public.milestones;
  v_row public.milestones;
  v_status text := coalesce(p_fields ->> 'status', 'planned');
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_workspace from public.workspaces where id = p_workspace_id;
  if not found or not private.can_manage_workspace(p_workspace_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if coalesce(length(btrim(p_fields ->> 'title')), 0) not between 1 and 200
     or v_status not in ('planned', 'in_progress', 'done', 'cancelled') then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'title and a valid status are required';
  end if;
  if p_milestone_id is null then
    insert into public.milestones (organization_id, workspace_id, title, description, due_at, status, client_visible, position, completed_at)
    values (v_workspace.organization_id, p_workspace_id, btrim(p_fields ->> 'title'), nullif(btrim(p_fields ->> 'description'), ''),
            nullif(p_fields ->> 'due_at', '')::timestamptz, v_status, coalesce((p_fields ->> 'client_visible')::boolean, true),
            coalesce((p_fields ->> 'position')::integer, 0), case when v_status = 'done' then now() end)
    returning * into v_row;
  else
    select * into v_before from public.milestones where id = p_milestone_id and workspace_id = p_workspace_id for update;
    if not found then
      raise exception using errcode = '42501', message = 'FORBIDDEN';
    end if;
    update public.milestones set
      title = btrim(p_fields ->> 'title'),
      description = nullif(btrim(p_fields ->> 'description'), ''),
      due_at = nullif(p_fields ->> 'due_at', '')::timestamptz,
      status = v_status,
      client_visible = coalesce((p_fields ->> 'client_visible')::boolean, client_visible),
      position = coalesce((p_fields ->> 'position')::integer, position),
      completed_at = case when v_status = 'done' then coalesce(completed_at, now()) else null end
    where id = p_milestone_id
    returning * into v_row;
  end if;
  perform private.write_audit(v_row.organization_id, 'milestone.saved', 'milestone', v_row.id,
    case when v_before.id is null then null else jsonb_build_object('status', v_before.status, 'due_at', v_before.due_at) end,
    jsonb_build_object('title', v_row.title, 'status', v_row.status, 'due_at', v_row.due_at, 'client_visible', v_row.client_visible),
    null, p_correlation_id);
  if v_row.client_visible and v_row.status = 'done' and v_before.status is distinct from 'done' then
    perform private.add_workspace_update(v_workspace, 'client', 'Milestone completed: ' || v_row.title);
  end if;
  return v_row;
end;
$$;

create function public.save_task(
  p_workspace_id uuid,
  p_task_id uuid,
  p_fields jsonb,
  p_correlation_id text default null
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace public.workspaces;
  v_before public.tasks;
  v_row public.tasks;
  v_owner uuid := nullif(p_fields ->> 'owner_user_id', '')::uuid;
  v_dependency uuid := nullif(p_fields ->> 'dependency_id', '')::uuid;
  v_milestone uuid := nullif(p_fields ->> 'milestone_id', '')::uuid;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_workspace from public.workspaces where id = p_workspace_id;
  if not found or not private.can_manage_workspace(p_workspace_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if coalesce(length(btrim(p_fields ->> 'title')), 0) not between 1 and 200 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'title is required';
  end if;
  if v_owner is not null and not exists (select 1 from public.workspace_members where workspace_id = p_workspace_id and user_id = v_owner) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'the owner must be on the workspace team';
  end if;
  if v_dependency is not null and not exists (select 1 from public.tasks where id = v_dependency and workspace_id = p_workspace_id) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'dependency must be a task in this workspace';
  end if;
  if v_milestone is not null and not exists (select 1 from public.milestones where id = v_milestone and workspace_id = p_workspace_id) then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'milestone must be in this workspace';
  end if;

  if p_task_id is null then
    insert into public.tasks (
      organization_id, workspace_id, milestone_id, title, description, internal_notes, owner_user_id, due_at,
      priority, client_visible, dependency_id, created_by
    )
    values (
      v_workspace.organization_id, p_workspace_id, v_milestone, btrim(p_fields ->> 'title'),
      nullif(btrim(p_fields ->> 'description'), ''), nullif(btrim(p_fields ->> 'internal_notes'), ''), v_owner,
      nullif(p_fields ->> 'due_at', '')::timestamptz, coalesce(nullif(p_fields ->> 'priority', ''), 'normal')::public.task_priority,
      coalesce((p_fields ->> 'client_visible')::boolean, false), v_dependency, v_uid
    )
    returning * into v_row;
  else
    select * into v_before from public.tasks where id = p_task_id and workspace_id = p_workspace_id for update;
    if not found then
      raise exception using errcode = '42501', message = 'FORBIDDEN';
    end if;
    if v_dependency = p_task_id then
      raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'a task cannot depend on itself';
    end if;
    update public.tasks set
      milestone_id = v_milestone, title = btrim(p_fields ->> 'title'),
      description = nullif(btrim(p_fields ->> 'description'), ''),
      internal_notes = nullif(btrim(p_fields ->> 'internal_notes'), ''),
      owner_user_id = v_owner, due_at = nullif(p_fields ->> 'due_at', '')::timestamptz,
      priority = coalesce(nullif(p_fields ->> 'priority', ''), priority::text)::public.task_priority,
      client_visible = coalesce((p_fields ->> 'client_visible')::boolean, client_visible),
      dependency_id = v_dependency
    where id = p_task_id
    returning * into v_row;
  end if;
  perform private.write_audit(v_row.organization_id, 'task.saved', 'task', v_row.id,
    case when v_before.id is null then null
         else jsonb_build_object('owner_user_id', v_before.owner_user_id, 'due_at', v_before.due_at, 'priority', v_before.priority) end,
    jsonb_build_object('title', v_row.title, 'owner_user_id', v_row.owner_user_id, 'due_at', v_row.due_at,
                       'priority', v_row.priority, 'client_visible', v_row.client_visible),
    null, p_correlation_id);
  return v_row;
end;
$$;

-- Task owners (including delivery staff) move their own tasks; leads and
-- managers move any task in the workspace.
create function public.update_task_status(
  p_task_id uuid,
  p_status public.task_status,
  p_evidence text default null,
  p_correlation_id text default null
)
returns public.tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_before public.tasks;
  v_row public.tasks;
  v_workspace public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_before from public.tasks where id = p_task_id for update;
  if not found or not (
    private.can_manage_workspace(v_before.workspace_id)
    or (v_before.owner_user_id = v_uid and private.is_workspace_member(v_before.workspace_id))) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if v_before.status in ('done', 'cancelled') and p_status not in ('todo', 'in_progress') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'task is closed';
  end if;
  if p_status = 'done' and v_before.dependency_id is not null and exists (
    select 1 from public.tasks where id = v_before.dependency_id and status <> 'done'
  ) then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'its dependency is not done yet';
  end if;
  if p_evidence is not null and length(p_evidence) > 2000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'evidence is too long';
  end if;
  update public.tasks set
    status = p_status,
    completion_evidence = case when p_status = 'done' then coalesce(nullif(btrim(p_evidence), ''), completion_evidence) else completion_evidence end,
    completed_at = case when p_status = 'done' then now() else null end
  where id = p_task_id
  returning * into v_row;
  perform private.write_audit(v_row.organization_id, 'task.status_changed', 'task', v_row.id,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_row.status, 'evidence', v_row.completion_evidence),
    null, p_correlation_id);
  if v_row.client_visible and p_status = 'done' then
    select * into v_workspace from public.workspaces where id = v_row.workspace_id;
    perform private.add_workspace_update(v_workspace, 'client', 'Done: ' || v_row.title);
  end if;
  return v_row;
end;
$$;

create function public.post_workspace_update(
  p_workspace_id uuid,
  p_visibility text,
  p_body text,
  p_correlation_id text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_workspace public.workspaces;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_workspace from public.workspaces where id = p_workspace_id;
  -- Internal notes: any team member; client-visible updates: leads and managers.
  if not found or not (
    private.can_manage_workspace(p_workspace_id)
    or (p_visibility = 'internal' and private.is_workspace_member(p_workspace_id))) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_visibility not in ('client', 'internal') or p_body is null or length(btrim(p_body)) not between 1 and 4000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'visibility and text are required';
  end if;
  perform private.add_workspace_update(v_workspace, p_visibility, btrim(p_body));
  perform private.write_audit(v_workspace.organization_id, 'workspace.update_posted', 'workspace', v_workspace.id, null,
    jsonb_build_object('visibility', p_visibility), null, p_correlation_id);
end;
$$;

create function public.evaluate_workspace(p_workspace_id uuid, p_correlation_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace public.workspaces;
begin
  perform private.require_user();
  perform private.require_correlation_id(p_correlation_id);
  select * into v_workspace from public.workspaces where id = p_workspace_id;
  if not found or not private.can_read_workspace(p_workspace_id) then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  return private.evaluate_activation(v_workspace.contract_id, 'app', p_correlation_id);
end;
$$;

-- ===========================================================================
-- RPCs: workspace (clients)
-- ===========================================================================

create function public.client_workspace()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_user();
  select w.id into v_id from public.workspaces w
  where private.client_has_access(w.prospect_id)
  order by w.created_at limit 1;
  if v_id is null then
    return null;
  end if;
  return private.client_workspace_json(v_id);
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
    'public.save_questionnaire_template(uuid, text, text, jsonb, boolean, text)',
    'public.start_onboarding(uuid, text)',
    'public.review_onboarding(uuid, uuid, text, jsonb, text)',
    'public.client_onboarding()',
    'public.client_save_onboarding_draft(jsonb, text)',
    'public.client_submit_onboarding(jsonb, text)',
    'public.client_register_asset(text, text, bigint, text, text)',
    'public.asset_download_target(uuid, text)',
    'public.remove_asset(uuid, text)',
    'public.request_access_grant(uuid, text, text, text, uuid, text)',
    'public.update_access_grant(uuid, public.access_grant_status, timestamptz, text)',
    'public.client_confirm_access_grant(uuid, text, text)',
    'public.set_workspace_member(uuid, uuid, text, text)',
    'public.override_workspace_activation(uuid, text, text)',
    'public.transition_workspace(uuid, public.workspace_status, text, text)',
    'public.set_delivery_status(uuid, public.delivery_status, text, text)',
    'public.save_milestone(uuid, uuid, jsonb, text)',
    'public.save_task(uuid, uuid, jsonb, text)',
    'public.update_task_status(uuid, public.task_status, text, text)',
    'public.post_workspace_update(uuid, text, text, text)',
    'public.evaluate_workspace(uuid, text)',
    'public.client_workspace()'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;

revoke all on function public.mark_asset_stored(uuid, boolean) from public, anon, authenticated;
grant execute on function public.mark_asset_stored(uuid, boolean) to service_role;
