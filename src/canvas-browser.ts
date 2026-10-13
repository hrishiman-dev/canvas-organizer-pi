import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeCanvasOrigin, normalizePlannerItem, parseLinkHeader, safeCanvasText, type PlannerItem } from "./core.ts";
import { organizerDateWindow } from "./time-context.ts";

type BrowserRuntime = {
  baseUrl: string;
  browserPath: string;
  port: number;
  pid: number;
  headless: boolean;
};

type BrowserMarker = {
  baseUrl: string;
  authenticatedAt: string;
  user: string;
};

type ApiResponse = {
  ok: boolean;
  status: number;
  text: string;
  link: string | null;
  contentType: string | null;
  responseUrl: string;
};

export type CanvasCourse = {
  id: string;
  name: string;
  code: string;
  term: string | null;
  currentScore: number | null;
  currentGrade: string | null;
  url: string | null;
};

export type CanvasAnnouncement = {
  id: string;
  title: string;
  course: string;
  postedAt: string | null;
  author: string | null;
  bodyPreview: string;
  url: string | null;
};

export type CanvasCourseDetails = {
  course: CanvasCourse;
  assignments: Array<{
    id: string;
    title: string;
    dueAt: string | null;
    pointsPossible: number | null;
    submitted: boolean;
    workflowState: string | null;
    score: number | null;
    url: string | null;
  }>;
  modules: Array<{
    id: string;
    name: string;
    state: string | null;
    completedAt: string | null;
    items: Array<{
      id: string;
      title: string;
      type: string;
      completed: boolean;
      dueAt: string | null;
      url: string | null;
    }>;
  }>;
};

const APP_DIR = join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "CanvasOrganizer");
const PROFILE_DIR = join(APP_DIR, "canvas-browser-profile");
const RUNTIME_FILE = join(APP_DIR, "browser-runtime.json");
const MARKER_FILE = join(APP_DIR, "canvas-authenticated.json");

function canvasBaseUrl(): string {
  const value = process.env.CANVAS_BASE_URL || (() => {
    const feed = process.env.CANVAS_ICAL_URL;
    if (!feed) return undefined;
    try { return new URL(feed).origin; } catch { return undefined; }
  })();
  if (!value) throw new Error("Set CANVAS_BASE_URL in .env, then run /organizer-canvas-login.");
  return normalizeCanvasOrigin(value);
}

export function canvasBrowserProfileLocation(): string {
  return PROFILE_DIR;
}

export function hasCanvasBrowserSession(): boolean {
  if (!existsSync(MARKER_FILE)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER_FILE, "utf8")) as BrowserMarker;
    return marker.baseUrl === canvasBaseUrl();
  } catch {
    return false;
  }
}

function findBrowserExecutable(): string {
  const override = process.env.CANVAS_BROWSER_PATH;
  if (override) {
    const full = resolve(override);
    if (!existsSync(full)) throw new Error(`CANVAS_BROWSER_PATH does not exist: ${full}`);
    return full;
  }

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  const chrome = [
    join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  const edge = [
    join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  const preferred = (process.env.CANVAS_BROWSER || "chrome").toLowerCase() === "edge" ? [...edge, ...chrome] : [...chrome, ...edge];
  const found = preferred.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge is required for Canvas browser login.");
  return found;
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

async function fetchJson<T>(url: string, timeoutMs = 2_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Browser endpoint returned ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function endpointIsAlive(port: number): Promise<boolean> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`);
    return true;
  } catch {
    return false;
  }
}

function readRuntime(): BrowserRuntime | null {
  if (!existsSync(RUNTIME_FILE)) return null;
  try {
    return JSON.parse(readFileSync(RUNTIME_FILE, "utf8")) as BrowserRuntime;
  } catch {
    return null;
  }
}

async function waitForEndpoint(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await endpointIsAlive(port)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error("The dedicated Canvas browser did not start. A school or browser policy may be blocking remote debugging.");
}

async function launchDedicatedBrowser(baseUrl: string, headless: boolean): Promise<BrowserRuntime> {
  if (process.platform !== "win32") throw new Error("Canvas browser login is currently configured for Windows.");
  mkdirSync(PROFILE_DIR, { recursive: true });
  const browserPath = findBrowserExecutable();
  const port = await getFreePort();
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${PROFILE_DIR}`,
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
  ];
  if (headless) args.push("--headless=new", "--disable-gpu");
  args.push(baseUrl);

  const child = spawn(browserPath, args, { detached: true, stdio: "ignore", windowsHide: headless });
  child.unref();
  const runtime: BrowserRuntime = { baseUrl, browserPath, port, pid: child.pid ?? 0, headless };
  await waitForEndpoint(port);
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), { encoding: "utf8", mode: 0o600 });
  return runtime;
}

async function liveRuntime(baseUrl: string): Promise<BrowserRuntime | null> {
  const runtime = readRuntime();
  if (!runtime || runtime.baseUrl !== baseUrl || !(await endpointIsAlive(runtime.port))) return null;
  return runtime;
}

type DebugTarget = { type: string; url: string; webSocketDebuggerUrl?: string };

async function canvasTarget(runtime: BrowserRuntime, baseUrl: string, timeoutMs = 20_000): Promise<DebugTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson<DebugTarget[]>(`http://127.0.0.1:${runtime.port}/json/list`);
    const target = targets.find((entry) => entry.type === "page" && entry.url.startsWith(baseUrl) && entry.webSocketDebuggerUrl);
    if (target) return target;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Canvas did not finish loading in the dedicated browser.");
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const handler = this.pending.get(message.id);
        if (!handler) return;
        this.pending.delete(message.id);
        clearTimeout(handler.timer);
        if (message.error) handler.reject(new Error(message.error.message || "Browser command failed"));
        else handler.resolve(message.result);
      } catch {
        // Ignore browser events and malformed messages that are unrelated to a pending command.
      }
    });
    socket.addEventListener("close", () => {
      for (const handler of this.pending.values()) {
        clearTimeout(handler.timer);
        handler.reject(new Error("Canvas browser connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    if (typeof WebSocket === "undefined") throw new Error("This Pi runtime is too old for browser automation. Update Pi and try again.");
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to the Canvas browser.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Could not connect to the Canvas browser.")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        const handler = this.pending.get(id);
        if (!handler) return;
        this.pending.delete(id);
        handler.reject(new Error(`Browser command timed out: ${method}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.call("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: false,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Canvas browser script failed.");
  return response.result?.value as T;
}

async function pageApiRequest(client: CdpClient, absoluteUrl: string): Promise<ApiResponse> {
  const expression = `(async () => {
    const response = await fetch(${JSON.stringify(absoluteUrl)}, {
      method: "GET",
      credentials: "same-origin",
      headers: { "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" }
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
      link: response.headers.get("link"),
      contentType: response.headers.get("content-type"),
      responseUrl: response.url
    };
  })()`;
  try {
    return await evaluate<ApiResponse>(client, expression);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch/i.test(message)) {
      throw new Error("Canvas could not use the saved browser session. It probably expired or redirected to school sign-in. Run /organizer-canvas-login on the organizer computer and complete sign-in again.");
    }
    throw error;
  }
}

async function apiGetAll<T>(client: CdpClient, baseUrl: string, path: string, params = new URLSearchParams()): Promise<T[]> {
  let next: string | undefined = `${baseUrl}/api/v1${path}${params.size ? `?${params}` : ""}`;
  const output: T[] = [];
  while (next) {
    const url = new URL(next);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith("/api/v1/")) throw new Error("Canvas returned an unsafe pagination URL.");
    const response = await pageApiRequest(client, url.toString());
    if (!response.ok || !response.contentType?.toLowerCase().includes("json")) {
      if (response.status === 401 || response.status === 403) throw new Error("Canvas login expired. Run /organizer-canvas-login and complete sign-in/Duo again.");
      if (!response.contentType?.toLowerCase().includes("json")) throw new Error("Canvas login expired or was redirected to school sign-in. Run /organizer-canvas-login.");
      throw new Error(`Canvas browser request failed (${response.status}): ${safeCanvasText(response.text, "Canvas error", 300)}`);
    }
    const page = JSON.parse(response.text);
    if (!Array.isArray(page)) throw new Error("Canvas returned an unexpected response.");
    output.push(...page as T[]);
    next = parseLinkHeader(response.link).next;
  }
  return output;
}

async function apiGetObject<T>(client: CdpClient, baseUrl: string, path: string): Promise<T> {
  const response = await pageApiRequest(client, `${baseUrl}/api/v1${path}`);
  if (!response.ok || !response.contentType?.toLowerCase().includes("json")) {
    if (response.status === 401 || response.status === 403) throw new Error("Canvas login expired. Run /organizer-canvas-login and complete sign-in/Duo again.");
    if (!response.contentType?.toLowerCase().includes("json")) throw new Error("Canvas login expired or was redirected to school sign-in. Run /organizer-canvas-login.");
    throw new Error(`Canvas browser request failed (${response.status}).`);
  }
  return JSON.parse(response.text) as T;
}

async function closeHeadlessBrowser(runtime: BrowserRuntime): Promise<void> {
  if (!runtime.headless) return;
  try {
    const version = await fetchJson<{ webSocketDebuggerUrl?: string }>(`http://127.0.0.1:${runtime.port}/json/version`);
    if (version.webSocketDebuggerUrl) {
      const client = await CdpClient.connect(version.webSocketDebuggerUrl);
      await client.call("Browser.close");
      client.close();
    }
  } catch {
    // The process may already be gone. The stale runtime record is removed below.
  }
  try { rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
}

async function withCanvasPage<T>(work: (client: CdpClient, baseUrl: string) => Promise<T>): Promise<T> {
  const baseUrl = canvasBaseUrl();
  let runtime = await liveRuntime(baseUrl);
  let launchedHere = false;
  if (!runtime) {
    runtime = await launchDedicatedBrowser(baseUrl, true);
    launchedHere = true;
  }
  let client: CdpClient | null = null;
  try {
    let target: DebugTarget;
    try {
      target = await canvasTarget(runtime, baseUrl);
    } catch (error) {
      if (launchedHere) throw new Error("Canvas login expired or redirected to school sign-in. Run /organizer-canvas-login and complete sign-in/Duo again.", { cause: error });
      throw error;
    }
    client = await CdpClient.connect(target.webSocketDebuggerUrl!);
    return await work(client, baseUrl);
  } finally {
    client?.close();
    if (launchedHere) await closeHeadlessBrowser(runtime);
  }
}

function normalizeCourse(raw: Record<string, any>): CanvasCourse {
  const enrollment = Array.isArray(raw.enrollments) ? raw.enrollments[0] ?? {} : {};
  const grades = enrollment.grades ?? {};
  const score = enrollment.computed_current_score ?? grades.current_score;
  const grade = enrollment.computed_current_grade ?? grades.current_grade;
  return {
    id: String(raw.id ?? "unknown"),
    name: safeCanvasText(raw.name ?? raw.course_code, "Untitled course"),
    code: safeCanvasText(raw.course_code ?? raw.name, "Course"),
    term: raw.term?.name ? safeCanvasText(raw.term.name, "Term") : null,
    currentScore: typeof score === "number" ? score : null,
    currentGrade: typeof grade === "string" ? safeCanvasText(grade, "") || null : null,
    url: typeof raw.html_url === "string" ? raw.html_url : null,
  };
}

async function getCourses(client: CdpClient, baseUrl: string): Promise<CanvasCourse[]> {
  const params = new URLSearchParams({ enrollment_state: "active", per_page: "100" });
  params.append("include[]", "total_scores");
  params.append("include[]", "term");
  params.append("include[]", "enrollments");
  const raw = await apiGetAll<Record<string, any>>(client, baseUrl, "/courses", params);
  return raw.map(normalizeCourse);
}

async function getAgenda(client: CdpClient, baseUrl: string, daysAhead: number, includeCompleted: boolean): Promise<PlannerItem[]> {
  const { start, end } = organizerDateWindow(daysAhead);
  const params = new URLSearchParams({ start_date: start.toISOString(), end_date: end.toISOString(), per_page: "100" });
  if (!includeCompleted) params.set("filter", "incomplete_items");
  const raw = await apiGetAll<Record<string, any>>(client, baseUrl, "/planner/items", params);
  const items = raw.map(normalizePlannerItem);
  return includeCompleted ? items : items.filter((item) => !item.completed);
}

async function getAnnouncements(client: CdpClient, baseUrl: string, courses: CanvasCourse[], daysBack: number): Promise<CanvasAnnouncement[]> {
  if (!courses.length) return [];
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const params = new URLSearchParams({ start_date: start.toISOString(), end_date: new Date().toISOString(), per_page: "100", active_only: "true" });
  for (const course of courses) params.append("context_codes[]", `course_${course.id}`);
  const names = new Map(courses.map((course) => [`course_${course.id}`, course.name]));
  const raw = await apiGetAll<Record<string, any>>(client, baseUrl, "/announcements", params);
  return raw.map((announcement) => ({
    id: String(announcement.id ?? "unknown"),
    title: safeCanvasText(announcement.title, "Untitled announcement"),
    course: names.get(String(announcement.context_code)) ?? "Canvas",
    postedAt: typeof announcement.posted_at === "string" ? announcement.posted_at : null,
    author: announcement.author?.display_name ? safeCanvasText(announcement.author.display_name, "") || null : null,
    bodyPreview: safeCanvasText(announcement.message, "", 1_000),
    url: typeof announcement.html_url === "string" ? announcement.html_url : null,
  })).sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
}

export async function loginCanvasWithBrowser(timeoutMs = 10 * 60_000): Promise<{ user: string; profileDir: string }> {
  const baseUrl = canvasBaseUrl();
  let runtime = await liveRuntime(baseUrl);
  if (runtime?.headless) {
    await closeHeadlessBrowser(runtime);
    runtime = null;
  }
  if (!runtime) runtime = await launchDedicatedBrowser(baseUrl, false);
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    try {
      const target = await canvasTarget(runtime, baseUrl, 2_000);
      const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
      try {
        const response = await pageApiRequest(client, `${baseUrl}/api/v1/users/self/profile`);
        lastStatus = response.status;
        if (response.ok) {
          const profile = JSON.parse(response.text) as Record<string, any>;
          const user = safeCanvasText(profile.name ?? profile.short_name, "Canvas user");
          mkdirSync(APP_DIR, { recursive: true });
          writeFileSync(MARKER_FILE, JSON.stringify({ baseUrl, authenticatedAt: new Date().toISOString(), user } satisfies BrowserMarker, null, 2), { encoding: "utf8", mode: 0o600 });
          return { user, profileDir: PROFILE_DIR };
        }
      } finally {
        client.close();
      }
    } catch {
      // The user may still be on the school SSO or Duo page. Keep waiting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  throw new Error(`Canvas sign-in was not detected within 10 minutes${lastStatus ? ` (last status ${lastStatus})` : ""}. Run /organizer-canvas-login to try again.`);
}

export async function checkCanvasBrowser(): Promise<string> {
  return withCanvasPage(async (client, baseUrl) => {
    const user = await apiGetObject<Record<string, any>>(client, baseUrl, "/users/self/profile");
    return safeCanvasText(user.name ?? user.short_name, "Canvas user");
  });
}

export async function getCanvasBrowserAgenda(daysAhead: number, includeCompleted = false): Promise<PlannerItem[]> {
  return withCanvasPage((client, baseUrl) => getAgenda(client, baseUrl, daysAhead, includeCompleted));
}

export async function getCanvasBrowserDashboard(options: { daysAhead?: number; announcementDays?: number } = {}) {
  const daysAhead = Math.max(0, Math.min(options.daysAhead ?? 14, 90));
  const announcementDays = Math.max(1, Math.min(options.announcementDays ?? 14, 90));
  return withCanvasPage(async (client, baseUrl) => {
    const courses = await getCourses(client, baseUrl);
    const [agenda, announcements] = await Promise.all([
      getAgenda(client, baseUrl, daysAhead, false),
      getAnnouncements(client, baseUrl, courses, announcementDays),
    ]);
    return { courses, agenda, announcements };
  });
}

export async function getCanvasBrowserCourse(courseId: string): Promise<CanvasCourseDetails> {
  if (!/^\d+$/.test(courseId)) throw new Error("Canvas course_id must be the numeric ID returned by canvas_dashboard.");
  return withCanvasPage(async (client, baseUrl) => {
    const courses = await getCourses(client, baseUrl);
    const course = courses.find((entry) => entry.id === courseId);
    if (!course) throw new Error(`Active Canvas course ${courseId} was not found.`);

    const assignmentParams = new URLSearchParams({ per_page: "100", order_by: "due_at" });
    assignmentParams.append("include[]", "submission");
    const moduleParams = new URLSearchParams({ per_page: "100" });
    moduleParams.append("include[]", "items");
    moduleParams.append("include[]", "content_details");
    const [rawAssignments, rawModules] = await Promise.all([
      apiGetAll<Record<string, any>>(client, baseUrl, `/courses/${courseId}/assignments`, assignmentParams),
      apiGetAll<Record<string, any>>(client, baseUrl, `/courses/${courseId}/modules`, moduleParams),
    ]);

    const assignments = rawAssignments.map((assignment) => {
      const submission = assignment.submission ?? {};
      const state = typeof submission.workflow_state === "string" ? submission.workflow_state : null;
      return {
        id: String(assignment.id ?? "unknown"),
        title: safeCanvasText(assignment.name, "Untitled assignment"),
        dueAt: typeof assignment.due_at === "string" ? assignment.due_at : null,
        pointsPossible: typeof assignment.points_possible === "number" ? assignment.points_possible : null,
        submitted: Boolean(submission.submitted_at || state === "submitted" || state === "graded"),
        workflowState: state ? safeCanvasText(state, "") || null : null,
        score: typeof submission.score === "number" ? submission.score : null,
        url: typeof assignment.html_url === "string" ? assignment.html_url : null,
      };
    });
    const modules = rawModules.map((module) => ({
      id: String(module.id ?? "unknown"),
      name: safeCanvasText(module.name, "Untitled module"),
      state: typeof module.state === "string" ? safeCanvasText(module.state, "") || null : null,
      completedAt: typeof module.completed_at === "string" ? module.completed_at : null,
      items: (Array.isArray(module.items) ? module.items : []).map((item: Record<string, any>) => ({
        id: String(item.id ?? "unknown"),
        title: safeCanvasText(item.title, "Untitled item"),
        type: safeCanvasText(item.type, "item"),
        completed: Boolean(item.completion_requirement?.completed),
        dueAt: typeof item.content_details?.due_at === "string" ? item.content_details.due_at : null,
        url: typeof item.html_url === "string" ? item.html_url : null,
      })),
    }));
    return { course, assignments, modules };
  });
}
