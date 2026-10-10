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

test("remote bridge serves the UI securely and validates prompts", async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, [resolve("src/remote-server.mjs")], {
    cwd: resolve("."),
    env: { ...process.env, ORGANIZER_REMOTE_PORT: String(port), PI_COMMAND: "definitely-missing-pi-command" },
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

  const empty = await fetch(`${origin}/api/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "   " }),
  });
  assert.equal(empty.status, 400);

  const missing = await fetch(`${origin}/not-a-route`);
  assert.equal(missing.status, 404);
});
