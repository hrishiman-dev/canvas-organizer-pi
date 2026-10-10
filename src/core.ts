export type PlannerItem = {
  id: string;
  type: string;
  title: string;
  course: string;
  dueAt: string | null;
  completed: boolean;
  submitted: boolean;
  pointsPossible: number | null;
  url: string | null;
};

type CanvasPlannerRecord = Record<string, any>;

export function safeCanvasText(value: unknown, fallback = "Untitled", maxLength = 300): string {
  if (typeof value !== "string") return fallback;
  const withoutMarkup = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  const cleaned = withoutMarkup
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLength) || fallback;
}

export function normalizeCanvasOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("CANVAS_BASE_URL must use HTTPS.");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function parseLinkHeader(header: string | null): Record<string, string> {
  if (!header) return {};
  const links: Record<string, string> = {};
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

export function normalizePlannerItem(raw: CanvasPlannerRecord): PlannerItem {
  const plannable = raw.plannable ?? {};
  const submission = raw.submissions ?? plannable.submission ?? null;
  const completed = Boolean(
    raw.planner_override?.marked_complete ||
      submission?.submitted ||
      submission?.graded ||
      submission?.workflow_state === "submitted" ||
      submission?.workflow_state === "graded",
  );

  return {
    id: String(raw.plannable_id ?? plannable.id ?? raw.id ?? "unknown"),
    type: safeCanvasText(raw.plannable_type ?? raw.type ?? "item", "item"),
    title: safeCanvasText(plannable.title ?? plannable.name ?? raw.title),
    course: safeCanvasText(raw.context?.name ?? raw.context_name ?? "Canvas", "Canvas"),
    dueAt: raw.plannable_date ?? plannable.due_at ?? plannable.todo_date ?? null,
    completed,
    submitted: Boolean(submission?.submitted || submission?.submitted_at || submission?.graded || submission?.workflow_state === "submitted" || submission?.workflow_state === "graded"),
    pointsPossible: typeof plannable.points_possible === "number" ? plannable.points_possible : null,
    url: typeof plannable.html_url === "string" ? plannable.html_url : typeof raw.html_url === "string" ? raw.html_url : null,
  };
}

export function formatAgenda(items: PlannerItem[], now = new Date()): string {
  const timeZone = process.env.ORGANIZER_TIMEZONE || "America/Chicago";
  const actionable = items
    .filter((item) => !item.completed)
    .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"));

  if (!actionable.length) return "No incomplete Canvas items found in this window.";

  const today = localDay(now, timeZone);
  const groups = new Map<string, PlannerItem[]>();
  for (const item of actionable) {
    const key = item.dueAt ? localDay(new Date(item.dueAt), timeZone) : "No due date";
    const label = key === today ? "Today" : key;
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }

  const lines: string[] = [];
  for (const [day, entries] of groups) {
    lines.push(`${day}:`);
    for (const item of entries) {
      const time = item.dueAt
        ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(item.dueAt))
        : "any time";
      lines.push(`- ${item.title} — ${item.course} — ${time}${item.pointsPossible == null ? "" : ` — ${item.pointsPossible} pts`}`);
    }
  }
  return lines.join("\n");
}

function localDay(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
