-- Commercial team member who can manage their own prospects and proposals but
-- has no discount or approval authority (PRD §5.2, AT-008). Kept in its own
-- migration because a new enum value cannot be used in the transaction that
-- adds it.
alter type public.member_role add value if not exists 'sales';
