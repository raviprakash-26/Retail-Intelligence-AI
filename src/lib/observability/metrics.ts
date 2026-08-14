/**
 * Counters an operator can scrape.
 *
 * Deliberately small and deliberately honest about what it is: an in-process
 * registry. The counts live in the memory of one Node process, they reset when
 * it restarts, and two replicas each report their own. That is a real
 * limitation and it is the *same* limitation this product already documents for
 * in-memory rate limiting — it would be worse to imply otherwise by shipping
 * something that looks like a cluster-wide metric and is not.
 *
 * Prometheus text format because it is what scrapers read without
 * configuration, and because it is legible to a person running `curl` at three
 * in the morning, which is when this gets used.
 *
 * Nothing here counts anything about a tenant's business. Turnover, invoice
 * counts and stock values are the tenant's data, and an endpoint an operator
 * scrapes is exactly the wrong place for them — the platform-administration
 * module was built on the principle that running the service does not require
 * reading anybody's books, and metrics do not get an exemption.
 */

export type MetricLabels = Record<string, string>;

type Sample = { labels: MetricLabels; value: number };

type Metric = {
  name: string;
  help: string;
  type: "counter" | "gauge";
  samples: Map<string, Sample>;
};

const registry = new Map<string, Metric>();

/** Stable key for a label set, so the same labels always hit the same sample. */
function labelKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function metric(name: string, help: string, type: Metric["type"]): Metric {
  const existing = registry.get(name);
  if (existing) return existing;
  const created: Metric = { name, help, type, samples: new Map() };
  registry.set(name, created);
  return created;
}

export function incrementCounter(
  name: string,
  help: string,
  labels: MetricLabels = {},
  by = 1,
): void {
  const target = metric(name, help, "counter");
  const key = labelKey(labels);
  const sample = target.samples.get(key);
  if (sample) sample.value += by;
  else target.samples.set(key, { labels, value: by });
}

export function setGauge(
  name: string,
  help: string,
  value: number,
  labels: MetricLabels = {},
): void {
  const target = metric(name, help, "gauge");
  target.samples.set(labelKey(labels), { labels, value });
}

/** Everything currently registered, for a test or a scrape. */
export function snapshot(): Array<{
  name: string;
  type: string;
  samples: Sample[];
}> {
  return [...registry.values()].map((entry) => ({
    name: entry.name,
    type: entry.type,
    samples: [...entry.samples.values()],
  }));
}

/** Only for tests: a registry that persists between them proves nothing. */
export function resetMetrics(): void {
  registry.clear();
}

/**
 * A label value that cannot break the exposition format.
 *
 * Label values are quoted, so a backslash, a quote or a newline inside one
 * would produce a line the scraper rejects — and label values here come from
 * things like module names and error codes, which are not guaranteed to stay
 * boring forever.
 */
function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n");
}

function renderLabels(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  const rendered = entries
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
  return `{${rendered}}`;
}

/** The registry as Prometheus text exposition. */
export function renderPrometheus(): string {
  const lines: string[] = [];

  for (const entry of [...registry.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    lines.push(`# HELP ${entry.name} ${entry.help}`);
    lines.push(`# TYPE ${entry.name} ${entry.type}`);
    for (const sample of entry.samples.values()) {
      lines.push(`${entry.name}${renderLabels(sample.labels)} ${sample.value}`);
    }
  }

  // A trailing newline is required by the format.
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// ---------------------------------------------------------------------------
// The handful this product actually records
// ---------------------------------------------------------------------------

export const METRIC = {
  actionFailures: "riai_action_failures_total",
  reportExports: "riai_report_exports_total",
  documentsPosted: "riai_documents_posted_total",
} as const;

/**
 * A server action failed unexpectedly.
 *
 * Only the module and a code — never the tenant, never the message. "Sales
 * actions are failing" is an operational fact worth paging on; *whose* sale
 * failed is in the tenant's own audit log, where it belongs.
 */
export function recordActionFailure(module: string, code: string): void {
  incrementCounter(
    METRIC.actionFailures,
    "Server actions that failed unexpectedly, by module.",
    { module, code },
  );
}

/** A document was posted. Counts only the kind, not the value or the tenant. */
export function recordDocumentPosted(kind: string): void {
  incrementCounter(
    METRIC.documentsPosted,
    "Documents posted successfully, by kind.",
    { kind },
  );
}

export function recordReportExport(report: string): void {
  incrementCounter(
    METRIC.reportExports,
    "Reports exported as a file, by report.",
    { report },
  );
}
