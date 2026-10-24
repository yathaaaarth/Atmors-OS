import { redirect } from "next/navigation";

import { AccessDenied } from "@/components/access-denied";
import { BrandMark } from "@/components/brand";
import { getMemberContext } from "@/server/authorization/member-context";
import { can, ROLE_LABELS } from "@/server/authorization/permissions";

import { DashboardNav, type NavItem } from "./dashboard-nav";

export default async function DashboardLayout({ children }: LayoutProps<"/dashboard">) {
  const result = await getMemberContext();
  if (result.status === "unauthenticated") redirect("/login?next=/dashboard");
  if (result.status === "not_member") {
    return (
      <main className="flex flex-1 items-center px-4 py-16">
        <AccessDenied description="The internal dashboard is for Atmors team members. Clients reach their portal through the link Atmors sent them." />
      </main>
    );
  }

  const { context } = result;
  // Navigation only reflects permissions; each page enforces them itself.
  const items: NavItem[] = [{ href: "/dashboard", label: "Work queue" }];
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
