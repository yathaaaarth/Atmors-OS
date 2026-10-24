import { compareVersions, type ClientProof, type ClientVersion } from "@/modules/proposals/client-view";
import { formatMoney, scheduleAmounts } from "@/modules/proposals/money";
import { BILLING_TIMING_LABELS, SCHEDULE_DUE_LABELS } from "@/modules/proposals/schema";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Paragraphs({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index} className="whitespace-pre-line">
          {paragraph}
        </p>
      ))}
    </div>
  );
}

function Bullets({ items }: { items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(date);
}

/**
 * Renders exactly the client-visible terms of one proposal version. Used for
 * the invitation page, the client portal and the internal preview so every
 * audience sees the same document.
 */
export function ProposalDocument({
  title,
  version,
  previousVersion,
  proof,
  preparedFor,
  organizationName,
}: {
  title: string;
  version: ClientVersion;
  previousVersion?: ClientVersion | null;
  proof: ClientProof[];
  preparedFor?: string;
  organizationName?: string | null;
}) {
  const { content, currency } = version;
  const changes = previousVersion ? compareVersions(previousVersion, version) : [];
  const instalments = scheduleAmounts(version.payment_schedule, version.total_minor);

  return (
    <article className="space-y-8">
      <header className="space-y-2">
        <p className="text-xs font-medium tracking-wide text-brand uppercase">
          {organizationName ?? "Atmors"} · Proposal{preparedFor ? ` for ${preparedFor}` : ""}
        </p>
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
          <div>
            <dt className="inline">Version </dt>
            <dd className="inline font-medium text-foreground">{version.version_number}</dd>
          </div>
          <div>
            <dt className="inline">Valid until </dt>
            <dd className="inline font-medium text-foreground">
              {formatDate(version.valid_until)}
              {version.is_expired ? " (expired)" : ""}
            </dd>
          </div>
          {version.sent_at ? (
            <div>
              <dt className="inline">Sent </dt>
              <dd className="inline font-medium text-foreground">{formatDate(version.sent_at)}</dd>
            </div>
          ) : null}
        </dl>
      </header>

      {previousVersion ? (
        <aside className="space-y-2 rounded-lg border border-brand/30 bg-accent/50 p-4" aria-label="What changed">
          <p className="text-sm font-semibold">
            What changed since version {previousVersion.version_number}
          </p>
          {version.change_summary ? <p className="text-sm">{version.change_summary}</p> : null}
          {changes.length > 0 ? <Bullets items={changes} /> : null}
        </aside>
      ) : null}

      {content.summary ? (
        <Section title="Summary">
          <Paragraphs text={content.summary} />
        </Section>
      ) : null}
      {content.scope ? (
        <Section title="Scope">
          <Paragraphs text={content.scope} />
        </Section>
      ) : null}
      {content.deliverables?.length ? (
        <Section title="Deliverables">
          <Bullets items={content.deliverables} />
        </Section>
      ) : null}
      {content.timeline ? (
        <Section title="Timeline">
          <Paragraphs text={content.timeline} />
        </Section>
      ) : null}
      {content.dependencies?.length ? (
        <Section title="What we need from you">
          <Bullets items={content.dependencies} />
        </Section>
      ) : null}
      {content.assumptions?.length ? (
        <Section title="Assumptions">
          <Bullets items={content.assumptions} />
        </Section>
      ) : null}
      {content.exclusions?.length ? (
        <Section title="Not included">
          <Bullets items={content.exclusions} />
        </Section>
      ) : null}

      <Section title="Investment">
        <ul className="divide-y rounded-lg border bg-card">
          {version.line_items.map((line, index) => (
            <li key={index} className="grid gap-1 p-4 sm:grid-cols-[1fr_auto] sm:gap-4">
              <div className="space-y-1">
                <p className="font-medium">{line.title}</p>
                {line.description ? (
                  <p className="text-sm whitespace-pre-line text-muted-foreground">{line.description}</p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {line.quantity} {line.unit ?? "×"} at {formatMoney(line.unit_amount_minor, currency)}
                  {line.discount_minor > 0 ? ` · discount ${formatMoney(line.discount_minor, currency)}` : ""}
                  {` · tax ${line.tax_rate_bps / 100}%`}
                  {` · ${BILLING_TIMING_LABELS[line.billing_timing as keyof typeof BILLING_TIMING_LABELS] ?? line.billing_timing}`}
                </p>
              </div>
              <p className="font-medium tabular-nums sm:text-right">{formatMoney(line.total_minor, currency)}</p>
            </li>
          ))}
        </ul>
        <dl className="ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm tabular-nums">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="text-right">{formatMoney(version.subtotal_minor, currency)}</dd>
          {version.discount_minor > 0 ? (
            <>
              <dt className="text-muted-foreground">Discount</dt>
              <dd className="text-right">−{formatMoney(version.discount_minor, currency)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Tax</dt>
          <dd className="text-right">{formatMoney(version.tax_minor, currency)}</dd>
          <dt className="border-t pt-1 font-semibold">Total</dt>
          <dd className="border-t pt-1 text-right font-semibold">{formatMoney(version.total_minor, currency)}</dd>
        </dl>
        <p className="text-xs text-muted-foreground">
          Amounts in {currency}. Tax is shown per line as quoted; final invoices follow the agreed tax treatment.
        </p>
      </Section>

      {version.payment_schedule.length > 0 ? (
        <Section title="Payment schedule">
          <ol className="space-y-2 text-sm">
            {version.payment_schedule.map((item, index) => (
              <li key={index} className="flex flex-wrap justify-between gap-2 rounded-md border px-3 py-2">
                <span>
                  <span className="font-medium">{item.label}</span>
                  <span className="text-muted-foreground">
                    {" · "}
                    {item.due === "on_date" && item.due_date
                      ? `due ${formatDate(item.due_date)}`
                      : item.due === "on_milestone" && item.milestone
                        ? `on ${item.milestone}`
                        : SCHEDULE_DUE_LABELS[item.due].toLowerCase()}
                  </span>
                </span>
                <span className="tabular-nums">
                  {formatMoney(instalments[index] ?? 0, currency)}
                  {item.basis === "percent" ? ` (${item.percent_bps / 100}%)` : ""}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      {content.terms ? (
        <Section title="Terms">
          <Paragraphs text={content.terms} />
        </Section>
      ) : null}

      {proof.length > 0 ? (
        <Section title="Relevant work">
          <ul className="grid gap-3 sm:grid-cols-2">
            {proof.map((item) => (
              <li key={item.id} className="space-y-2 rounded-lg border bg-card p-4 text-sm">
                <p className="font-medium">{item.title}</p>
                {item.quote ? <blockquote className="border-l-2 pl-3 italic">“{item.quote}”</blockquote> : null}
                {item.author_name ? (
                  <p className="text-xs text-muted-foreground">
                    {[item.author_name, item.author_role, item.company_name].filter(Boolean).join(", ")}
                  </p>
                ) : null}
                {item.narrative ? <p className="line-clamp-6 whitespace-pre-line">{item.narrative}</p> : null}
                {item.metrics.length > 0 ? (
                  <ul className="space-y-1">
                    {item.metrics.map((metric, index) => (
                      <li key={index}>
                        <span className="font-medium">{metric.value}</span> {metric.label}{" "}
                        <span className="text-xs text-muted-foreground">
                          ({metric.kind === "measured" ? "measured" : "client-reported"}, {metric.period})
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </article>
  );
}
