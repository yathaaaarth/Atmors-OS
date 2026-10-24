"use client";

import { Button } from "@/components/ui/button";

export default function ErrorBoundary({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-3 px-4 py-16" role="alert">
      <h1 className="font-heading text-2xl font-semibold">Something went wrong</h1>
      <p className="text-sm text-muted-foreground">
        Nothing you entered was lost on our side. Try again, and if it keeps happening, contact Atmors
        {error.digest ? (
          <>
            {" "}
            with reference <code className="text-xs">{error.digest}</code>
          </>
        ) : null}
        .
      </p>
      <div>
        <Button onClick={reset}>Try again</Button>
      </div>
    </main>
  );
}
