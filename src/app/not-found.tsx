import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-3 px-4 py-16">
      <h1 className="font-heading text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        The page may have moved, or the link may be incomplete.
      </p>
      <Link href="/" className="text-sm font-medium text-brand underline underline-offset-4">
        Go to the start page
      </Link>
    </main>
  );
}
