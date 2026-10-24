import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSessionUser } from "@/server/auth/session";

export const metadata: Metadata = { title: "Your portal" };

const JOURNEY = ["Proposal", "Agreement", "Payment", "Onboarding", "Kickoff"];

export default async function PortalHomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/portal");

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Your Atmors portal</h1>
        <p className="text-sm text-muted-foreground">
          Nothing has been shared with you yet. When Atmors sends a proposal, it will appear here.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How it works</CardTitle>
          <CardDescription>You can pause at any step, ask questions or book a call. Your progress is kept.</CardDescription>
        </CardHeader>
        <ol className="grid gap-2 px-6 pb-6 sm:grid-cols-5">
          {JOURNEY.map((step, index) => (
            <li key={step} className="rounded-md border px-3 py-2 text-sm">
              <span className="block text-xs text-muted-foreground">Step {index + 1}</span>
              {step}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
