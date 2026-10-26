import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { PublicShell } from "@/components/public-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { verifiedAssuranceLevel } from "@/server/auth/mfa";
import { getSessionUser } from "@/server/auth/session";
import { createSupabaseServerClient } from "@/server/supabase/server";

import { verifyTotp } from "../dashboard/security/actions";
import { MfaChallengeForm } from "./challenge-form";

export const metadata: Metadata = { title: "Verify it's you" };

/** Second-factor challenge before the dashboard (AAL2). */
export default async function MfaPage(props: PageProps<"/mfa">) {
  const user = await getSessionUser();
  if (!user) redirect("/login?next=/dashboard");
  const params = await props.searchParams;
  const next = safeRedirectPath(typeof params.next === "string" ? params.next : "/dashboard");
  const { data: level } = await verifiedAssuranceLevel();
  if (level?.currentLevel === "aal2") redirect(next);
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.mfa.listFactors();
  const factor = (data?.totp ?? []).find((item) => item.status === "verified");
  if (!factor) redirect("/dashboard/security?setup=1");

  return (
    <PublicShell>
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="font-heading text-xl font-semibold">Verify it&apos;s you</h1>
          </CardTitle>
          <CardDescription>Enter the 6-digit code from your authenticator app.</CardDescription>
        </CardHeader>
        <CardContent>
          <MfaChallengeForm factorId={factor.id} next={next} verify={verifyTotp} />
        </CardContent>
      </Card>
    </PublicShell>
  );
}
