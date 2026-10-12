import assert from "node:assert/strict";
import test from "node:test";
import { classifyAgentEnd, visibleText } from "../src/remote-protocol.mjs";

test("visibleText excludes private reasoning", () => {
  assert.equal(visibleText({ content: [
    { type: "thinking", thinking: "private" },
    { type: "text", text: "Hello" },
  ] }), "Hello");
});

test("a length-limited thinking-only response is safely retryable", () => {
  assert.deepEqual(classifyAgentEnd({
    type: "agent_end",
    willRetry: false,
    messages: [{ role: "assistant", stopReason: "length", content: [{ type: "thinking", thinking: "unfinished" }] }],
  }), { status: "empty", reason: "context_limit", retrySafe: true });
});

test("visible replies complete normally", () => {
  assert.deepEqual(classifyAgentEnd({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] }],
  }), { status: "completed", reason: null, retrySafe: false });
});

test("tool activity never offers an unsafe automatic retry", () => {
  assert.deepEqual(classifyAgentEnd({
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "length", content: [{ type: "toolCall", name: "calendar_add" }] }],
  }), { status: "empty", reason: "action_completed_without_text", retrySafe: false });
});
