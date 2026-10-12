import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type BrowserRuntime = {
  browserPath: string;
  port: number;
  pid: number;
  headless: boolean;
};

type BrowserMarker = {
  authenticatedAt: string;
  user: string;
};

type DebugTarget = { type: string; url: string; webSocketDebuggerUrl?: string };

type DomRow = {
  text: string;
  label: string;
  unread: boolean;
};

export type OutlookBrowserMessage = {
  id: string;
  subject: string;
  sender: { name: string; address: string };
  receivedAt: string;
  preview: string;
  importance: "normal";
  isRead: boolean;
  hasAttachments: boolean;
  kind: "email";
  source: "outlook-web-list";
  bodyLimited: true;
};

const APP_DIR = join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "CanvasOrganizer");
const PROFILE_DIR = join(APP_DIR, "outlook-browser-profile");
const RUNTIME_FILE = join(APP_DIR, "outlook-browser-runtime.json");
const MARKER_FILE = join(APP_DIR, "outlook-browser-authenticated.json");
const START_URL = "https://outlook.office.com/mail/";
const messageCache = new Map<string, OutlookBrowserMessage>();

function safeText(value: unknown, fallback = "", maxLength = 1_500): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength) || fallback;
}

function officialOutlookHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "outlook.office.com" || host.endsWith(".outlook.office.com")
    || host === "outlook.office365.com" || host.endsWith(".outlook.office365.com");
}

export function outlookBrowserProfileLocation(): string {
  return PROFILE_DIR;
}

export function hasOutlookBrowserSession(): boolean {
  if (!existsSync(MARKER_FILE)) return false;
  try {
    const marker = JSON.parse(readFileSync(MARKER_FILE, "utf8")) as BrowserMarker;
    return typeof marker.authenticatedAt === "string" && typeof marker.user === "string";
  } catch {
    return false;
  }
}

function findBrowserExecutable(): string {
  const override = process.env.OUTLOOK_BROWSER_PATH;
  if (override) {
    const full = resolve(override);
    if (!existsSync(full)) throw new Error(`OUTLOOK_BROWSER_PATH does not exist: ${full}`);
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
  const preferred = (process.env.OUTLOOK_BROWSER || "chrome").toLowerCase() === "edge" ? [...edge, ...chrome] : [...chrome, ...edge];
  const found = preferred.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Chrome or Edge is required for Outlook Web login.");
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
  throw new Error("The dedicated Outlook browser did not start. A school or browser policy may be blocking remote debugging.");
}

async function launchDedicatedBrowser(headless: boolean): Promise<BrowserRuntime> {
  if (process.platform !== "win32") throw new Error("Outlook Web browser login is currently configured for Windows.");
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
  args.push(START_URL);
  const child = spawn(browserPath, args, { detached: true, stdio: "ignore", windowsHide: headless });
  child.unref();
  const runtime = { browserPath, port, pid: child.pid ?? 0, headless };
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), { encoding: "utf8", mode: 0o600 });
  await waitForEndpoint(port);
  return runtime;
}

async function liveRuntime(): Promise<BrowserRuntime | null> {
  const runtime = readRuntime();
  return runtime && await endpointIsAlive(runtime.port) ? runtime : null;
}

async function outlookTarget(runtime: BrowserRuntime, timeoutMs = 30_000): Promise<DebugTarget> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson<DebugTarget[]>(`http://127.0.0.1:${runtime.port}/json/list`);
    const target = targets.find((entry) => {
      try { return entry.type === "page" && officialOutlookHost(new URL(entry.url).hostname) && Boolean(entry.webSocketDebuggerUrl); }
      catch { return false; }
    });
    if (target) return target;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  throw new Error("Outlook Web login expired or redirected to school sign-in. Run /organizer-outlook-login on the organizer computer.");
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
      } catch { /* Ignore unrelated browser events. */ }
    });
    socket.addEventListener("close", () => {
      for (const handler of this.pending.values()) {
        clearTimeout(handler.timer);
        handler.reject(new Error("Outlook browser connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    if (typeof WebSocket === "undefined") throw new Error("This Pi runtime is too old for browser automation. Update Pi and try again.");
    const socket = new WebSocket(url);
    await new Promise<void>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to the Outlook browser.")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timeout); resolvePromise(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timeout); reject(new Error("Could not connect to the Outlook browser.")); }, { once: true });
    });
    return new CdpClient(socket);
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, 30_000);
      timer.unref?.();
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void { this.socket.close(); }
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: false });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Outlook browser script failed.");
  return response.result?.value as T;
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
  } catch { /* The browser may already be closed. */ }
  try { rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
}

export function normalizeOutlookDomRows(rows: DomRow[]): OutlookBrowserMessage[] {
  const output: OutlookBrowserMessage[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const rawLines = String(row.text || "").split(/\r?\n/).map((line) => safeText(line, "", 600)).filter(Boolean);
    const label = safeText(row.label, "", 1_500);
    const lines = rawLines.length ? rawLines : label.split(/\s*[,;]\s*/).map((line) => safeText(line, "", 600)).filter(Boolean);
    if (!lines.length) continue;
    const sender = lines[0];
    const subject = lines[1] || "(subject unavailable in Outlook Web list)";
    const preview = safeText(lines.slice(2).join(" · ") || label || row.text, "", 1_500);
    const fingerprint = `${sender}\n${subject}\n${preview}`;
    const id = `web-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 24)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    output.push({
      id,
      subject,
      sender: { name: sender, address: "" },
      receivedAt: lines.find((line) => /\b(?:today|yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[:/]\d{1,2})\b/i.test(line)) || "",
      preview,
      importance: "normal",
      isRead: !row.unread,
      hasAttachments: /\battachment\b/i.test(`${label} ${row.text}`),
      kind: "email",
      source: "outlook-web-list",
      bodyLimited: true,
    });
  }
  return output;
}

async function scrapeRows(client: CdpClient, maxResults: number, unreadOnly: boolean): Promise<DomRow[]> {
  return evaluate<DomRow[]>(client, `(async () => {
    const maxResults = ${JSON.stringify(maxResults)};
    const unreadOnly = ${JSON.stringify(unreadOnly)};
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const output = new Map();
    const rowElements = () => {
      const specific = [...document.querySelectorAll('[role="option"][data-convid], [role="option"][data-itemid], [data-convid], [data-itemid]')];
      const fallback = specific.length ? [] : [...document.querySelectorAll('main [role="option"], [role="main"] [role="option"]')];
      return [...new Set([...specific, ...fallback])].filter((element) => {
        const rect = element.getBoundingClientRect();
        const text = (element.innerText || '').trim();
        return rect.width > 180 && rect.height >= 28 && rect.height < 240 && text.length >= 3 && text.length < 5000;
      });
    };
    const collect = () => {
      for (const element of rowElements()) {
        const text = (element.innerText || '').trim();
        const label = element.getAttribute('aria-label') || element.getAttribute('title') || '';
        const unread = /(^|[,;\\s])unread([,;\\s]|$)/i.test(label)
          || Boolean(element.querySelector('[aria-label*="unread" i], [title*="unread" i]'));
        if (unreadOnly && !unread) continue;
        const key = [text, label].join('\\n');
        if (!output.has(key)) output.set(key, { text, label, unread });
        if (output.size >= maxResults) break;
      }
    };
    let rows = rowElements();
    const first = rows[0];
    let scroller = first?.parentElement || null;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const originalTop = scroller?.scrollTop || 0;
    if (scroller) scroller.scrollTop = 0;
    await wait(350);
    let unchanged = 0;
    let previousSize = -1;
    for (let pass = 0; pass < 30 && output.size < maxResults; pass += 1) {
      collect();
      if (!scroller) break;
      unchanged = output.size === previousSize ? unchanged + 1 : 0;
      previousSize = output.size;
      if (unchanged >= 3 || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
      scroller.scrollTop += Math.max(240, Math.floor(scroller.clientHeight * 0.8));
      await wait(350);
    }
    if (scroller) scroller.scrollTop = originalTop;
    return [...output.values()].slice(0, maxResults);
  })()`);
}

async function withOutlookPage<T>(work: (client: CdpClient) => Promise<T>): Promise<T> {
  if (!hasOutlookBrowserSession()) throw new Error("Outlook Web browser login has not been saved. Run /organizer-outlook-login on the organizer computer.");
  let runtime = await liveRuntime();
  let launchedHere = false;
  if (!runtime) {
    runtime = await launchDedicatedBrowser(true);
    launchedHere = true;
  }
  try {
    const target = await outlookTarget(runtime);
    const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
    try {
      const ready = await evaluate<boolean>(client, `Boolean(document.querySelector('[role="main"], main')) && !/sign in/i.test(document.title)`);
      if (!ready) throw new Error("Outlook Web is not ready. Run /organizer-outlook-login and complete school sign-in again.");
      return await work(client);
    } finally {
      client.close();
    }
  } finally {
    if (launchedHere) await closeHeadlessBrowser(runtime);
  }
}

export async function loginOutlookWithBrowser(timeoutMs = 10 * 60_000): Promise<{ user: string; profileDir: string }> {
  let runtime = await liveRuntime();
  if (runtime?.headless) {
    await closeHeadlessBrowser(runtime);
    runtime = null;
  }
  if (!runtime) runtime = await launchDedicatedBrowser(false);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const target = await outlookTarget(runtime, 2_000);
      const client = await CdpClient.connect(target.webSocketDebuggerUrl!);
      try {
        const status = await evaluate<{ ready: boolean; user: string }>(client, `(() => {
          const ready = Boolean(document.querySelector('[role="main"], main')) && !/sign in/i.test(document.title);
          const account = [...document.querySelectorAll('button[aria-label], [role="button"][aria-label]')]
            .map((element) => element.getAttribute('aria-label') || '')
            .find((label) => /account|profile/i.test(label)) || '';
          return { ready, user: account.slice(0, 300) };
        })()`);
        if (status.ready) {
          const user = safeText(status.user, "Outlook Web user", 200);
          mkdirSync(APP_DIR, { recursive: true });
          writeFileSync(MARKER_FILE, JSON.stringify({ authenticatedAt: new Date().toISOString(), user } satisfies BrowserMarker, null, 2), { encoding: "utf8", mode: 0o600 });
          return { user, profileDir: PROFILE_DIR };
        }
      } finally {
        client.close();
      }
    } catch {
      // The user may still be completing school SSO or MFA.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  throw new Error("Outlook Web sign-in was not detected within 10 minutes. Run /organizer-outlook-login to try again.");
}

export async function listOutlookBrowserMessages(options: { maxResults?: number; unreadOnly?: boolean } = {}): Promise<OutlookBrowserMessage[]> {
  const maxResults = Math.max(1, Math.min(200, Math.floor(options.maxResults ?? 50)));
  const rows = await withOutlookPage((client) => scrapeRows(client, maxResults, Boolean(options.unreadOnly)));
  const messages = normalizeOutlookDomRows(rows).slice(0, maxResults);
  messageCache.clear();
  for (const message of messages) messageCache.set(message.id, message);
  if (!messages.length) throw new Error("Outlook Web did not expose any inbox rows. Open /organizer-outlook-login and make sure the inbox is visible in the dedicated browser.");
  return messages;
}

export async function getOutlookBrowserMessage(messageId: string): Promise<OutlookBrowserMessage & { body: string; limitation: string }> {
  const message = messageCache.get(messageId);
  if (!message) throw new Error("That Outlook Web message ID is no longer active. Run an Outlook mail scan again and choose an exact returned ID.");
  return {
    ...message,
    body: message.preview,
    limitation: "Browser mode reads only text already exposed in Outlook's inbox list. It does not open messages because that could mark unread mail as read.",
  };
}

export async function checkOutlookBrowser(): Promise<{ displayName: string; address: string }> {
  const marker = JSON.parse(readFileSync(MARKER_FILE, "utf8")) as BrowserMarker;
  await withOutlookPage(async () => undefined);
  return { displayName: safeText(marker.user, "Outlook Web user", 200), address: "" };
}
