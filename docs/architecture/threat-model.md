# Threat model (initial, Phase 1)

Scope: PRD §11. Review this at the end of every phase. Status is either **mitigated** (implemented and tested), **partial**, or **planned** (with the phase).

| # | Threat | Impact | Mitigation | Status |
|---|---|---|---|---|
| T1 | Cross-client or cross-organization record access by guessing IDs | Data exposure (release blocker) | RLS on every table, record-level policies, UUID keys, tests in `tests/security/rls.test.ts` | Mitigated for Phase 1 tables |
| T2 | Role escalation (self-promotion, editing `role_permissions`) | Full compromise | No client write grants on memberships or permissions; audited RPC requires `members.manage` and blocks self-changes | Mitigated |
| T3 | Trusting client-supplied role, status or ownership | Privilege bypass | Server derives context from the verified JWT and the database; RPCs re-check | Mitigated |
| T4 | Tampering with the audit trail | Loss of accountability | Append-only triggers on update, delete and truncate; service role also revoked; no client inserts | Mitigated |
| T5 | Account enumeration through sign-in | Reconnaissance | Same response whether or not the email exists; signup disabled; `shouldCreateUser: false` | Mitigated |
| T6 | Open redirect through `?next=` | Phishing | `safeRedirectPath` allows same-origin relative paths only | Mitigated |
| T7 | Secret leakage (keys in the browser, logs or the repo) | Full compromise | Secret key unused by the runtime; `.env*` gitignored; structured logger redacts sensitive keys; error envelope hides internals | Partial: secret scanning in CI planned for Phase 6 |
| T8 | Session theft / CSRF | Account takeover | Supabase httpOnly cookies, Next.js server action origin checks, sign-out is POST only, `X-Frame-Options: DENY` | Partial: nonce-based CSP planned once providers are chosen |
| T9 | Weak internal authentication | Account takeover | Magic links (single use, one-hour expiry) | Partial: MFA (TOTP) for internal users planned before the pilot (Phase 6) |
| T10 | Invitation theft or forwarding | Unauthorized proposal access | Hashed, scoped, expiring, revocable tokens; authentication required for sensitive actions | Planned for Phase 2 (AT-001 to AT-004) |
| T11 | Webhook spoofing, replay or payment-state manipulation | Financial loss | Signature verification, idempotent event store, amount and currency matching | Planned for Phase 3 (AT-014 to AT-017) |
| T12 | Malicious or oversized file uploads | Malware, data exposure | Private storage, type and size limits, short-lived signed URLs | Planned for Phase 4 (AT-022) |
| T13 | Prompt injection or cross-client leakage through AI | Data exposure | Permission-scoped retrieval, untrusted-input handling, evaluation set | Planned for Phase 5 (AT-027 to AT-029) |
