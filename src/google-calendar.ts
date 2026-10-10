import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const tokenDir = join(process.env.APPDATA || join(homedir(), ".config"), "canvas-organizer");
const tokenPath = join(tokenDir, "google-token.json");

type TokenFile = { refreshToken: string };
export type CalendarEventInput = {
  summary: string;
  start: string;
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
  reminderMinutes?: number;
};

export type CalendarEventUpdate = {
  summary?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  description?: string;
  location?: string;
};

function oauthConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google Calendar is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  return { clientId, clientSecret };
}

async function readToken(): Promise<TokenFile> {
  try {
    const parsed = JSON.parse(await readFile(tokenPath, "utf8"));
    if (typeof parsed.refreshToken !== "string") throw new Error("missing refresh token");
    return parsed;
  } catch {
    throw new Error("Google Calendar is not authorized. Run /organizer-google-login first.");
  }
}

async function storeToken(refreshToken: string): Promise<void> {
  await mkdir(tokenDir, { recursive: true });
  await writeFile(tokenPath, JSON.stringify({ refreshToken }, null, 2), { encoding: "utf8", mode: 0o600 });
  if (platform() !== "win32") await chmod(tokenPath, 0o600);
}

async function tokenRequest(params: URLSearchParams): Promise<Record<string, any>> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Google authorization failed (${response.status}): ${body.error_description ?? body.error ?? "unknown error"}`);
  return body;
}

async function accessToken(): Promise<string> {
  const { clientId, clientSecret } = oauthConfig();
  const { refreshToken } = await readToken();
  const body = await tokenRequest(new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }));
  if (typeof body.access_token !== "string") throw new Error("Google did not return an access token.");
  return body.access_token;
}

function launchBrowser(url: string): void {
  const child = platform() === "win32"
    ? spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore", windowsHide: true })
    : platform() === "darwin"
      ? spawn("open", [url], { detached: true, stdio: "ignore" })
      : spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
  child.unref();
}

export async function authorizeGoogleCalendar(): Promise<void> {
  const { clientId, clientSecret } = oauthConfig();
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");

  let finish!: (value: string) => void;
  let fail!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { finish = resolve; fail = reject; });
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error("Google authorization timed out after five minutes.")), 5 * 60 * 1000).unref();
  });
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/oauth2callback") {
        response.writeHead(404).end("Not found");
        return;
      }
      if (url.searchParams.get("state") !== state) throw new Error("OAuth state did not match.");
      const error = url.searchParams.get("error");
      if (error) throw new Error(`Google authorization was denied: ${error}`);
      const code = url.searchParams.get("code");
      if (!code) throw new Error("Google did not return an authorization code.");
      response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Calendar connected. You can close this tab and return to Pi.");
      finish(code);
    } catch (error) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Calendar connection failed. Return to Pi for details.");
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the local OAuth callback.");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  launchBrowser(authUrl.toString());
  try {
    const code = await Promise.race([codePromise, timeoutPromise]);
    const body = await tokenRequest(new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }));
    if (typeof body.refresh_token !== "string") throw new Error("Google did not issue a refresh token. Revoke the app's access and try again.");
    await storeToken(body.refresh_token);
  } finally {
    server.close();
  }
}

async function googleRequest(path: string, init: RequestInit = {}): Promise<any> {
  const token = await accessToken();
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...init.headers },
  });
  const rawBody = await response.text();
  let body = null;
  try { body = rawBody ? JSON.parse(rawBody) : null; } catch { /* Google occasionally returns a non-JSON proxy error. */ }
  if (!response.ok) throw new Error(`Google Calendar request failed (${response.status}): ${body?.error?.message ?? "unknown error"}`);
  return body;
}

function displayText(value: unknown, fallback: string, maxLength = 500): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || fallback;
}

function calendarId(): string {
  return process.env.ORGANIZER_CALENDAR_ID || "primary";
}

export async function listCalendarEvents(start: string, end: string): Promise<any[]> {
  const params = new URLSearchParams({
    timeMin: new Date(start).toISOString(),
    timeMax: new Date(end).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const body = await googleRequest(`/calendars/${encodeURIComponent(calendarId())}/events?${params}`);
  return (body.items ?? []).map((event: any) => ({
    id: event.id,
    title: displayText(event.summary, "(untitled)"),
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    location: typeof event.location === "string" ? displayText(event.location, "", 500) || null : null,
    url: event.htmlLink ?? null,
  }));
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function eventResource(input: CalendarEventInput | CalendarEventUpdate, requireSummary: boolean): Record<string, any> {
  const resource: Record<string, any> = {};
  if (input.summary !== undefined) {
    const summary = input.summary.trim().slice(0, 500);
    if (!summary) throw new Error("An event title cannot be empty.");
    resource.summary = summary;
  } else if (requireSummary) {
    throw new Error("An event title is required.");
  }
  if (input.description !== undefined) resource.description = input.description.slice(0, 5000);
  if (input.location !== undefined) resource.location = input.location.slice(0, 500);

  const changesTime = input.start !== undefined || input.end !== undefined || input.allDay !== undefined;
  if (changesTime) {
    if (!input.start) throw new Error("A start value is required when changing an event's time.");
    if (input.allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.start)) throw new Error("All-day events require start in YYYY-MM-DD format.");
      if (input.end && (!/^\d{4}-\d{2}-\d{2}$/.test(input.end) || input.end <= input.start)) {
        throw new Error("An all-day event's exclusive end date must be after its start date.");
      }
      resource.start = { date: input.start };
      resource.end = { date: input.end || nextDay(input.start) };
    } else {
      const start = new Date(input.start);
      const end = new Date(input.end ?? start.getTime() + 60 * 60 * 1000);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw new Error("Event start/end times are invalid.");
      resource.start = { dateTime: start.toISOString(), timeZone: process.env.ORGANIZER_TIMEZONE || "America/Chicago" };
      resource.end = { dateTime: end.toISOString(), timeZone: process.env.ORGANIZER_TIMEZONE || "America/Chicago" };
    }
  }
  if ("reminderMinutes" in input && input.reminderMinutes !== undefined) {
    resource.reminders = {
      useDefault: false,
      overrides: [{ method: "popup", minutes: Math.max(0, Math.min(40320, input.reminderMinutes)) }],
    };
  }
  return resource;
}

export async function createCalendarEvent(input: CalendarEventInput): Promise<any> {
  const resource = eventResource(input, true);

  const created = await googleRequest(`/calendars/${encodeURIComponent(calendarId())}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resource),
  });
  return { id: created.id, title: created.summary, start: created.start, end: created.end, url: created.htmlLink };
}

export async function updateCalendarEvent(eventId: string, input: CalendarEventUpdate): Promise<any> {
  const resource = eventResource(input, false);
  if (!Object.keys(resource).length) throw new Error("At least one event field must be changed.");
  const updated = await googleRequest(`/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resource),
  });
  return { id: updated.id, title: updated.summary, start: updated.start, end: updated.end, url: updated.htmlLink };
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  await googleRequest(`/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
    method: "DELETE",
  });
}

export function googleTokenLocation(): string {
  return tokenPath;
}
