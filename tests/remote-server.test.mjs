import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { resolve } from "node:path";

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitForHealth(origin, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return response;
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Remote bridge did not start in time.");
}

async function readSseUntil(origin, predicate, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("Event stream closed before the expected record arrived.");
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!data) continue;
        const record = JSON.parse(data);
        if (predicate(record)) return record;
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

test("remote bridge serves the UI securely and validates prompts", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("src/remote-server.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, ORGANIZER_REMOTE_PORT: String(port), ORGANIZER_HEARTBEAT_MS: "100", PI_COMMAND: "definitely-missing-pi-command" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => child.kill());

  const origin = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(origin);
  assert.equal((await health.json()).pi.state, "stopped");

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  assert.match(await page.text(), /<title>Organizer<\/title>/);

  const heartbeat = await readSseUntil(origin, (record) => record.type === "heartbeat");
  assert.ok(["starting", "error"].includes(heartbeat.state));
  assert.equal(typeof heartbeat.at, "number");

  const sync = await fetch(`${origin}/api/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(sync.status, 202);
  const syncBody = await sync.json();
  assert.equal(syncBody.accepted, true);
  assert.match(syncBody.requestId, /^sync-/);

  const empty = await fetch(`${origin}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(empty.status, 400);

  const imageOnly = await fetch(`${origin}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "",
      clientId: "image-test",
      images: [{ type: "image", mimeType: "image/png", data: Buffer.from("test-image").toString("base64") }],
    }),
  });
  assert.equal(imageOnly.status, 202);
  assert.equal((await imageOnly.json()).accepted, true);

  const unsupportedImage = await fetch(`${origin}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Look", images: [{ type: "image", mimeType: "image/svg+xml", data: "AAAA" }] }),
  });
  assert.equal(unsupportedImage.status, 400);

  const missing = await fetch(`${origin}/not-a-route`);
  assert.equal(missing.status, 404);
});
