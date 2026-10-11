import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
const SCOPES = "offline_access User.Read Mail.Read";
const tokenDir = join(process.env.APPDATA || join(homedir(), ".config"), "canvas-organizer");
const tokenPath = join(tokenDir, "microsoft-token.json");

type TokenFile = { refreshToken: string };

export type OutlookLoginSession = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
};

export type OutlookMessageSummary = {
  id: string;
  subject: string;
  sender: { name: string; address: string };
  receivedAt: string;
  preview: string;
  importance: "low" | "normal" | "high";
  isRead: boolean;
  hasAttachments: boolean;
  kind: "email" | "meeting-message";
};

function oauthConfig(): { clientId: string; tenant: string } {
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const tenant = process.env.MICROSOFT_TENANT_ID?.trim() || "common";
  if (!clientId) throw new Error("Outlook is not configured. Set MICROSOFT_CLIENT_ID, then run /organizer-outlook-login.");
  if (!/^[a-zA-Z0-9.-]{1,100}$/.test(tenant)) throw new Error("MICROSOFT_TENANT_ID is invalid.");
  return { clientId, tenant };
}

function safeText(value: unknown, fallback = "", maxLength = 1_000): string {
  if (typeof value !== "string") return fallback;
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || fallback;
}

function microsoftUrl(path: string): string {
  const { tenant } = oauthConfig();
  return `${MICROSOFT_LOGIN_ORIGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/${path}`;
}

async function formRequest(url: string, params: URLSearchParams, signal?: AbortSignal): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal,
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

async function readToken(): Promise<TokenFile> {
  try {
    const parsed = JSON.parse(await readFile(tokenPath, "utf8"));
    if (typeof parsed.refreshToken !== "string") throw new Error("missing refresh token");
    return parsed;
  } catch {
    throw new Error("Outlook is not authorized. Run /organizer-outlook-login first.");
  }
}

async function storeToken(refreshToken: string): Promise<void> {
  await mkdir(tokenDir, { recursive: true });
  await writeFile(tokenPath, JSON.stringify({ refreshToken }, null, 2), { encoding: "utf8", mode: 0o600 });
  if (platform() !== "win32") await chmod(tokenPath, 0o600);
}

async function accessToken(signal?: AbortSignal): Promise<string> {
  const { clientId } = oauthConfig();
  const { refreshToken } = await readToken();
  const response = await formRequest(microsoftUrl("token"), new URLSearchParams({
    client_id: clientId,
    scope: SCOPES,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }), signal);
  if (!response.ok || typeof response.body.access_token !== "string") {
    throw new Error(`Outlook authorization failed (${response.status}): ${safeText(response.body.error_description ?? response.body.error, "unknown error", 300)}`);
  }
  if (typeof response.body.refresh_token === "string" && response.body.refresh_token !== refreshToken) {
    await storeToken(response.body.refresh_token);
  }
  return response.body.access_token;
}

export function outlookGraphUrl(pathOrUrl: string): URL {
  const url = new URL(pathOrUrl, `${GRAPH_ORIGIN}/v1.0/`);
  if (url.origin !== GRAPH_ORIGIN || !url.pathname.startsWith("/v1.0/")) throw new Error("Microsoft Graph returned an unsafe continuation URL.");
  return url;
}

async function graphRequest(pathOrUrl: string, signal?: AbortSignal): Promise<any> {
  const url = outlookGraphUrl(pathOrUrl);
  const token = await accessToken(signal);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      Prefer: 'outlook.timezone="UTC", odata.maxpagesize=50',
    },
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Outlook request failed (${response.status}): ${safeText(body?.error?.message, "unknown error", 300)}`);
  }
  return body;
}

function officialVerificationUri(value: unknown): string {
  if (typeof value !== "string") throw new Error("Microsoft did not return a verification URL.");
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "microsoft.com" || host.endsWith(".microsoft.com"))) {
    throw new Error("Microsoft returned an unexpected verification URL.");
  }
  return url.toString();
}

export async function beginOutlookLogin(signal?: AbortSignal): Promise<OutlookLoginSession> {
  const { clientId } = oauthConfig();
  const response = await formRequest(microsoftUrl("devicecode"), new URLSearchParams({ client_id: clientId, scope: SCOPES }), signal);
  if (!response.ok) {
    throw new Error(`Outlook sign-in could not start (${response.status}): ${safeText(response.body.error_description ?? response.body.error, "unknown error", 300)}`);
  }
  const deviceCode = response.body.device_code;
  const userCode = safeText(response.body.user_code, "", 30);
  const expiresIn = Number(response.body.expires_in);
  const intervalSeconds = Number(response.body.interval);
  if (typeof deviceCode !== "string" || !userCode || !Number.isFinite(expiresIn)) throw new Error("Microsoft returned an incomplete device sign-in response.");
  return {
    deviceCode,
    userCode,
    verificationUri: officialVerificationUri(response.body.verification_uri),
    expiresAt: Date.now() + Math.max(60, expiresIn) * 1_000,
    intervalSeconds: Number.isFinite(intervalSeconds) ? Math.max(5, intervalSeconds) : 5,
  };
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Outlook sign-in was cancelled."));
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Outlook sign-in was cancelled."));
    }, { once: true });
  });
}

export async function finishOutlookLogin(session: OutlookLoginSession, signal?: AbortSignal): Promise<{ displayName: string; address: string }> {
  const { clientId } = oauthConfig();
  let intervalSeconds = session.intervalSeconds;
  while (Date.now() < session.expiresAt) {
    const response = await formRequest(microsoftUrl("token"), new URLSearchParams({
      client_id: clientId,
      device_code: session.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }), signal);
    if (response.ok && typeof response.body.access_token === "string" && typeof response.body.refresh_token === "string") {
      await storeToken(response.body.refresh_token);
      const profileResponse = await fetch(`${GRAPH_ORIGIN}/v1.0/me?$select=displayName,mail,userPrincipalName`, {
        headers: { Authorization: `Bearer ${response.body.access_token}`, Accept: "application/json" },
        signal,
      });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok) throw new Error(`Outlook profile lookup failed (${profileResponse.status}).`);
      return {
        displayName: safeText(profile.displayName, "Microsoft user", 200),
        address: safeText(profile.mail ?? profile.userPrincipalName, "", 320),
      };
    }
    const code = response.body.error;
    if (code === "authorization_pending") {
      await wait(intervalSeconds * 1_000, signal);
      continue;
    }
    if (code === "slow_down") {
      intervalSeconds += 5;
      await wait(intervalSeconds * 1_000, signal);
      continue;
    }
    throw new Error(`Outlook sign-in failed: ${safeText(response.body.error_description ?? code, "unknown error", 300)}`);
  }
  throw new Error("Outlook sign-in code expired. Run /organizer-outlook-login again.");
}

export function normalizeOutlookMessage(message: any): OutlookMessageSummary | null {
  if (!message || typeof message.id !== "string") return null;
  const address = message.from?.emailAddress ?? {};
  return {
    id: message.id,
    subject: safeText(message.subject, "(no subject)", 500),
    sender: {
      name: safeText(address.name, "Unknown sender", 200),
      address: safeText(address.address, "", 320),
    },
    receivedAt: typeof message.receivedDateTime === "string" ? message.receivedDateTime : "",
    preview: safeText(message.bodyPreview, "", 1_000),
    importance: ["low", "normal", "high"].includes(message.importance) ? message.importance : "normal",
    isRead: Boolean(message.isRead),
    hasAttachments: Boolean(message.hasAttachments),
    kind: typeof message["@odata.type"] === "string" && message["@odata.type"].toLowerCase().includes("eventmessage") ? "meeting-message" : "email",
  };
}

export async function listOutlookMessages(options: { daysBack?: number; maxResults?: number; unreadOnly?: boolean; signal?: AbortSignal } = {}): Promise<OutlookMessageSummary[]> {
  const daysBack = Math.max(1, Math.min(365, Math.floor(options.daysBack ?? 30)));
  const maxResults = Math.max(1, Math.min(200, Math.floor(options.maxResults ?? 50)));
  const since = new Date(Date.now() - daysBack * 86_400_000).toISOString();
  const filters = [`receivedDateTime ge ${since}`];
  if (options.unreadOnly) filters.push("isRead eq false");
  const params = new URLSearchParams({
    "$select": "id,subject,from,receivedDateTime,bodyPreview,importance,isRead,hasAttachments,inferenceClassification",
    "$filter": filters.join(" and "),
    "$orderby": "receivedDateTime desc",
    "$top": String(Math.min(50, maxResults)),
  });
  let next: string | null = `${GRAPH_ORIGIN}/v1.0/me/messages?${params}`;
  const messages: OutlookMessageSummary[] = [];
  while (next && messages.length < maxResults) {
    const body = await graphRequest(next, options.signal);
    for (const raw of Array.isArray(body.value) ? body.value : []) {
      const normalized = normalizeOutlookMessage(raw);
      if (normalized) messages.push(normalized);
      if (messages.length >= maxResults) break;
    }
    next = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : null;
  }
  return messages;
}

function validMessageId(value: string): string {
  if (!value || value.length > 1_500 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid Outlook message ID.");
  return value;
}

export async function getOutlookMessage(messageId: string, signal?: AbortSignal): Promise<any> {
  const id = validMessageId(messageId);
  const body = await graphRequest(`${GRAPH_ORIGIN}/v1.0/me/messages/${encodeURIComponent(id)}?$expand=microsoft.graph.eventMessage/event`, signal);
  const summary = normalizeOutlookMessage(body);
  if (!summary) throw new Error("Outlook did not return the requested message.");
  const event = body.event;
  return {
    ...summary,
    body: safeText(body.body?.content ?? body.bodyPreview, "", 8_000),
    meetingType: safeText(body.meetingMessageType, "none", 50),
    associatedMeeting: event && typeof event === "object" ? {
      subject: safeText(event.subject, summary.subject, 500),
      start: typeof event.start?.dateTime === "string" ? { dateTime: event.start.dateTime, timeZone: safeText(event.start.timeZone, "UTC", 100) } : null,
      end: typeof event.end?.dateTime === "string" ? { dateTime: event.end.dateTime, timeZone: safeText(event.end.timeZone, "UTC", 100) } : null,
      location: safeText(event.location?.displayName, "", 500) || null,
      organizer: safeText(event.organizer?.emailAddress?.name ?? event.organizer?.emailAddress?.address, "", 320) || null,
      cancelled: Boolean(event.isCancelled),
    } : null,
  };
}

export async function checkOutlook(signal?: AbortSignal): Promise<{ displayName: string; address: string }> {
  const profile = await graphRequest(`${GRAPH_ORIGIN}/v1.0/me?$select=displayName,mail,userPrincipalName`, signal);
  return {
    displayName: safeText(profile.displayName, "Microsoft user", 200),
    address: safeText(profile.mail ?? profile.userPrincipalName, "", 320),
  };
}

export function outlookTokenLocation(): string {
  return tokenPath;
}

export { safeText as safeOutlookText };

