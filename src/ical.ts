import type { PlannerItem } from "./core.ts";

function unfold(source: string): string[] {
  const output: string[] = [];
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line) && output.length) output[output.length - 1] += line.slice(1);
    else output.push(line);
  }
  return output;
}
function unescapeText(value: string): string {
  return value
    .replace(/\\[nN]/g, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseDate(value: string): string | null {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T23:59:59`;
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${utc}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function parseCanvasIcal(source: string): PlannerItem[] {
  const events: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;

  for (const line of unfold(source)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).split(";", 1)[0].toUpperCase();
    if (!(name in current)) current[name] = line.slice(colon + 1);
  }

  return events.flatMap((event) => {
    const dueAt = parseDate(event.DTSTART ?? "");
    if (!dueAt) return [];
    const title = unescapeText(event.SUMMARY || "Canvas event").slice(0, 300);
    return [{
      id: event.UID || `${title}-${dueAt}`,
      type: "calendar_event",
      title,
      course: "Canvas calendar",
      dueAt,
      completed: false,
      submitted: false,
      pointsPossible: null,
      url: event.URL?.startsWith("https://") ? event.URL : null,
    } satisfies PlannerItem];
  });
}
