import { canvasDataSource, getCanvasAgenda } from "./canvas.ts";
import { loadProjectEnv } from "./config.ts";
import { createCalendarEvent, listCalendarEvents, updateCalendarEvent } from "./google-calendar.ts";
import { localDateTimeToInstant, organizerTimeZone } from "./time-context.ts";

const TITLE = "📚 Canvas daily brief";

function localDateParts(now = new Date()): { year: number; month: number; day: number; isoDay: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.ORGANIZER_TIMEZONE || "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = Number(value("year"));
  const month = Number(value("month"));
  const day = Number(value("day"));
  return { year, month, day, isoDay: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` };
}

function describeDueDate(value: string | null): string {
  if (!value) return "no due time";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: process.env.ORGANIZER_TIMEZONE || "America/Chicago",
  }).format(new Date(value));
}

export async function syncDailyBriefing(now = new Date()): Promise<{ created: boolean; itemCount: number; eventId: string }> {
  loadProjectEnv();
  const items = await getCanvasAgenda({ daysAhead: 7 });
  const { isoDay } = localDateParts(now);
  const timeZone = organizerTimeZone();
  const tomorrow = new Date(`${isoDay}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDay = tomorrow.toISOString().slice(0, 10);
  const eventStart = localDateTimeToInstant(`${isoDay}T08:00:00`, timeZone);
  const eventEnd = localDateTimeToInstant(`${isoDay}T08:15:00`, timeZone);
  const dayStart = localDateTimeToInstant(`${isoDay}T00:00:00`, timeZone);
  const nextDay = localDateTimeToInstant(`${tomorrowDay}T00:00:00`, timeZone);
  const marker = `[canvas-organizer-daily:${isoDay}]`;
  const lines = items.length
    ? items.slice(0, 30).map((item) => `• ${item.title} — ${item.course} — ${describeDueDate(item.dueAt)}`)
    : ["No Canvas deadlines or events found in the next seven days."];
  const sourceNote = canvasDataSource() === "ical"
    ? "Calendar-feed mode cannot detect whether an assignment was already submitted."
    : "Read from Canvas with completion and submission state.";
  const description = `${marker}\nCanvas items scheduled in the next seven days:\n\n${lines.join("\n")}\n\n${sourceNote}`;

  const todaysEvents = await listCalendarEvents(dayStart.toISOString(), nextDay.toISOString());
  const existing = todaysEvents.find((event) => event.title === TITLE);
  if (existing) {
    const updated = await updateCalendarEvent(existing.id, {
      summary: TITLE,
      start: eventStart.toISOString(),
      end: eventEnd.toISOString(),
      description,
    });
    return { created: false, itemCount: items.length, eventId: updated.id };
  }

  const created = await createCalendarEvent({
    summary: TITLE,
    start: eventStart.toISOString(),
    end: eventEnd.toISOString(),
    description,
    reminderMinutes: 10,
  });
  return { created: true, itemCount: items.length, eventId: created.id };
}
