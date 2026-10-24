import { cn } from "@/lib/utils";

export function BrandMark({ className, tone = "default" }: { className?: string; tone?: "default" | "inverse" }) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-heading text-base font-semibold tracking-[0.18em] uppercase",
        tone === "inverse" ? "text-sidebar-foreground" : "text-foreground",
        className,
      )}
    >
      Atmors
      <span className={cn("text-xs tracking-[0.12em]", tone === "inverse" ? "text-sidebar-primary" : "text-brand")}>
        ClientOS
      </span>
    </span>
  );
}
