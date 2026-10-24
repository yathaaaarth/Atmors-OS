# Authorization model

Source: PRD §2 and §11. This document describes what is implemented as of Phase 2.

## Layers

Each request passes these checks in order. No single layer is trusted on its own.

| Layer | Where | What it does |
|---|---|---|
| Proxy | `src/proxy.ts` | Refreshes the session cookie, stamps `x-correlation-id`, and redirects signed-out visitors away from `/dashboard` and `/portal`. This is an optimistic check only. |
| Page / action / route | `memberPageAccess`, `requireMemberContext`, `assertCan` | Verifies the JWT (`getClaims`), loads the active membership and permissions, and rejects with `UNAUTHENTICATED` or `FORBIDDEN`. Every page checks for itself, because layouts don't re-render on client navigation. |
| Row Level Security | `supabase/migrations` | Every public table has RLS. Client roles only get the grants listed in the migration. Most tables are read-only from client sessions. |
| RPC | `public.update_membership`, … | Privileged writes are `SECURITY DEFINER` functions. Each one re-checks permission, validates input, and writes the change, the audit entry and the workflow event in a single transaction. |

The app's runtime uses the publishable key with the user's session for everything except one step: invitation sign-in uses the secret key (`src/server/supabase/admin.ts`) to look up the email an invitation is bound to and to provision that client's account (decision D-008). The secret key is also used by `scripts/bootstrap.ts` and the security tests.

## Clients and prospects

Clients are never organization members, and they never read tables directly.

- **With an invitation link:** a valid token is a 256-bit secret, and only its SHA-256 hash is stored. The holder can call `invitation_view`, which returns a client-safe projection of that one proposal, and `request_invitation_help`. Expired, revoked and unknown tokens return no record data.
- **Signed in:** to accept, the holder verifies the invited email through a magic link. `redeem_invitation` then binds the token to that account (`client_access`) and only succeeds if the signed-in email matches the prospect's email. From then on, `client_proposal_view`, `accept_proposal` and `client_respond_to_proposal` check `client_access`.
- **Projection:** the client view (`private.client_proposal_json`) contains only the sent version's terms, line items, schedule and currently visible proof. It never includes internal notes, drafts or internal IDs beyond the proposal itself.

## Roles and permissions (policy v2)

Grants are stored in `role_permissions`. The application only types the keys (`src/server/authorization/permissions.ts`).

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
| contracts.manage | ✓ | | | |
| operations.manage | | ✓ | | |
| system.configure | | ✓ | | |
| audit.read | ✓ | ✓ | | |

Notes:
- The PRD restricts CTO/COO access to sensitive finance and legal records to "when explicitly authorized by policy", so `finance.read` is not granted by default.
- Delivery has no organization-wide grants. Delivery users can read only records they own or are assigned to. Assignment-based access to workspaces arrives in Phase 4.
- `members.manage` sits only with CTO/COO, following PRD §2 ("System configuration, … assignments"). Changing that is a policy decision and needs a migration.
- Members cannot change their own role or status. Because the caller must hold `members.manage`, every organization keeps at least one manager.
- **Sales** (policy v2) can manage only prospects and proposals they own. Sales users have no discount or approval authority, so any version with a discount, non-standard terms or a margin exception waits for a CEO approval (AT-008). No one holds this role by default.
- **CTO/COO** sees every prospect but not proposals or pricing. This follows the PRD, which puts pricing strategy with the CEO. Granting `proposals.read_all` changes that.
- `_own` permissions are checked against `owner_user_id` inside the RPCs and RLS helpers (`private.can_manage_prospect`, `private.can_manage_proposal`).

## Adding a protected capability

1. Add the permission key to `PERMISSIONS` and seed it in a new migration.
2. Add the RLS policy (`private.has_permission(org, key)`) and the narrowest grant possible.
3. Put multi-record writes in an RPC that re-checks permission and calls `private.write_audit` and `private.write_workflow_event`.
4. Call `assertCan` in the server action or route before calling the RPC, so failures come back as clear errors.
5. Add allowed and denied cases to `tests/security`.
