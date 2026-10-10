const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const sendButton = document.querySelector("#send-button");
const stopButton = document.querySelector("#stop-button");
const newButton = document.querySelector("#new-button");
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
let reconnectToastShown = false;
const pendingPrompts = new Map();

function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
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
  welcome.innerHTML = `<h2>What do you need?</h2><p>Ask about Canvas, your schedule, or add something to your calendar.</p><div class="suggestions" aria-label="Suggestions"><button type="button" data-prompt="What do I need to do today?">Today’s work</button><button type="button" data-prompt="Summarize recent Canvas announcements.">Announcements</button><button type="button" data-prompt="What is on my calendar tomorrow?">Tomorrow</button></div>`;
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
  messages.append(wrapper);
  scrollToBottom();
  return bubble;
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
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  pendingPrompts.set(pendingId, message);
  appendMessage("user", message, { pendingId });
  promptInput.value = "";
  resizeComposer();
  posting = true;
  setWorking(true, working ? "Queueing your message…" : "Starting Pi…");
  try {
    await post("/api/prompt", { message });
  } catch (error) {
    pendingPrompts.delete(pendingId);
    messages.querySelector(`[data-pending-id="${CSS.escape(pendingId)}"]`)?.remove();
    setWorking(false);
    appendMessage("assistant", `Could not send that message: ${error.message}`);
  } finally {
    posting = false;
    resizeComposer();
    promptInput.focus();
  }
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
  const historyUserTexts = useful.filter((message) => message.role === "user").map(extractText);
  if (!working) {
    for (const [id, text] of pendingPrompts) {
      if (historyUserTexts.includes(text)) pendingPrompts.delete(id);
    }
  }
  messages.replaceChildren();
  assistantBubble = null;
  for (const message of useful) {
    const text = extractText(message);
    if (text) appendMessage(message.role, text);
  }
  for (const [id, text] of pendingPrompts) appendMessage("user", text, { pendingId: id });
  if (!messages.children.length) showEmptyState();
  scrollToBottom();
}

function clearConversation() {
  messages.replaceChildren();
  pendingPrompts.clear();
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

function handleRecord(record) {
  if (record.type === "bridge_status") {
    document.body.classList.remove("is-offline");
    const labels = { stopped: "Pi starts when you send a message", starting: "Starting Pi…", ready: "Private connection ready", working: "Pi is working…", error: "Pi needs setup" };
    connectionLabel.textContent = labels[record.state] || record.state;
    if (record.state === "working") setWorking(true, "Thinking…");
    if (record.state === "ready" || record.state === "stopped" || record.state === "error") setWorking(false);
    if (record.error) showToast(record.error);
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
    if (!record.success) {
      setWorking(false);
      showToast(record.error || "Pi rejected the message.");
    } else if (record.data?.disposition === "handled") {
      setWorking(false);
    } else if (record.data?.disposition === "queued") {
      setWorking(true, "Message queued — Pi is finishing the current response…");
      showToast("Message queued.");
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

promptInput.addEventListener("input", resizeComposer);
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

const events = new EventSource("/api/events");
events.onopen = () => {
  document.body.classList.remove("is-offline");
  reconnectToastShown = false;
};
events.onmessage = (event) => {
  try { handleRecord(JSON.parse(event.data)); } catch { showToast("Received an unreadable Pi update."); }
};
events.onerror = () => {
  document.body.classList.add("is-offline");
  connectionLabel.textContent = "Reconnecting…";
  if (!reconnectToastShown) {
    reconnectToastShown = true;
    showToast("Connection interrupted. Your conversation will resync automatically.");
  }
};

bindSuggestions();
resizeComposer();
promptInput.focus();
