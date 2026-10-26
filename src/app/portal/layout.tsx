import { BrandMark } from "@/components/brand";

export default function PortalLayout({ children }: LayoutProps<"/portal">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b bg-card print:hidden">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-3">
          <BrandMark />
          <form action="/auth/signout" method="post">
            <button type="submit" className="text-sm text-muted-foreground underline underline-offset-4">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8">
        {children}
      </main>
      <footer className="border-t print:hidden">
        <p className="mx-auto max-w-3xl px-4 py-4 text-xs text-muted-foreground">
          Questions at any stage? Reply to your Atmors email and a team member will help.
        </p>
      </footer>
    </div>
  );
}
