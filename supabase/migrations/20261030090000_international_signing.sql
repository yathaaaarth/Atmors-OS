-- International clients and a production-grade signing path.
--   * Client country on agreements; export-of-services invoices (LUT note, no GST)
--     and seller details, for clients who are mostly outside India.
--   * Bank-transfer instructions and "transfer sent" reports for international wires.
--   * Built-in e-signature (provider "internal"): authenticated signer, emailed
--     one-time code, typed name, exact checksum, evidence kept as a certificate.
-- Applied functions are replaced (create or replace), never edited in place.

alter table public.contracts
  add column client_country char(2) check (client_country ~ '^[A-Z]{2}$');

create or replace function private.guard_contract()
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
       new.rendered_document, new.checksum, new.client_legal_name, new.client_address, new.client_tax_id, new.client_country,
       new.signer_name, new.signer_email, new.countersigner_user_id, new.currency, new.total_minor,
       new.activation_policy, new.activation_policy_version, new.amendment_text, new.title
     ) is distinct from (
       old.rendered_document, old.checksum, old.client_legal_name, old.client_address, old.client_tax_id, old.client_country,
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

create or replace function public.generate_contract(
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
     or coalesce(nullif(p_legal ->> 'client_country', ''), 'IN') !~ '^[A-Z]{2}$'
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
    title, client_legal_name, client_address, client_tax_id, client_country, signer_name, signer_email, countersigner_user_id,
    currency, total_minor, rendered_document, checksum, activation_policy, created_by
  )
  values (
    v_proposal.organization_id, v_proposal.prospect_id, v_proposal.id, v_version.id, v_template.id,
    v_template.version, v_template.template_hash, v_proposal.title,
    btrim(p_legal ->> 'client_legal_name'), btrim(p_legal ->> 'client_address'),
    nullif(btrim(p_legal ->> 'client_tax_id'), ''), coalesce(nullif(p_legal ->> 'client_country', ''), 'IN'),
    btrim(p_legal ->> 'signer_name'), v_signer_email,
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

create or replace function public.create_contract_amendment(
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
    title, client_legal_name, client_address, client_tax_id, client_country, signer_name, signer_email, countersigner_user_id,
    currency, total_minor, rendered_document, checksum, activation_policy, supersedes_contract_id,
    amendment_reason, amendment_text, created_by
  )
  values (
    v_original.organization_id, v_original.prospect_id, v_original.proposal_id, v_original.proposal_version_id,
    v_original.template_id, v_original.template_version, v_original.template_hash,
    'Amendment: ' || left(v_original.title, 180), v_original.client_legal_name, v_original.client_address,
    v_original.client_tax_id, v_original.client_country, v_original.signer_name, v_original.signer_email, v_original.countersigner_user_id,
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

create or replace function private.client_contract_json(p_contract_id uuid)
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
    'provider', c.provider,
    'client_country', c.client_country,
    'client_legal_name', c.client_legal_name,
    'currency', c.currency,
    'total_minor', c.total_minor,
    'rendered_document', c.rendered_document,
    'checksum', c.checksum,
    'sent_at', c.sent_at,
    'executed_at', c.executed_at,
    'signers', coalesce((
      select jsonb_agg(jsonb_build_object('role', s.role, 'name', s.name, 'status', s.status, 'signed_at', s.signed_at,
               'typed_name', s.evidence ->> 'typed_name', 'method', s.evidence ->> 'method')
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

-- ---------------------------------------------------------------------------
-- Seller details, bank-transfer instructions and export (LUT) settings
-- ---------------------------------------------------------------------------

create table public.billing_settings (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  legal_name text check (length(legal_name) <= 200),
  address text check (length(address) <= 500),
  gstin text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  -- Letter of Undertaking for zero-rated export of services (accountant to confirm wording).
  lut_number text check (length(lut_number) <= 60),
  -- SWIFT/IBAN/account details shown to clients on unpaid invoices.
  bank_instructions text check (length(bank_instructions) <= 4000),
  invoice_footer text check (length(invoice_footer) <= 1000),
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger billing_settings_set_updated_at before update on public.billing_settings
  for each row execute function private.set_updated_at();

alter table public.billing_settings enable row level security;
revoke all on public.billing_settings from anon, authenticated;
grant select on public.billing_settings to authenticated;
create policy billing_settings_select on public.billing_settings
  for select to authenticated using ((select private.has_permission(organization_id, 'finance.read')));

create function public.save_billing_settings(p_organization_id uuid, p_fields jsonb, p_correlation_id text default null)
returns public.billing_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_row public.billing_settings;
begin
  perform private.require_correlation_id(p_correlation_id);
  if not private.has_permission(p_organization_id, 'billing.manage') then
    raise exception using errcode = '42501', message = 'FORBIDDEN';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'fields must be an object';
  end if;
  perform private.reject_credentials(p_fields ->> 'bank_instructions');
  insert into public.billing_settings (organization_id, legal_name, address, gstin, lut_number, bank_instructions, invoice_footer, updated_by)
  values (
    p_organization_id, nullif(btrim(p_fields ->> 'legal_name'), ''), nullif(btrim(p_fields ->> 'address'), ''),
    nullif(upper(btrim(p_fields ->> 'gstin')), ''), nullif(btrim(p_fields ->> 'lut_number'), ''),
    nullif(btrim(p_fields ->> 'bank_instructions'), ''), nullif(btrim(p_fields ->> 'invoice_footer'), ''), v_uid
  )
  on conflict (organization_id) do update set
    legal_name = excluded.legal_name, address = excluded.address, gstin = excluded.gstin, lut_number = excluded.lut_number,
    bank_instructions = excluded.bank_instructions, invoice_footer = excluded.invoice_footer, updated_by = v_uid
  returning * into v_row;
  perform private.write_audit(p_organization_id, 'billing_settings.saved', 'billing_settings', null, null,
    jsonb_build_object('legal_name', v_row.legal_name, 'gstin', v_row.gstin, 'lut_number', v_row.lut_number,
                       'bank_instructions_set', v_row.bank_instructions is not null),
    null, p_correlation_id);
  return v_row;
end;
$$;

-- Client projection of an invoice: buyer and seller details, export note,
-- bank instructions while unpaid. Still no internal fields.
create or replace function private.client_invoice_json(p_invoice_id uuid)
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
    'tax_minor', coalesce((i.tax_snapshot ->> 'tax_minor')::bigint, 0),
    'export', coalesce(c.client_country, 'IN') <> 'IN',
    'buyer', jsonb_build_object('legal_name', c.client_legal_name, 'address', c.client_address, 'tax_id', c.client_tax_id,
                                'country', c.client_country),
    'seller', jsonb_build_object(
      'legal_name', coalesce(bs.legal_name, o.name), 'address', bs.address, 'gstin', bs.gstin,
      'lut_number', case when coalesce(c.client_country, 'IN') <> 'IN' then bs.lut_number end,
      'footer', bs.invoice_footer),
    'bank_instructions', case when i.status in ('issued', 'partially_paid', 'overdue') then bs.bank_instructions end,
    'transfer_reported_at', (
      select max(t.created_at) from public.ops_tasks t
      where t.kind = 'transfer_reported' and t.related_id = i.id),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'status', p.status, 'amount_minor', p.amount_minor,
               'refunded_minor', p.refunded_minor, 'manual', p.manual, 'created_at', p.created_at,
               'succeeded_at', p.succeeded_at) order by p.created_at desc)
      from public.payments p where p.invoice_id = i.id), '[]'::jsonb)
  )
  from public.invoices i
  join public.contracts c on c.id = i.contract_id
  join public.organizations o on o.id = i.organization_id
  left join public.billing_settings bs on bs.organization_id = i.organization_id
  where i.id = p_invoice_id;
$$;

-- The client says they sent a bank transfer: a finance task, never a payment.
create function public.client_report_transfer(
  p_invoice_id uuid,
  p_reference text,
  p_note text default null,
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
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_invoice from public.invoices where id = p_invoice_id;
  if not found or v_invoice.status = 'draft' or not private.client_has_access(v_invoice.prospect_id) then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  if v_invoice.status not in ('issued', 'partially_paid', 'overdue') then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = format('invoice is %s', v_invoice.status);
  end if;
  if coalesce(length(btrim(p_reference)), 0) not between 3 and 200 or coalesce(length(p_note), 0) > 1000 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'a transfer reference (3-200 characters) is required';
  end if;
  perform private.reject_credentials(p_note);
  perform private.create_ops_task(v_invoice.organization_id, 'transfer_reported',
    'Client reports a bank transfer for ' || coalesce(v_invoice.invoice_number, 'an invoice'),
    'Reference: ' || btrim(p_reference) || coalesce(E'\n' || nullif(btrim(p_note), ''), ''),
    'finance', null, v_invoice.prospect_id, 'invoice', v_invoice.id,
    'transfer:' || v_invoice.id || ':' || md5(lower(btrim(p_reference))));
  perform private.write_audit(v_invoice.organization_id, 'invoice.transfer_reported', 'invoice', v_invoice.id, null,
    jsonb_build_object('reference', btrim(p_reference)), p_note, p_correlation_id);
  return jsonb_build_object('reported', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Built-in e-signature (provider "internal"): authenticated signer, emailed
-- one-time code, typed name, exact document checksum. The evidence becomes a
-- verified signature event processed exactly like a vendor's.
-- ---------------------------------------------------------------------------

create table public.signature_challenges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  contract_id uuid not null references public.contracts (id) on delete restrict,
  signer_role text not null check (signer_role in ('client', 'atmors')),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- sha256 of the emailed code; the code itself is never stored.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create index signature_challenges_lookup_idx on public.signature_challenges (contract_id, user_id, created_at desc);

alter table public.signature_challenges enable row level security;
revoke all on public.signature_challenges from anon, authenticated;
revoke update, delete, truncate on public.signature_challenges from service_role;

-- Resolve which signer slot the caller may sign, or raise.
create function private.signing_slot(p_contract public.contracts, p_checksum text)
returns public.contract_signers
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.require_user();
  v_signer public.contract_signers;
begin
  if p_contract.provider is distinct from 'internal' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'this agreement is signed through another provider';
  end if;
  if p_contract.checksum is distinct from p_checksum then
    raise exception using errcode = '55000', message = 'VERSION_STALE';
  end if;
  if private.client_has_access(p_contract.prospect_id) and p_contract.status in ('sent', 'viewed') then
    select * into v_signer from public.contract_signers where contract_id = p_contract.id and role = 'client';
    if v_signer.status = 'pending' and lower(v_signer.email) = private.current_user_email() then
      return v_signer;
    end if;
  end if;
  if p_contract.status = 'partially_signed' and p_contract.countersigner_user_id = v_uid
     and private.has_permission(p_contract.organization_id, 'contracts.manage') then
    select * into v_signer from public.contract_signers where contract_id = p_contract.id and role = 'atmors';
    if v_signer.status = 'pending' then
      return v_signer;
    end if;
  end if;
  raise exception using errcode = '42501', message = 'FORBIDDEN', detail = 'you are not the next signer of this agreement';
end;
$$;

-- Step 1: the server generates a 6-digit code, emails it, and stores its hash here.
create function public.begin_internal_signature(
  p_contract_id uuid,
  p_checksum text,
  p_code_hash text,
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
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_signer := private.signing_slot(v_contract, p_checksum);
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'malformed code';
  end if;
  -- At most 5 codes per signer per hour.
  if (select count(*) from public.signature_challenges
      where contract_id = v_contract.id and user_id = v_uid and created_at > now() - interval '1 hour') >= 5 then
    raise exception using errcode = '55000', message = 'RATE_LIMITED';
  end if;
  insert into public.signature_challenges (organization_id, contract_id, signer_role, user_id, code_hash, checksum, expires_at)
  values (v_contract.organization_id, v_contract.id, v_signer.role, v_uid, p_code_hash, p_checksum, now() + interval '10 minutes');
  perform private.write_audit(v_contract.organization_id, 'contract.signature_code_sent', 'contract', v_contract.id, null,
    jsonb_build_object('signer_role', v_signer.role), null, p_correlation_id);
  return jsonb_build_object('email', v_signer.email, 'role', v_signer.role);
end;
$$;

-- Step 2: verify the code and record the signature with its evidence.
create function public.complete_internal_signature(
  p_contract_id uuid,
  p_checksum text,
  p_code_hash text,
  p_typed_name text,
  p_evidence jsonb,
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
  v_challenge public.signature_challenges;
  v_event_id uuid;
  v_status text;
  v_evidence jsonb;
begin
  perform private.require_correlation_id(p_correlation_id);
  select * into v_contract from public.contracts where id = p_contract_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'NOT_FOUND';
  end if;
  v_signer := private.signing_slot(v_contract, p_checksum);
  if coalesce(length(btrim(p_typed_name)), 0) not between 2 and 120 then
    raise exception using errcode = '22023', message = 'VALIDATION_FAILED', detail = 'type your full name to sign';
  end if;

  select * into v_challenge from public.signature_challenges
  where contract_id = v_contract.id and user_id = v_uid and signer_role = v_signer.role and consumed_at is null
  order by created_at desc limit 1
  for update;
  if not found or v_challenge.expires_at < now() or v_challenge.attempts >= 5 or v_challenge.checksum <> p_checksum then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'request a new signing code';
  end if;
  if v_challenge.code_hash <> coalesce(p_code_hash, '') then
    -- Return rather than raise, so the failed attempt is counted.
    update public.signature_challenges set attempts = attempts + 1 where id = v_challenge.id;
    return jsonb_build_object('status', 'wrong_code', 'attempts_left', greatest(4 - v_challenge.attempts, 0));
  end if;
  update public.signature_challenges set consumed_at = now() where id = v_challenge.id;

  v_evidence := jsonb_build_object(
    'method', 'email_code',
    'signer_role', v_signer.role,
    'signer_email', v_signer.email,
    'typed_name', btrim(p_typed_name),
    'user_id', v_uid,
    'checksum', p_checksum,
    'challenge_id', v_challenge.id,
    'ip_hash', left(coalesce(p_evidence ->> 'ip_hash', ''), 64),
    'user_agent', left(coalesce(p_evidence ->> 'user_agent', ''), 300),
    'signed_at', now()
  );
  insert into public.signature_events (
    organization_id, contract_id, provider, provider_event_id, event_type, signature_verified, payload_hash,
    provider_document_id, data, occurred_at, correlation_id
  )
  values (
    v_contract.organization_id, v_contract.id, 'internal', 'internal:' || gen_random_uuid(), 'signer.signed', true,
    encode(sha256(convert_to(v_evidence::text, 'UTF8')), 'hex'), v_contract.provider_document_id, v_evidence, now(),
    p_correlation_id
  )
  returning id into v_event_id;
  v_status := private.process_signature_event(v_event_id);
  if v_status <> 'processed' then
    raise exception using errcode = '55000', message = 'INVALID_STATE_TRANSITION', detail = 'signature could not be applied: ' || v_status;
  end if;
  -- Keep the evidence on the signer row for the certificate.
  update public.contract_signers set evidence = evidence || v_evidence where id = v_signer.id;
  return jsonb_build_object('status', 'signed', 'contract_status', (select status from public.contracts where id = v_contract.id));
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
    'public.save_billing_settings(uuid, jsonb, text)',
    'public.client_report_transfer(uuid, text, text, text)',
    'public.begin_internal_signature(uuid, text, text, text)',
    'public.complete_internal_signature(uuid, text, text, text, jsonb, text)'
  ] loop
    execute format('revoke all on function %s from public, anon', v_fn);
    execute format('grant execute on function %s to authenticated', v_fn);
  end loop;
end;
$$;
