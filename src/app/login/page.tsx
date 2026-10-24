import type { Metadata } from "next";

import { BrandMark } from "@/components/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeRedirectPath } from "@/lib/safe-redirect";

import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

const ERROR_MESSAGES: Record<string, string> = {
  link_invalid: "That sign-in link is invalid or has expired. Request a new one below.",
  signed_out: "You have been signed out.",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const searchParams = await props.searchParams;
  const next = typeof searchParams.next === "string" ? safeRedirectPath(searchParams.next) : undefined;
  const notice = typeof searchParams.error === "string" ? ERROR_MESSAGES[searchParams.error] : undefined;

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-6 px-4 py-12">
      <BrandMark />
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="font-heading text-xl font-semibold">Sign in</h1>
          </CardTitle>
          <CardDescription>We&apos;ll email you a secure, single-use sign-in link.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notice ? (
            <p role="status" className="rounded-md border bg-muted px-3 py-2 text-sm">
              {notice}
            </p>
          ) : null}
          <LoginForm next={next} />
        </CardContent>
      </Card>
    </main>
  );
}
