# Atmors ClientOS

This is the client conversion portal and internal operations dashboard for Atmors. The source of truth for scope and behaviour is [`Atmors_ClientOS_Final_PRD_v1.0.pdf`](Atmors_ClientOS_Final_PRD_v1.0.pdf).

**Status:** Phase 1 (Foundation). It includes auth, roles, RLS, an append-only audit log, workflow events, the error envelope, the design tokens, and the dashboard and portal shells.

## Stack

Next.js 16 (App Router, `src/proxy.ts`), React 19, TypeScript, Tailwind v4 with shadcn/ui, React Hook Form with Zod, and Supabase (Postgres, Auth, RLS) on a hosted project. Tests use Vitest and Playwright. Decisions are recorded in [`docs/decisions`](docs/decisions/README.md).

## First-time setup (hosted Supabase)

1. **Create a dev project** at [supabase.com](https://supabase.com/dashboard). Region `ap-south-1` (Mumbai) is the closest. Use a separate project for staging and for production later.
2. **Configure Auth** under Authentication → Sign In / Providers and URL Configuration:
   - Turn **off** "Allow new users to sign up". Accounts are invite-only.
   - Site URL: `http://localhost:3000`
   - Redirect URLs: `http://localhost:3000/auth/callback`, `http://localhost:3000/auth/confirm`
3. **Fill in the environment.** Copy `.env.example` to `.env.local` and paste the project URL, the publishable key and the secret key from Project Settings → API Keys.
4. **Apply the migrations:**
   ```sh
   npx supabase login
   npm run db:link -- --project-ref <your-project-ref>
   npm run db:push
   ```
5. **Create the organization and the first admin:**
   ```sh
   npm run bootstrap -- --email you@example.com --name "Your Name" --role cto_coo
   ```
   Repeat the command for each teammate with `--role ceo` or `--role delivery`.
6. **Run the app:** `npm run dev`, then sign in at http://localhost:3000/login with the magic link.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run check` | Lint, typecheck and unit tests |
| `npm test` | Unit tests (`tests/unit`) |
| `npm run test:security` | RLS and authorization tests against the **dev** Supabase project (`tests/security`). Skipped when keys are absent. |
| `npm run test:e2e` | Playwright smoke tests at desktop and mobile widths (run `npm run build` first) |
| `npm run db:push` | Apply new migrations to the linked project |
| `npm run db:types` | Regenerate `src/server/supabase/database.types.ts` from the linked project |
| `npm run bootstrap` | Create the organization and grant or update a team member's role (audited) |

## Layout

```
src/
  app/                  routes: /login, /auth/*, /dashboard (internal), /portal (client), /api/*
  components/           shared UI (shadcn in components/ui)
  modules/<domain>/     domain logic per PRD module (crm so far)
  server/
    auth/               session (verified JWT)
    authorization/      permissions, member context
    actions/, http/     server action / route wrappers -> stable error envelope
    workflows/          state machine helper
    supabase/           clients + database types
    errors.ts, logger.ts, correlation.ts
supabase/migrations/    versioned schema, RLS policies, RPCs
tests/{unit,security,e2e}
docs/{architecture,decisions}
```

## Conventions

- **Authorization goes on every server path.** Pages call `memberPageAccess`. Actions and routes call `requireMemberContext` and `assertCan`. Hiding a button is not authorization.
- **Privileged or multi-record writes go through an RPC.** The RPC re-checks permission and writes the audit entry and workflow event in the same transaction. See [`docs/architecture/authorization.md`](docs/architecture/authorization.md).
- **Never trust the client** for role, ownership, status, payment or acceptance state.
- **Errors use the stable envelope:** `{ error: { code, message, field_errors?, correlation_id, retryable } }`.
- **Money is integer minor units plus currency.** Timestamps are UTC, with an IANA timezone stored for display.
- **The definition of done is PRD §15.** Normal and failure paths work, authorization is tested, jobs are idempotent, and the mobile and accessibility states are covered.
