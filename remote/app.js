const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send-button");
const stopButton = document.querySelector("#stop-button");
const newButton = document.querySelector("#new-button");
const syncButton = document.querySelector("#sync-button");
const activity = document.querySelector("#activity");
const connectionLabel = document.querySelector("#connection-label");
const dialog = document.querySelector("#confirm-dialog");
const dialogTitle = document.querySelector("#dialog-title");
const dialogMessage = document.querySelector("#dialog-message");
const toast = document.querySelector("#toast");

let assistantBubble = null;
let currentDialog = null;
let working = false;
let posting = false;
let toastTimer = null;
let eventSource = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastEventAt = 0;
let hiddenAt = 0;
let lastResumeAt = 0;
const pendingPrompts = new Map();
const HEARTBEAT_STALE_MS = 40_000;
const BACKGROUND_RECONNECT_MS = 10_000;
const DRAFT_KEY = "organizer-remote-draft";
const PENDING_KEY = "organizer-remote-pending-v1";
const CAN_AUTOFOCUS = matchMedia("(hover: hover) and (pointer: fine)").matches;

function scrollToBottom(force = false) {
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 140;
  if (force || nearBottom) messages.scrollTop = messages.scrollHeight;
}

function clearEmpty() {
  messages.querySelector(".empty-state")?.remove();
}

function bindSuggestions() {
  messages.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => sendPrompt(button.dataset.prompt || ""));
  });
}

function showEmptyState() {
  const welcome = document.createElement("div");
  welcome.className = "empty-state";
  welcome.innerHTML = `<p class="eyebrow">Canvas · Outlook · Calendar</p><h2>Your day, organized.</h2><p>Ask what’s due, find an important email, or change your calendar.</p><div class="suggestions" aria-label="Suggestions"><button type="button" data-prompt="What do I need to do today?">Today’s work</button><button type="button" data-prompt="Summarize recent Canvas announcements.">Announcements</button><button type="button" data-prompt="Scan my recent Outlook email for important future events. Show candidates, but do not add anything without my confirmation.">Outlook events</button><button type="button" data-prompt="What is on my calendar tomorrow?">Tomorrow</button></div>`;
  messages.append(welcome);
  bindSuggestions();
}

function appendMessage(role, text = "", options = {}) {
  clearEmpty();
  const wrapper = document.createElement("article");
  wrapper.className = `message ${role}`;
  if (options.pendingId) {
    wrapper.dataset.pendingId = options.pendingId;
    wrapper.classList.add("pending");
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrapper.append(bubble);
  if (options.status) {
    const status = document.createElement("div");
    status.className = "message-status";
    status.textContent = options.status;
    wrapper.append(status);
  }
  messages.append(wrapper);
  scrollToBottom(options.forceScroll);
  return bubble;
}

function setPendingStatus(id, label, options = {}) {
  const wrapper = messages.querySelector(`[data-pending-id="${CSS.escape(id)}"]`);
  if (!wrapper) return;
  wrapper.classList.toggle("failed", Boolean(options.failed));
  wrapper.classList.toggle("accepted", Boolean(options.accepted));
  let status = wrapper.querySelector(".message-status");
  if (!status) {
    status = document.createElement("div");
    status.className = "message-status";
    wrapper.append(status);
  }
  status.replaceChildren(document.createTextNode(label));
  if (options.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "inline-action";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => retryPrompt(id));
    status.append(" · ", retry);
  }
}

function savePendingPrompts() {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify([...pendingPrompts.entries()]));
  } catch {
    // Delivery recovery still works for the current in-memory session.
  }
}

function restorePendingPrompts() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "[]");
    for (const [id, pending] of saved) {
      if (typeof id === "string" && typeof pending?.text === "string") pendingPrompts.set(id, pending);
    }
  } catch {
    sessionStorage.removeItem(PENDING_KEY);
  }
}

function finishPending(id) {
  const wrapper = messages.querySelector(`[data-pending-id="${CSS.escape(id)}"]`);
  wrapper?.classList.remove("pending", "accepted", "failed");
  wrapper?.querySelector(".message-status")?.remove();
  pendingPrompts.delete(id);
  savePendingPrompts();
}

function setConnection(mode, label) {
  document.body.classList.toggle("is-offline", mode === "offline");
  document.body.classList.toggle("is-connecting", mode === "connecting");
  document.body.dataset.connection = mode;
  connectionLabel.textContent = label;
}

function setWorking(value, label = value ? "Thinking…" : "") {
  working = value;
  stopButton.hidden = !value;
  activity.hidden = !label;
  activity.textContent = label;
  newButton.disabled = value || posting;
  sendButton.setAttribute("aria-label", value ? "Queue message" : "Send message");
  resizeComposer();
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}

async function post(path, body = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("The connection timed out. Tap Sync before retrying.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  let value = {};
  try { value = raw ? JSON.parse(raw) : {}; } catch { value = { error: raw || "Unreadable server response" }; }
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value;
}

async function sendPrompt(text) {
  const message = text.trim();
  if (!message || posting) return;
  const pendingId = crypto.randomUUID();
  const requestId = `prompt-${pendingId}`;
  pendingPrompts.set(pendingId, { text: message, requestId, status: "Sending…", acceptedAt: 0, syncRequested: false });
  savePendingPrompts();
  appendMessage("user", message, { pendingId, status: "Sending…", forceScroll: true });
  promptInput.value = "";
  saveDraft();
  resizeComposer();
  posting = true;
  setWorking(true, working ? "Queueing your message…" : "Starting Pi…");
  try {
    const result = await post("/api/prompt", { message, clientId: pendingId });
    const pending = pendingPrompts.get(pendingId);
    if (pending) {
      pending.requestId = result.requestId || requestId;
      pending.status = "Accepted — waiting for Pi…";
      pending.acceptedAt = Date.now();
      setPendingStatus(pendingId, pending.status, { accepted: true });
      savePendingPrompts();
    }
  } catch (error) {
    const pending = pendingPrompts.get(pendingId);
    if (pending) pending.status = "Delivery not confirmed — tap Sync";
    setPendingStatus(pendingId, "Delivery not confirmed — tap Sync", { failed: true });
    savePendingPrompts();
    setWorking(false);
    showToast(`Could not confirm delivery: ${error.message}`);
  } finally {
    posting = false;
    resizeComposer();
    if (CAN_AUTOFOCUS) promptInput.focus({ preventScroll: true });
  }
}

function retryPrompt(id) {
  const pending = pendingPrompts.get(id);
  if (!pending) return;
  pendingPrompts.delete(id);
  savePendingPrompts();
  messages.querySelector(`[data-pending-id="${CSS.escape(id)}"]`)?.remove();
  sendPrompt(pending.text);
}

function saveDraft() {
  try {
    if (promptInput.value) localStorage.setItem(DRAFT_KEY, promptInput.value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Storage is optional; the composer still works normally.
  }
}

function restoreDraft() {
  try { promptInput.value = localStorage.getItem(DRAFT_KEY) || ""; } catch { /* Storage is optional. */ }
}

function resizeComposer() {
  promptInput.style.height = "auto";
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 160)}px`;
  sendButton.disabled = posting || !promptInput.value.trim();
  newButton.disabled = working || posting;
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  return "";
}

function renderHistory(records) {
  const useful = (records || []).filter((message) => message?.role === "user" || message?.role === "assistant");
  const matchedPending = new Set();
  messages.replaceChildren();
  assistantBubble = null;
  for (const message of useful) {
    const text = extractText(message);
    if (!text) continue;
    const match = message.role === "user"
      ? [...pendingPrompts.entries()].find(([id, pending]) => !matchedPending.has(id) && pending.text === text)
      : null;
    if (match) {
      const [id, pending] = match;
      matchedPending.add(id);
      appendMessage("user", text, { pendingId: id, status: pending.status });
      setPendingStatus(id, pending.status, {
        accepted: pending.acceptedAt > 0,
        failed: pending.status.includes("not confirmed") || pending.status.includes("No reply") || pending.status.includes("failed"),
        retry: Boolean(pending.retrySafe),
      });
    } else {
      appendMessage(message.role, text);
    }
  }
  for (const [id, pending] of pendingPrompts) {
    if (matchedPending.has(id)) continue;
    appendMessage("user", pending.text, { pendingId: id, status: pending.status });
    setPendingStatus(id, pending.status, { accepted: pending.acceptedAt > 0, failed: pending.status.includes("not confirmed") || pending.status.includes("No reply") || pending.status.includes("failed"), retry: Boolean(pending.retrySafe) });
  }
  if (!messages.children.length) showEmptyState();
  scrollToBottom();
}

function clearConversation() {
  messages.replaceChildren();
  pendingPrompts.clear();
  savePendingPrompts();
  assistantBubble = null;
  showEmptyState();
}

function showConfirmation(record) {
  currentDialog = record;
  dialogTitle.textContent = record.title || "Confirm action";
  dialogMessage.textContent = record.message || "Do you want to continue?";
  dialog.returnValue = "";
  dialog.showModal();
}

async function respondToDialog(confirmed) {
  if (!currentDialog) return;
  const request = currentDialog;
  currentDialog = null;
  try {
    await post("/api/ui-response", { id: request.id, confirmed });
  } catch (error) {
    showToast(error.message);
  }
}

function pendingForRecord(record) {
  for (const [id, pending] of pendingPrompts) {
    if (pending.requestId === record.id) return { id, pending };
  }
  return null;
}

function handleRecord(record) {
  if (record.type === "heartbeat") {
    if (document.body.dataset.connection !== "connected") setConnection("connected", "Private connection ready");
    return;
  }
  if (record.type === "bridge_status") {
    const labels = { stopped: "Pi starts when you send a message", starting: "Starting Pi…", ready: "Private connection ready", working: "Pi is working…", error: "Pi needs setup" };
    setConnection(record.state === "error" ? "offline" : "connected", labels[record.state] || record.state);
    if (record.state === "working") setWorking(true, "Thinking…");
    if (record.state === "ready" || record.state === "stopped" || record.state === "error") setWorking(false);
    if (record.error) showToast(record.error);
    return;
  }
  if (record.type === "bridge_prompt_status") {
    const id = record.clientId;
    const pending = pendingPrompts.get(id);
    if (!pending) return;
    const labels = {
      accepted: "Sent to Organizer…",
      acknowledged: "Delivered to Pi…",
      running: "Pi is working…",
      failed: "Delivery failed",
      empty: record.reason === "context_limit"
        ? "No reply — the model ran out of context"
        : record.reason === "action_completed_without_text"
          ? "The action finished, but Pi gave no written reply"
          : "No visible reply was produced",
    };
    if (record.status === "completed") {
      finishPending(id);
      return;
    }
    pending.status = labels[record.status] || pending.status;
    pending.retrySafe = Boolean(record.retrySafe);
    if (record.status === "accepted" || record.status === "acknowledged" || record.status === "running") pending.acceptedAt ||= record.updatedAt || Date.now();
    setPendingStatus(id, pending.status, {
      accepted: ["accepted", "acknowledged", "running"].includes(record.status),
      failed: ["failed", "empty"].includes(record.status),
      retry: pending.retrySafe,
    });
    savePendingPrompts();
    if (record.status === "empty" && record.retrySafe) showToast("Pi ended without a reply. You can safely retry this message.");
    if (record.status === "failed") setWorking(false);
    return;
  }
  if (record.type === "agent_start") {
    assistantBubble = null;
    setWorking(true, "Thinking…");
    return;
  }
  if (record.type === "message_update") {
    const event = record.assistantMessageEvent || record.messageEvent || record.event || {};
    if (event.type === "text_delta" && typeof event.delta === "string") {
      if (!assistantBubble) assistantBubble = appendMessage("assistant");
      assistantBubble.textContent += event.delta;
      scrollToBottom();
    }
    return;
  }
  if (record.type === "tool_execution_start") {
    const name = record.toolName || record.tool || "a tool";
    setWorking(true, `Using ${String(name).replaceAll("_", " ")}…`);
    return;
  }
  if (record.type === "agent_settled") {
    setWorking(false);
    assistantBubble = null;
    return;
  }
  if (record.type === "extension_ui_request") {
    if (record.method === "confirm") showConfirmation(record);
    if (record.method === "notify") showToast(record.message || "Organizer notification");
    return;
  }
  if (record.type === "extension_ui_resolved") {
    if (currentDialog?.id === record.id) {
      currentDialog = null;
      if (dialog.open) dialog.close("resolved");
    }
    return;
  }
  if (record.type === "response" && record.command === "get_messages" && record.success) {
    renderHistory(record.data?.messages);
    return;
  }
  if (record.type === "response" && record.command === "new_session" && record.success && !record.data?.cancelled) {
    clearConversation();
    setWorking(false);
    return;
  }
  if (record.type === "response" && record.command === "prompt") {
    const match = pendingForRecord(record);
    if (!record.success) {
      setWorking(false);
      if (match) {
        match.pending.status = "Pi rejected this message";
        setPendingStatus(match.id, match.pending.status, { failed: true, retry: true });
      }
      showToast(record.error || "Pi rejected the message.");
    } else if (record.data?.disposition === "handled") {
      if (match) {
        match.pending.status = "Delivered";
        setPendingStatus(match.id, match.pending.status, { accepted: true });
      }
      setWorking(false);
    } else if (record.data?.disposition === "queued") {
      if (match) {
        match.pending.status = "Queued";
        setPendingStatus(match.id, match.pending.status, { accepted: true });
      }
      setWorking(true, "Message queued — Pi is finishing the current response…");
      showToast("Message queued.");
    } else if (match) {
      match.pending.status = "Delivered to Pi…";
      match.pending.acceptedAt ||= Date.now();
      setPendingStatus(match.id, match.pending.status, { accepted: true });
      savePendingPrompts();
    }
    return;
  }
  if (record.type === "response" && record.command === "abort") {
    setWorking(false);
    return;
  }
  if (record.type === "response" && record.success === false) {
    showToast(record.error || "Pi rejected the request.");
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  sendPrompt(promptInput.value);
});

promptInput.addEventListener("input", () => {
  saveDraft();
  resizeComposer();
});
promptInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try { await post("/api/abort"); } catch (error) { showToast(error.message); }
  finally { stopButton.disabled = false; }
});

newButton.addEventListener("click", async () => {
  if (working || !confirm("Start a new conversation?")) return;
  try {
    await post("/api/new");
  } catch (error) { showToast(error.message); }
});

dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "resolved") respondToDialog(dialog.returnValue === "confirm");
});

async function requestSync() {
  try { await post("/api/sync"); } catch { /* Reopening the event stream remains the fallback. */ }
}

function scheduleReconnect() {
  if (reconnectTimer || document.visibilityState === "hidden") return;
  const delay = Math.min(1_000 * (2 ** reconnectAttempt), 10_000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEvents("retry");
  }, delay);
}

function connectEvents(reason = "connect") {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (eventSource) eventSource.close();
  setConnection("connecting", reason === "manual" ? "Syncing conversation…" : "Connecting…");
  const source = new EventSource(`/api/events?connection=${Date.now()}`);
  eventSource = source;
  source.onopen = () => {
    if (source !== eventSource) return;
    lastEventAt = Date.now();
    reconnectAttempt = 0;
    setConnection("connected", "Private connection ready");
  };
  source.onmessage = (event) => {
    if (source !== eventSource) return;
    lastEventAt = Date.now();
    try { handleRecord(JSON.parse(event.data)); } catch { showToast("Received an unreadable Pi update."); }
  };
  source.onerror = () => {
    if (source !== eventSource) return;
    source.close();
    setConnection("offline", navigator.onLine ? "Reconnecting…" : "Device is offline");
    scheduleReconnect();
  };
}

async function resumeConnection(reason = "resume", force = false) {
  const now = Date.now();
  if (!force && now - lastResumeAt < 1_500) return;
  lastResumeAt = now;
  const stale = !lastEventAt || now - lastEventAt > HEARTBEAT_STALE_MS;
  if (force || stale || !eventSource || eventSource.readyState !== EventSource.OPEN) {
    connectEvents(reason);
    return;
  }
  await requestSync();
}

syncButton.addEventListener("click", async () => {
  syncButton.disabled = true;
  await resumeConnection("manual", true);
  setTimeout(() => { syncButton.disabled = false; }, 1_000);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenAt = Date.now();
    return;
  }
  const slept = hiddenAt && Date.now() - hiddenAt > BACKGROUND_RECONNECT_MS;
  hiddenAt = 0;
  resumeConnection("resume", slept);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) resumeConnection("restore", true);
});
window.addEventListener("focus", () => resumeConnection("focus"));
window.addEventListener("online", () => resumeConnection("online", true));
window.addEventListener("offline", () => setConnection("offline", "Device is offline"));

setInterval(() => {
  if (document.visibilityState === "visible" && lastEventAt && Date.now() - lastEventAt > HEARTBEAT_STALE_MS) {
    resumeConnection("stale", true);
  }
  const now = Date.now();
  for (const [id, pending] of pendingPrompts) {
    if (!pending.acceptedAt) continue;
    const age = now - pending.acceptedAt;
    if (age > 90_000) {
      pending.status = "Still waiting — tap Sync";
      setPendingStatus(id, pending.status, { accepted: true });
    } else if (age > 15_000 && !working) {
      pending.status = "Waiting for Pi…";
      setPendingStatus(id, pending.status, { accepted: true });
    }
    if (age > 30_000 && !pending.syncRequested) {
      pending.syncRequested = true;
      requestSync();
    }
  }
}, 5_000);

restoreDraft();
restorePendingPrompts();
bindSuggestions();
resizeComposer();
connectEvents();
if (CAN_AUTOFOCUS) promptInput.focus({ preventScroll: true });
