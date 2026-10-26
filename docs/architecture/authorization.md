# Authorization model

Source: PRD §2 and §11. This document describes what is implemented as of Phase 5.

## Layers

Each request passes these checks in order. No single layer is trusted on its own.

| Layer | Where | What it does |
|---|---|---|
| Proxy | `src/proxy.ts` | Refreshes the session cookie, stamps `x-correlation-id`, and redirects signed-out visitors away from `/dashboard` and `/portal`. This is an optimistic check only. |
| Page / action / route | `memberPageAccess`, `requireMemberContext`, `assertCan` | Verifies the JWT (`getClaims`), loads the active membership and permissions, and rejects with `UNAUTHENTICATED` or `FORBIDDEN`. Every page checks for itself, because layouts don't re-render on client navigation. |
| Row Level Security | `supabase/migrations` | Every public table has RLS. Client roles only get the grants listed in the migration. Most tables are read-only from client sessions. |
| RPC | `public.update_membership`, … | Privileged writes are `SECURITY DEFINER` functions. Each one re-checks permission, validates input, and writes the change, the audit entry and the workflow event in a single transaction. |

The app's runtime uses the publishable key with the user's session for everything except system steps, which use the secret key (`src/server/supabase/admin.ts`) as the PRD's "system worker" identity: invitation sign-in (D-008), recording provider webhooks, and attaching a provider order to a payment the client already created (D-012). Those RPCs (`ingest_payment_event`, `ingest_signature_event`, `attach_payment_order`, `fail_payment_start`, `invitation_contact`) are executable by `service_role` only. The secret key is also used by `scripts/bootstrap.ts` and the tests.

## Clients and prospects

Clients are never organization members, and they never read tables directly.

- **With an invitation link:** a valid token is a 256-bit secret, and only its SHA-256 hash is stored. The holder can call `invitation_view`, which returns a client-safe projection of that one proposal, and `request_invitation_help`. Expired, revoked and unknown tokens return no record data.
- **Signed in:** to accept, the holder verifies the invited email through a magic link. `redeem_invitation` then binds the token to that account (`client_access`) and only succeeds if the signed-in email matches the prospect's email. From then on, `client_proposal_view`, `accept_proposal` and `client_respond_to_proposal` check `client_access`.
- **Sensitive actions (AT-004):** booking a call or asking for help works with the token alone. Signing (`client_prepare_signature`), paying (`client_start_payment`) and anything after acceptance need a signed-in client with `client_access`; signing also requires the signed-in email to be the named signer and the displayed document checksum to match.
- **Phase 3 projections:** `client_meetings`, `client_contracts` / `client_contract_view`, `client_invoices` / `client_invoice_view` and `client_payment_status` return client-safe JSON. Drafts and ready-to-send agreements are invisible to clients. Staff emails and internal IDs other than the record's own are never included.
- **Projection:** the client view (`private.client_proposal_json`) contains only the sent version's terms, line items, schedule and currently visible proof. It never includes internal notes, drafts or internal IDs beyond the proposal itself.

## Roles and permissions (policy v5)

Grants are stored in `role_permissions`. The application only types the keys (`src/server/authorization/permissions.ts`).

The `cto_coo` role is labelled **Founder** in the app (Atmors' second founder holds it); its permissions follow the PRD's CTO/COO.

| Permission | CEO | CTO/COO | Sales | Delivery |
|---|:-:|:-:|:-:|:-:|
| members.read | ✓ | ✓ | | |
| members.manage | | ✓ | | |
| prospects.read_all | ✓ | ✓ | | |
| prospects.write | ✓ | ✓ | | |
| prospects.create | | | ✓ | |
| prospects.write_own | | | ✓ | |
| proposals.read_all | ✓ | | | |
| proposals.manage | ✓ | | | |
| proposals.manage_own | | | ✓ | |
| proposals.approve | ✓ | | | |
| proof.read | ✓ | ✓ | ✓ | |
| proof.manage | ✓ | ✓ | | |
| proof.approve | ✓ | | | |
| pricing.read | ✓ | | | |
| finance.read | ✓ | | | |
| contracts.read | ✓ | | | |
| contracts.manage | ✓ | | | |
| contracts.templates | ✓ | | | |
| billing.manage | ✓ | | | |
| meetings.read_all | ✓ | ✓ | | |
| meetings.manage | ✓ | ✓ | | |
| scheduling.configure | | ✓ | | |
| integrations.monitor | ✓ | ✓ | | |
| operations.manage | | ✓ | | |
| onboarding.manage | ✓ | ✓ | | |
| workspaces.read_all | ✓ | ✓ | | |
| workspaces.manage | | ✓ | | |
| workspaces.override | | ✓ | | |
| knowledge.manage | ✓ | ✓ | | |
| ai.monitor | ✓ | ✓ | | |
| ai.copilot | ✓ | ✓ | ✓ | ✓ |
| system.configure | | ✓ | | |
| audit.read | ✓ | ✓ | | |

Notes:
- The PRD restricts CTO/COO access to sensitive finance and legal records to "when explicitly authorized by policy", so `finance.read` is not granted by default.
- Delivery has no organization-wide grants. Delivery users can read only records they own or are assigned to. Assignment-based access to workspaces arrives in Phase 4.
- `members.manage` sits only with CTO/COO, following PRD §2 ("System configuration, … assignments"). Changing that is a policy decision and needs a migration.
- Members cannot change their own role or status. Because the caller must hold `members.manage`, every organization keeps at least one manager.
- **Sales** (policy v2) can manage only prospects and proposals they own. Sales users have no discount or approval authority, so any version with a discount, non-standard terms or a margin exception waits for a CEO approval (AT-008). No one holds this role by default.
- **CTO/COO** sees every prospect but not proposals or pricing. This follows the PRD, which puts pricing strategy with the CEO. Granting `proposals.read_all` changes that.
- **Phase 3 (policy v3).** Agreements, templates, invoices and payments sit with the CEO (`contracts.*`, `finance.read`, `billing.manage`). The CTO/COO sees activation evaluations (via `operations.manage`) and the provider exception queue (`integrations.monitor`, which returns no amounts or payloads), but not contract terms or invoices. Anyone may host calls: hosts see and manage their own meetings, prospect owners see meetings for their prospects, and only `scheduling.configure` changes who takes which call type.
- **Phase 4 (policy v4): assignment-based access.** Delivery staff hold no organization-wide grants. Being on a workspace team (`workspace_members`) lets them read that workspace, its milestones, tasks and notes, and — only once onboarding is approved — the client's answers and files (`private.can_read_onboarding`). They never gain access to the CRM record, proposals, agreements or invoices; the workspace carries a display name so they don't need it. Task owners move their own tasks; the workspace lead and `workspaces.manage` manage the plan and post client-visible updates. Manual activation (`workspaces.override`) sits with the CTO/COO only and is reasoned, audited and visibly marked (AT-026).
- **Clients** read onboarding and workspace data only through `client_onboarding` and `client_workspace`. Internal tasks, internal notes and blocking reasons never appear there. Files are downloaded through `/api/assets/[id]`, which authorizes and audits the request and redirects to a 60-second signed URL; the storage bucket is private with no storage policies.
- **AI (policy v5).** The model never queries the database. Each request's context is assembled from what the caller can already see: clients get their own proposal projection, approved proof on it and approved client FAQ; staff get their own RLS-bound queries plus approved internal procedures. The copilot is read-only; a suggested task is created only when that member confirms, and the RPC re-checks they can read the prospect. Clients cannot read any AI table; staff read their own copilot conversations; `ai.monitor` reads all for review. Logging and action resolution are service-role only.
- **Ops tasks** are visible to their owner and to holders of the permission matching their visibility: `operations` → `operations.manage`, `commercial` → `prospects.read_all`, `finance` → `finance.read`.
- `_own` permissions are checked against `owner_user_id` inside the RPCs and RLS helpers (`private.can_manage_prospect`, `private.can_manage_proposal`).

## Adding a protected capability

1. Add the permission key to `PERMISSIONS` and seed it in a new migration.
2. Add the RLS policy (`private.has_permission(org, key)`) and the narrowest grant possible.
3. Put multi-record writes in an RPC that re-checks permission and calls `private.write_audit` and `private.write_workflow_event`.
4. Call `assertCan` in the server action or route before calling the RPC, so failures come back as clear errors.
5. Add allowed and denied cases to `tests/security`.
