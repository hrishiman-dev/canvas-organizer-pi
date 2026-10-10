export type OrganizerClock = {
  nowUtc: string;
  localDate: string;
  localTime: string;
  timeZone: string;
  utcOffset: string;
};

export function organizerTimeZone(): string {
  const timeZone = process.env.ORGANIZER_TIMEZONE || "America/Chicago";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`ORGANIZER_TIMEZONE is not a valid IANA timezone: ${timeZone}`);
  }
  return timeZone;
}

function partsAt(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDateTimeToInstant(value: string, timeZone = organizerTimeZone()): Date {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error("Local date-time must use YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss.");
  const desired = match.slice(1).map((part, index) => Number(part || (index === 5 ? "0" : part)));
  const [year, month, day, hour, minute, second] = desired;
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = partsAt(new Date(candidate), timeZone);
    const observedUtc = Date.UTC(
      Number(observed.year),
      Number(observed.month) - 1,
      Number(observed.day),
      Number(observed.hour),
      Number(observed.minute),
      Number(observed.second),
    );
    const adjustment = target - observedUtc;
    candidate += adjustment;
    if (adjustment === 0) break;
  }
  const finalParts = partsAt(new Date(candidate), timeZone);
  const normalized = `${finalParts.year}-${finalParts.month}-${finalParts.day}T${finalParts.hour}:${finalParts.minute}:${finalParts.second}`;
  const expected = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}`;
  if (normalized !== expected) throw new Error(`The local time ${expected} does not exist in ${timeZone}, likely because of a daylight-saving transition.`);
  return new Date(candidate);
}

function addLocalDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function organizerDateWindow(daysAhead: number, now = new Date()): { start: Date; end: Date } {
  const { localDate, timeZone } = organizerClock(now);
  return {
    start: localDateTimeToInstant(`${localDate}T00:00:00`, timeZone),
    end: localDateTimeToInstant(`${addLocalDays(localDate, daysAhead + 1)}T00:00:00`, timeZone),
  };
}

export function organizerClock(now = new Date()): OrganizerClock {
  const timeZone = organizerTimeZone();
  const parts = partsAt(now, timeZone);
  const offsetName = parts.timeZoneName || "GMT";
  const utcOffset = offsetName === "GMT" ? "+00:00" : offsetName.replace(/^GMT/, "");
  return {
    nowUtc: now.toISOString(),
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    timeZone,
    utcOffset,
  };
}

export function clockInstruction(now = new Date()): string {
  const clock = organizerClock(now);
  return [
    "AUTHORITATIVE CURRENT TIME FOR THIS TURN:",
    `- Local date: ${clock.localDate}`,
    `- Local time: ${clock.localTime}`,
    `- IANA timezone: ${clock.timeZone}`,
    `- Current UTC offset: ${clock.utcOffset}`,
    `- UTC instant: ${clock.nowUtc}`,
    "Resolve words such as today, tomorrow, tonight, and next week from this clock. Never infer the current date from model knowledge or earlier conversation. For calendar operations, use the IANA timezone above and include the correct UTC offset for the event date.",
  ].join("\n");
}

function suppliedOffset(value: string): string | null {
  const match = value.match(/(Z|[+-]\d{2}:\d{2})$/i);
  if (!match) return null;
  return match[1].toUpperCase() === "Z" ? "+00:00" : match[1];
}

export function validateCalendarWriteStart(startValue: string, allowPast = false, now = new Date()): void {
  const clock = organizerClock(now);
  if (/^\d{4}-\d{2}-\d{2}$/.test(startValue)) {
    if (!allowPast && startValue < clock.localDate) {
      throw new Error(`Refusing an accidental past calendar date (${startValue}). Today is ${clock.localDate} in ${clock.timeZone}. If the user explicitly requested a historical event, retry with allow_past=true; otherwise correct the date.`);
    }
    return;
  }

  const date = new Date(startValue);
  if (Number.isNaN(date.getTime())) throw new Error("Calendar start must be RFC 3339 with an explicit UTC offset, or YYYY-MM-DD for an all-day event.");
  if (!allowPast && date.getTime() < now.getTime() - 5 * 60_000) {
    throw new Error(`Refusing an accidental past calendar time (${startValue}). The current local time is ${clock.localDate}T${clock.localTime}${clock.utcOffset} in ${clock.timeZone}. If the user explicitly requested a historical event, retry with allow_past=true; otherwise correct the date.`);
  }

  const offset = suppliedOffset(startValue);
  if (!offset) throw new Error(`Calendar date-times must include an explicit UTC offset. Use ${clock.timeZone}, not a guessed timezone abbreviation.`);
  const expected = organizerClock(date).utcOffset;
  if (offset !== expected) {
    throw new Error(`The supplied UTC offset ${offset} is wrong for ${clock.timeZone} at that date; use ${expected}.`);
  }
}

export function validateCalendarLookupRange(startValue: string, endValue: string, allowPast = false, now = new Date()): void {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error("Calendar lookup start/end must be a valid increasing RFC 3339 range.");
  for (const [label, raw, parsed] of [["start", startValue, start], ["end", endValue, end]] as const) {
    const offset = suppliedOffset(raw);
    if (!offset) throw new Error(`Calendar lookup ${label} must include an explicit UTC offset.`);
    const expected = organizerClock(parsed).utcOffset;
    if (offset !== expected) throw new Error(`The calendar lookup ${label} offset ${offset} is wrong for ${organizerTimeZone()} at that date; use ${expected}.`);
  }
  if (!allowPast && end.getTime() < now.getTime() - 5 * 60_000) {
    const clock = organizerClock(now);
    throw new Error(`Refusing an accidental lookup entirely in the past. Today is ${clock.localDate} in ${clock.timeZone}. If the user explicitly requested historical events, retry with allow_past=true; otherwise correct the range.`);
  }
}
