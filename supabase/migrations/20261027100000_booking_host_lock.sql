-- Concurrency fix for shared booking (AT-010). Under simultaneous requests
-- for the same host, two transactions could each insert and then wait on the
-- other's row while checking the exclusion constraint, which Postgres reports
-- as a deadlock (40P01). Bookings now take a per-host advisory lock first, so
-- they queue and the loser sees a clean exclusion violation. A detected
-- deadlock is still handled as "slot taken" as a fallback.

create or replace function private.book_meeting(
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
      -- One booking at a time per host, so concurrent requests queue instead of
      -- deadlocking on the exclusion constraint.
      perform pg_advisory_xact_lock(hashtextextended('meetings:host:' || v_candidate.host_user_id::text, 0));
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
      when exclusion_violation or deadlock_detected then
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

create or replace function private.reschedule_meeting(p_meeting_id uuid, p_start timestamptz, p_correlation_id text)
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
  perform pg_advisory_xact_lock(hashtextextended('meetings:host:' || v_meeting.host_user_id::text, 0));
  begin
    update public.meetings set
      start_at = v_slot.start_at,
      end_at = v_slot.end_at,
      status = 'rescheduled',
      rescheduled_count = rescheduled_count + 1
    where id = v_meeting.id
    returning * into v_meeting;
  exception when exclusion_violation or deadlock_detected then
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
