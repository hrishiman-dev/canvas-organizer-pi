import { normalizeCanvasOrigin, normalizePlannerItem, parseLinkHeader, type PlannerItem } from "./core.ts";
import { parseCanvasIcal } from "./ical.ts";
import { checkCanvasBrowser, getCanvasBrowserAgenda, hasCanvasBrowserSession } from "./canvas-browser.ts";
import { organizerDateWindow } from "./time-context.ts";

type CanvasConfig = { baseUrl: string; token: string };

function apiConfig(): CanvasConfig {
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_ACCESS_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("Canvas is not configured. Set CANVAS_BASE_URL and CANVAS_ACCESS_TOKEN before starting Pi.");
  }
  return { baseUrl: normalizeCanvasOrigin(baseUrl), token };
}

export function canvasDataSource(): "api" | "browser" | "ical" | "unconfigured" {
  if (process.env.CANVAS_BASE_URL && process.env.CANVAS_ACCESS_TOKEN) return "api";
  if (process.env.CANVAS_BASE_URL) return "browser";
  if (process.env.CANVAS_ICAL_URL && hasCanvasBrowserSession()) return "browser";
  if (process.env.CANVAS_ICAL_URL) return "ical";
  return "unconfigured";
}

async function getIcalAgenda(daysAhead: number, signal?: AbortSignal): Promise<PlannerItem[]> {
  const rawUrl = process.env.CANVAS_ICAL_URL;
  if (!rawUrl) throw new Error("Canvas is not configured.");
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("CANVAS_ICAL_URL must use HTTPS.");
  const response = await fetch(url, { signal, headers: { Accept: "text/calendar" } });
  if (!response.ok) throw new Error(`Canvas calendar feed failed (${response.status}).`);

  const { start, end } = organizerDateWindow(daysAhead);
  return parseCanvasIcal(await response.text())
    .filter((item) => item.dueAt && new Date(item.dueAt) >= start && new Date(item.dueAt) < end)
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
}

async function getAll<T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T[]> {
  const { baseUrl, token } = apiConfig();
  let next: string | undefined = `${baseUrl}/api/v1${path}?${params}`;
  const output: T[] = [];

  while (next) {
    const url = new URL(next);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/api/v1/")) {
      throw new Error("Canvas returned an unsafe pagination URL.");
    }
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      throw new Error(`Canvas request failed (${response.status}).`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("Canvas returned an unexpected response.");
    output.push(...(page as T[]));
    next = parseLinkHeader(response.headers.get("link")).next;
  }
  return output;
}

export async function getCanvasAgenda(options: {
  daysAhead?: number;
  includeCompleted?: boolean;
  signal?: AbortSignal;
} = {}): Promise<PlannerItem[]> {
  const daysAhead = Math.max(0, Math.min(options.daysAhead ?? 14, 90));
  if (canvasDataSource() === "browser") return getCanvasBrowserAgenda(daysAhead, options.includeCompleted);
  if (canvasDataSource() === "ical") return getIcalAgenda(daysAhead, options.signal);
  if (canvasDataSource() === "unconfigured") {
    throw new Error("Canvas is not configured. Set CANVAS_BASE_URL for browser login, CANVAS_ICAL_URL, or CANVAS_BASE_URL plus CANVAS_ACCESS_TOKEN.");
  }
  const { start, end } = organizerDateWindow(daysAhead);

  const params = new URLSearchParams({
    start_date: start.toISOString(),
    end_date: end.toISOString(),
    per_page: "100",
  });
  if (!options.includeCompleted) params.set("filter", "incomplete_items");

  const raw = await getAll<Record<string, any>>("/planner/items", params, options.signal);
  const items = raw.map(normalizePlannerItem);
  return options.includeCompleted ? items : items.filter((item) => !item.completed);
}

export async function checkCanvas(signal?: AbortSignal): Promise<string> {
  if (canvasDataSource() === "browser") {
    if (!hasCanvasBrowserSession()) throw new Error("Canvas browser login has not been saved. Run /organizer-canvas-login.");
    return checkCanvasBrowser();
  }
  if (canvasDataSource() === "ical") {
    await getIcalAgenda(1, signal);
    return "Canvas calendar feed (deadlines/events only)";
  }
  const { baseUrl, token } = apiConfig();
  const response = await fetch(`${baseUrl}/api/v1/users/self/profile`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Canvas authentication failed (${response.status}).`);
  const user = await response.json();
  return String(user.name ?? user.short_name ?? "Canvas user");
}
