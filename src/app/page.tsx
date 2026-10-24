import Link from "next/link";

import { BrandMark } from "@/components/brand";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-8 px-4 py-16">
      <BrandMark />
      <div className="space-y-3">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">
          Your engagement with Atmors, in one place.
        </h1>
        <p className="text-muted-foreground">
          Clients reach their proposal and onboarding through the secure link Atmors sends them. Team members sign in
          below.
        </p>
      </div>
      <div>
        <Button asChild size="lg">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    </main>
  );
}
