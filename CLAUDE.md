@AGENTS.md

# Atmors ClientOS

- The PRD (`Atmors_ClientOS_Final_PRD_v1.0.pdf`) is the source of truth. Phase scope and exit criteria are in PRD §17. Acceptance tests AT-001 to AT-035 are in §14.
- Follow the conventions in `README.md` and the authorization model in `docs/architecture/authorization.md`.
- Every schema change is a new file in `supabase/migrations/`. Never edit an applied migration. Update `src/server/supabase/database.types.ts` to match, or run `npm run db:types`.
- New permissions: add the key to `src/server/authorization/permissions.ts`, seed it in a migration, add RLS, and add allowed and denied tests in `tests/security`.
- Record non-obvious technical decisions in `docs/decisions/README.md`.
- Run `npm run check` before calling work done; it includes `tests/db`, which applies every migration to PGlite. Run `npm run test:security` when a change touches RLS, RPCs or grants.
- Clients never read tables directly. Client-facing data comes from RPC projections (`private.client_proposal_json`). Keep internal fields out of them.
- PostgREST embeds between `proposals` and `proposal_versions` need an explicit foreign-key hint (for example `proposals!proposal_versions_proposal_id_fkey(...)`).
