import { redirect } from "next/navigation";

import { BrandMark } from "@/components/brand";
import { getMemberContext } from "@/server/authorization/member-context";
import { can, ROLE_LABELS } from "@/server/authorization/permissions";

import { DashboardNav, type NavItem } from "./dashboard-nav";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const result = await getMemberContext();
  if (result.status === "unauthenticated") redirect("/login?next=/dashboard");
  // Clients who sign in land here by default; their home is the portal.
  if (result.status === "not_member") redirect("/portal");

  const { context } = result;
  // Navigation only reflects permissions; each page enforces them itself.
  const items: NavItem[] = [{ href: "/dashboard", label: "Work queue" }];
  if (can(context, "prospects.read_all") || can(context, "prospects.create") || can(context, "prospects.write_own")) {
    items.push({ href: "/dashboard/prospects", label: "Prospects" });
  }
  if (can(context, "proposals.read_all") || can(context, "proposals.manage") || can(context, "proposals.manage_own")) {
    items.push({ href: "/dashboard/proposals", label: "Proposals" });
  }
  // Everyone may host calls; the page shows only meetings RLS lets them read.
  items.push({ href: "/dashboard/meetings", label: "Meetings" });
  if (can(context, "contracts.read")) items.push({ href: "/dashboard/contracts", label: "Agreements" });
  if (can(context, "finance.read") || can(context, "integrations.monitor")) {
    items.push({ href: "/dashboard/billing", label: "Billing" });
  }
  if (can(context, "proof.read")) items.push({ href: "/dashboard/proof", label: "Proof library" });
  if (can(context, "members.read")) items.push({ href: "/dashboard/team", label: "Team" });
  if (can(context, "audit.read")) items.push({ href: "/dashboard/audit", label: "Audit log" });

  return (
    <div className="flex flex-1 flex-col md:flex-row">
      <aside className="flex flex-col gap-4 bg-sidebar px-4 py-4 text-sidebar-foreground md:w-60 md:shrink-0 md:py-6">
        <div className="flex items-center justify-between md:block">
          <BrandMark tone="inverse" />
          <p className="text-xs text-sidebar-foreground/70 md:mt-1">{context.organizationName}</p>
        </div>
        <DashboardNav items={items} />
        <div className="mt-auto hidden border-t border-sidebar-border pt-4 text-sm md:block">
          <p className="truncate font-medium">{context.displayName}</p>
          <p className="text-xs text-sidebar-foreground/70">{ROLE_LABELS[context.role]}</p>
          <form action="/auth/signout" method="post" className="mt-3">
            <button
              type="submit"
              className="text-xs text-sidebar-foreground/80 underline underline-offset-4 hover:text-sidebar-foreground"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <main id="main" className="flex-1 px-4 py-6 md:px-8 md:py-8">
        {children}
      </main>
    </div>
  );
}
