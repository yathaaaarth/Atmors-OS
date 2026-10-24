# Threat model (updated, Phase 2)

Scope: PRD §11. Review this at the end of every phase. Status is either **mitigated** (implemented and tested), **partial**, or **planned** (with the phase).

| # | Threat | Impact | Mitigation | Status |
|---|---|---|---|---|
| T1 | Cross-client or cross-organization record access by guessing IDs | Data exposure (release blocker) | RLS on every table, record-level policies, UUID keys, tests in `tests/security/rls.test.ts` | Mitigated for Phase 1–2 tables (`rls.test.ts`, `phase2.test.ts`) |
| T2 | Role escalation (self-promotion, editing `role_permissions`) | Full compromise | No client write grants on memberships or permissions; audited RPC requires `members.manage` and blocks self-changes | Mitigated |
| T3 | Trusting client-supplied role, status or ownership | Privilege bypass | Server derives context from the verified JWT and the database; RPCs re-check | Mitigated |
| T4 | Tampering with the audit trail | Loss of accountability | Append-only triggers on update, delete and truncate; service role also revoked; no client inserts | Mitigated |
| T5 | Account enumeration through sign-in | Reconnaissance | Same response whether or not the email exists; signup disabled; `shouldCreateUser: false` | Mitigated |
| T6 | Open redirect through `?next=` | Phishing | `safeRedirectPath` allows same-origin relative paths only | Mitigated |
| T7 | Secret leakage (keys in the browser, logs or the repo) | Full compromise | Secret key used server-side only, in one action (D-008); `.env*` gitignored; structured logger redacts sensitive keys; error envelope hides internals | Partial: secret scanning in CI planned for Phase 6 |
| T8 | Session theft / CSRF | Account takeover | Supabase httpOnly cookies, Next.js server action origin checks, sign-out is POST only, `X-Frame-Options: DENY` | Partial: nonce-based CSP planned once providers are chosen |
| T9 | Weak internal authentication | Account takeover | Magic links (single use, one-hour expiry) | Partial: MFA (TOTP) for internal users planned before the pilot (Phase 6) |
| T10 | Invitation theft or forwarding | Unauthorized proposal access | 256-bit tokens stored only as hashes; scoped to one prospect/proposal; 1–30 day expiry; immediate revocation and replacement; accepting requires a verified magic link to the invited email, and redemption is bound to it; redeemed links stop working without sign-in; `Referrer-Policy: no-referrer` on invitation pages | Mitigated (AT-001 to AT-004). Residual risk: someone who receives a forwarded link can *read* the proposal until it expires or is revoked. Accepted by the PRD ("invite link grants limited initial access") |
| T11 | Webhook spoofing, replay or payment-state manipulation | Financial loss | Signature verification, idempotent event store, amount and currency matching | Planned for Phase 3 (AT-014 to AT-017) |
| T12 | Malicious or oversized file uploads | Malware, data exposure | Private storage, type and size limits, short-lived signed URLs | Planned for Phase 4 (AT-022) |
| T13 | Prompt injection or cross-client leakage through AI | Data exposure | Permission-scoped retrieval, untrusted-input handling, evaluation set | Planned for Phase 5 (AT-027 to AT-029) |
| T14 | Brute-forcing or flooding public token endpoints | Data exposure, noise in follow-up queues | Infeasible to guess tokens (2^256); malformed tokens are rejected before any DB call; help requests are capped at 2,000 characters and never reveal whether a token exists | Partial: per-IP rate limiting is to be enforced at the hosting edge (Vercel Firewall or equivalent) before the pilot (D-009) |
| T15 | Tampering with prices, totals or accepted terms | Financial and legal loss | Line amounts are derived in SQL (client totals ignored); submitted versions and line items are immutable via triggers; acceptance checks the version ID and SHA-256 terms hash; acceptance is audited as `client` | Mitigated (AT-005 to AT-007) |
| T16 | Unapproved or withdrawn testimonials shown to prospects | Misleading claims, consent breach | Visibility is computed on every read (status, withdrawal, permission expiry, channel); approval requires source and permission evidence; metrics require period and evidence | Mitigated (AT-009) |
