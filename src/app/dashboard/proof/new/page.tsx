import type { Metadata } from "next";

import { AccessDenied } from "@/components/access-denied";
import { Card, CardContent } from "@/components/ui/card";

import { memberPageAccess } from "../../member-page";
import { ProofForm } from "../proof-form";

export const metadata: Metadata = { title: "Add proof" };

export default async function NewProofPage() {
  const access = await memberPageAccess("/dashboard/proof/new", "proof.manage");
  if (!access.allowed) return <AccessDenied />;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-heading text-2xl font-semibold tracking-tight">Add proof</h1>
      <Card>
        <CardContent className="pt-6">
          <ProofForm />
        </CardContent>
      </Card>
    </div>
  );
}
