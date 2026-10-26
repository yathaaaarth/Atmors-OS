import { BrandMark } from "@/components/brand";

/** Minimal frame for pages reached by invitation link (no account navigation). */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-card">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          <BrandMark />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 space-y-8 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
