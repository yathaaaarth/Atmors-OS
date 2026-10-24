import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { memberPageAccess } from "./member-page";

export const metadata: Metadata = { title: "Work queue" };

// Queues listed in PRD §5.9. Each becomes live as its module ships.
const UPCOMING_QUEUES = [
  { title: "Follow-ups due", phase: "Phase 2" },
  { title: "Unresolved proposals", phase: "Phase 2" },
  { title: "Meetings today", phase: "Phase 3" },
  { title: "Contracts awaiting signature", phase: "Phase 3" },
  { title: "Overdue or failed invoices", phase: "Phase 3" },
  { title: "Onboarding blockers", phase: "Phase 4" },
  { title: "Kickoff-ready clients", phase: "Phase 4" },
  { title: "Overdue delivery tasks", phase: "Phase 4" },
];

export default async function WorkQueuePage() {
  const access = await memberPageAccess("/dashboard");
  if (!access.allowed) return <AccessDenied />;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Work queue</h1>
        <p className="text-sm text-muted-foreground">
          Welcome, {access.context.displayName}. Nothing needs your attention yet. Queues will appear here as each
          module goes live.
        </p>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2">
        {UPCOMING_QUEUES.map((queue) => (
          <li key={queue.title}>
            <Card className="h-full border-dashed bg-transparent shadow-none">
              <CardHeader>
                <CardTitle className="text-sm font-medium">{queue.title}</CardTitle>
                <CardDescription>Arrives in {queue.phase}</CardDescription>
              </CardHeader>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
