import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyAgentEnd } from "./remote-protocol.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = join(projectRoot, "remote");

loadEnv(join(projectRoot, ".env"));

const host = "127.0.0.1";
const port = boundedPort(process.env.ORGANIZER_REMOTE_PORT || "8787");
const heartbeatMs = boundedInterval(process.env.ORGANIZER_HEARTBEAT_MS || "15000", 100, 60_000);
const clients = new Map();
const pendingUiRequests = new Map();
const outboundQueue = [];
const promptQueue = [];
const promptRequests = new Map();
let piProcess = null;
let piBuffer = "";
let piState = "stopped";
let piError = null;
let piSpawned = false;
let activePromptId = null;

const terminalPromptStates = new Set(["completed", "empty", "failed"]);

function publicPromptStatus(request) {
  return {
    type: "bridge_prompt_status",
    id: request.id,
    clientId: request.clientId,
    status: request.status,
    reason: request.reason || null,
    retrySafe: Boolean(request.retrySafe),
    updatedAt: request.updatedAt,
  };
}

function setPromptStatus(id, status, details = {}) {
  const request = promptRequests.get(id);
  if (!request) return;
  Object.assign(request, details, { status, updatedAt: Date.now() });
  broadcast(publicPromptStatus(request));
  console.log(`[remote] Prompt ${id} is ${status}${request.reason ? ` (${request.reason})` : ""}.`);
  prunePromptRequests();
}

function prunePromptRequests() {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [id, request] of promptRequests) {
    if (terminalPromptStates.has(request.status) && request.updatedAt < cutoff) promptRequests.delete(id);
  }
  while (promptRequests.size > 200) {
    const oldestTerminal = [...promptRequests].find(([, request]) => terminalPromptStates.has(request.status))?.[0];
    if (!oldestTerminal) break;
    promptRequests.delete(oldestTerminal);
  }
}

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const sourceLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (/^[A-Z_][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

function boundedPort(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) throw new Error("ORGANIZER_REMOTE_PORT must be between 1024 and 65535.");
  return parsed;
}

function boundedInterval(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return 15_000;
  return parsed;
}

function piLaunch() {
  const bundledPi = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pi-node", "current", "pi.cmd") : "";
  const configuredPi = process.env.PI_COMMAND;
  let command = configuredPi && configuredPi.toLowerCase() !== "pi"
    ? configuredPi
    : bundledPi
      ? bundledPi
      : configuredPi || "pi";
  const args = [];
  if (process.platform === "win32" && /(?:^|[\\/])pi\.cmd$/i.test(command)) {
    const piDirectory = dirname(command);
    command = join(piDirectory, "node.exe");
    args.push(join(piDirectory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"));
  }
  args.push("--mode", "rpc", "--name", "Organizer Remote");
  if (process.env.PI_PROVIDER) args.push("--provider", process.env.PI_PROVIDER);
  if (process.env.PI_MODEL) args.push("--model", process.env.PI_MODEL);
  return { command, args };
}

function broadcast(record) {
  const payload = `data: ${JSON.stringify(record)}\n\n`;
  for (const [id, response] of clients) {
    try {
      response.write(payload);
    } catch {
      clients.delete(id);
    }
  }
}

function setPiState(state, error = null) {
  piState = state;
  piError = error;
  broadcast({ type: "bridge_status", state, error });
}

function ensurePi() {
  if (piProcess && !piProcess.killed) return piProcess;
  const { command, args } = piLaunch();
  setPiState("starting");
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  piProcess = child;
  piBuffer = "";
  piSpawned = false;

  child.once("spawn", () => {
    piSpawned = true;
    setPiState("ready");
    while (outboundQueue.length && child.stdin?.writable) {
      child.stdin.write(`${JSON.stringify(outboundQueue.shift())}\n`);
    }
    setTimeout(() => sendToPi({ id: `state-${randomUUID()}`, type: "get_state" }), 250).unref();
  });
  child.once("error", (error) => {
    if (piProcess === child) piProcess = null;
    piSpawned = false;
    outboundQueue.length = 0;
    pendingUiRequests.clear();
    failOpenPrompts("pi_start_failed");
    setPiState("error", `Could not start Pi. Set PI_COMMAND to the exact Pi executable path. (${error.message})`);
  });
  child.once("exit", (code, signal) => {
    if (piProcess === child) piProcess = null;
    piSpawned = false;
    outboundQueue.length = 0;
    pendingUiRequests.clear();
    failOpenPrompts("pi_exited");
    setPiState("stopped", code === 0 ? null : `Pi exited${code == null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}.`);
  });
  child.stdout.on("data", (chunk) => consumePiOutput(chunk));
  child.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message) process.stderr.write(`[pi] ${message}\n`);
  });
  return child;
}

function failOpenPrompts(reason) {
  for (const request of promptRequests.values()) {
    if (!terminalPromptStates.has(request.status)) setPromptStatus(request.id, "failed", { reason, retrySafe: true });
  }
  promptQueue.length = 0;
  activePromptId = null;
}

function consumePiOutput(chunk) {
  piBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  while (true) {
    const newline = piBuffer.indexOf("\n");
    if (newline < 0) break;
    let line = piBuffer.slice(0, newline);
    piBuffer = piBuffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === "extension_ui_request" && record.method !== "notify" && typeof record.id === "string") {
        pendingUiRequests.set(record.id, record);
      }
      broadcast(record);
      if (record.type === "agent_start") {
        setPiState("working");
        if (!activePromptId) {
          while (promptQueue.length && !activePromptId) {
            const candidate = promptQueue.shift();
            const request = promptRequests.get(candidate);
            if (request && !terminalPromptStates.has(request.status)) activePromptId = candidate;
          }
        }
        if (activePromptId) setPromptStatus(activePromptId, "running");
      }
      if (record.type === "agent_end" && activePromptId) {
        const classification = classifyAgentEnd(record);
        setPromptStatus(activePromptId, classification.status, classification);
        if (classification.status !== "running") activePromptId = null;
      }
      if (record.type === "agent_settled") {
        setPiState("ready");
        sendToPi({ id: `settled-history-${randomUUID()}`, type: "get_messages" });
      }
      if (record.type === "response" && record.command === "prompt") {
        if (record.success) setPromptStatus(record.id, "acknowledged");
        else {
          setPromptStatus(record.id, "failed", { reason: "pi_rejected", retrySafe: true });
          const index = promptQueue.indexOf(record.id);
          if (index >= 0) promptQueue.splice(index, 1);
        }
      }
    } catch {
      process.stderr.write("[pi] Ignored a non-JSON RPC output line.\n");
    }
  }
}

function sendToPi(record) {
  const child = ensurePi();
  if (!piSpawned || !child.stdin?.writable) {
    outboundQueue.push(record);
    return "queued";
  }
  child.stdin.write(`${JSON.stringify(record)}\n`);
  return "sent";
}

function securityHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

function json(response, status, body) {
  response.writeHead(status, securityHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  response.end(JSON.stringify(body));
}

async function readJson(request, maxBytes = 32_768) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function serveFile(response, filename) {
  const path = join(publicRoot, filename);
  if (!existsSync(path)) return json(response, 404, { error: "Not found" });
  const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" }[extname(path)] || "application/octet-stream";
  response.writeHead(200, securityHeaders({ "Content-Type": mime }));
  response.end(readFileSync(path));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${host}:${port}`);
  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, pi: { state: piState, error: piError, queued: outboundQueue.length }, clients: clients.size, port });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, securityHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      }));
      response.write("retry: 2000\n\n");
      response.write(`data: ${JSON.stringify({ type: "bridge_status", state: piState, error: piError })}\n\n`);
      const id = randomUUID();
      clients.set(id, response);
      for (const request of promptRequests.values()) {
        response.write(`data: ${JSON.stringify(publicPromptStatus(request))}\n\n`);
      }
      for (const pending of pendingUiRequests.values()) {
        response.write(`data: ${JSON.stringify(pending)}\n\n`);
      }
      const heartbeat = setInterval(() => {
        try {
          response.write(`data: ${JSON.stringify({ type: "heartbeat", state: piState, at: Date.now() })}\n\n`);
        } catch {
          clearInterval(heartbeat);
        }
      }, heartbeatMs);
      heartbeat.unref();
      request.once("close", () => {
        clearInterval(heartbeat);
        clients.delete(id);
      });
      if (piProcess) sendToPi({ id: `history-${id}`, type: "get_messages" });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/prompt") {
      const body = await readJson(request);
      const message = typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 8_000) return json(response, 400, { error: "Message must contain 1–8,000 characters." });
      const clientId = typeof body.clientId === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(body.clientId) ? body.clientId : randomUUID();
      const requestId = `prompt-${clientId}`;
      if (promptRequests.has(requestId) && !terminalPromptStates.has(promptRequests.get(requestId).status)) {
        return json(response, 409, { error: "That message is already being handled.", requestId });
      }
      promptRequests.set(requestId, {
        id: requestId,
        clientId,
        status: "accepted",
        reason: null,
        retrySafe: false,
        updatedAt: Date.now(),
      });
      promptQueue.push(requestId);
      const delivery = sendToPi({ id: requestId, type: "prompt", message, streamingBehavior: "followUp" });
      broadcast(publicPromptStatus(promptRequests.get(requestId)));
      console.log(`[remote] Accepted prompt ${requestId}; state=${piState}.`);
      return json(response, 202, { accepted: true, requestId, delivery });
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      if (piProcess && !piProcess.killed) {
        const requestId = `sync-${randomUUID()}`;
        sendToPi({ id: requestId, type: "get_messages" });
        return json(response, 202, { accepted: true, requestId, state: piState });
      }
      return json(response, 200, { accepted: false, state: piState });
    }
    if (request.method === "POST" && url.pathname === "/api/ui-response") {
      const body = await readJson(request);
      if (typeof body.id !== "string" || body.id.length > 200) return json(response, 400, { error: "Invalid dialog response." });
      if (!pendingUiRequests.has(body.id)) return json(response, 409, { error: "This confirmation is no longer active." });
      const record = { type: "extension_ui_response", id: body.id };
      if (body.cancelled === true) record.cancelled = true;
      else if (typeof body.confirmed === "boolean") record.confirmed = body.confirmed;
      else if (typeof body.value === "string" && body.value.length <= 8_000) record.value = body.value;
      else return json(response, 400, { error: "Invalid dialog value." });
      sendToPi(record);
      pendingUiRequests.delete(body.id);
      broadcast({ type: "extension_ui_resolved", id: body.id });
      return json(response, 200, { accepted: true });
    }
    if (request.method === "POST" && url.pathname === "/api/abort") {
      sendToPi({ id: `abort-${randomUUID()}`, type: "abort" });
      return json(response, 202, { accepted: true });
    }
    if (request.method === "POST" && url.pathname === "/api/new") {
      sendToPi({ id: `new-${randomUUID()}`, type: "new_session" });
      return json(response, 202, { accepted: true });
    }
    if (request.method !== "GET") return json(response, 405, { error: "Method not allowed" });
    const files = { "/": "index.html", "/index.html": "index.html", "/app.css": "app.css", "/app.js": "app.js", "/favicon.svg": "favicon.svg" };
    const filename = files[url.pathname];
    if (!filename) return json(response, 404, { error: "Not found" });
    return serveFile(response, filename);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json(response, 500, { error: message });
  }
});

server.listen(port, host, () => {
  console.log(`Organizer Remote is listening on http://${host}:${port}`);
  console.log("Keep this listener private; expose it only through Tailscale Serve.");
});

function shutdown() {
  if (piProcess?.stdin?.writable) piProcess.stdin.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
