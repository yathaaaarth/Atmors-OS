# Authorization model

Source: PRD §2 and §11. This document describes what is implemented as of Phase 1.

## Layers

Each request passes these checks in order. No single layer is trusted on its own.

| Layer | Where | What it does |
|---|---|---|
| Proxy | `src/proxy.ts` | Refreshes the session cookie, stamps `x-correlation-id`, and redirects signed-out visitors away from `/dashboard` and `/portal`. This is an optimistic check only. |
| Page / action / route | `memberPageAccess`, `requireMemberContext`, `assertCan` | Verifies the JWT (`getClaims`), loads the active membership and permissions, and rejects with `UNAUTHENTICATED` or `FORBIDDEN`. Every page checks for itself, because layouts don't re-render on client navigation. |
| Row Level Security | `supabase/migrations` | Every public table has RLS. Client roles only get the grants listed in the migration. Most tables are read-only from client sessions. |
| RPC | `public.update_membership`, … | Privileged writes are `SECURITY DEFINER` functions. Each one re-checks permission, validates input, and writes the change, the audit entry and the workflow event in a single transaction. |

The app's runtime only uses the publishable key with the user's session. The secret key is used only by `scripts/bootstrap.ts` and the security tests.

## Roles and permissions (policy v1)

Grants are stored in `role_permissions`. The application only types the keys (`src/server/authorization/permissions.ts`).

| Permission | CEO | CTO/COO | Delivery |
|---|:-:|:-:|:-:|
| members.read | ✓ | ✓ | |
| members.manage | | ✓ | |
| prospects.read_all | ✓ | ✓ | |
| prospects.write | ✓ | ✓ | |
| proposals.manage | ✓ | | |
| proposals.approve | ✓ | | |
| pricing.read | ✓ | | |
| finance.read | ✓ | | |
| contracts.manage | ✓ | | |
| operations.manage | | ✓ | |
| system.configure | | ✓ | |
| audit.read | ✓ | ✓ | |

Notes:
- The PRD restricts CTO/COO access to sensitive finance and legal records to "when explicitly authorized by policy", so `finance.read` is not granted by default.
- Delivery has no organization-wide grants. Delivery users can read only records they own or are assigned to. Assignment-based access to workspaces arrives in Phase 4.
- `members.manage` sits only with CTO/COO, following PRD §2 ("System configuration, … assignments"). Changing that is a policy decision and needs a migration.
- Members cannot change their own role or status. Because the caller must hold `members.manage`, every organization keeps at least one manager.
- Clients and prospects are not organization members. Their scoped access (invitations, then authenticated client accounts) arrives in Phase 2.

## Adding a protected capability

1. Add the permission key to `PERMISSIONS` and seed it in a new migration.
2. Add the RLS policy (`private.has_permission(org, key)`) and the narrowest grant possible.
3. Put multi-record writes in an RPC that re-checks permission and calls `private.write_audit` and `private.write_workflow_event`.
4. Call `assertCan` in the server action or route before calling the RPC, so failures come back as clear errors.
5. Add allowed and denied cases to `tests/security`.
