import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { ActionForm } from "@/components/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { memberPageAccess } from "../member-page";
import { removeFactor, startTotpEnrollment, verifyTotp } from "./actions";
import { TotpSetup } from "./totp-setup";

export const metadata: Metadata = { title: "Account security" };

const dateFormat = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

export default async function SecurityPage(props: PageProps<"/dashboard/security">) {
  // Reachable before MFA so members can enroll.
  const access = await memberPageAccess("/dashboard/security", undefined, { allowWithoutMfa: true });
  if (!access.allowed) return <AccessDenied />;
  const params = await props.searchParams;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factors = (data?.all ?? []).filter((factor) => factor.status === "verified");
  const required = process.env.REQUIRE_STAFF_MFA === "true";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">Account security</h1>
        <p className="text-sm text-muted-foreground">
          Staff accounts can reach client and financial records, so they use a second factor: a code from an authenticator app at
          each sign-in.
        </p>
      </header>
      {params.setup === "1" ? (
        <p role="alert" className="rounded-lg border border-amber-500/50 p-3 text-sm">
          Set up an authenticator to continue to the dashboard.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Authenticator app</CardTitle>
          <CardDescription>{required ? "Required for all staff." : "Strongly recommended; required before the pilot."}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {factors.length > 0 ? (
            <ul className="space-y-2 text-sm">
              {factors.map((factor) => (
                <li key={factor.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {factor.friendly_name ?? "Authenticator"} · added {dateFormat.format(new Date(factor.created_at))}
                  </span>
                  {!required ? (
                    <ActionForm action={removeFactor} submitLabel="Remove" variant="outline" confirmMessage="Remove this authenticator?">
                      <input type="hidden" name="factorId" value={factor.id} />
                    </ActionForm>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <TotpSetup start={startTotpEnrollment} verify={verifyTotp} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
