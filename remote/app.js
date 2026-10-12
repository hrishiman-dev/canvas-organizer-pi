const messages = document.querySelector("#messages");
const composer = document.querySelector("#composer");
const promptInput = document.querySelector("#prompt");
const imageInput = document.querySelector("#image-input");
const attachButton = document.querySelector("#attach-button");
const attachmentTray = document.querySelector("#attachment-tray");
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
let selectedImages = [];
const pendingPrompts = new Map();
const HEARTBEAT_STALE_MS = 40_000;
const BACKGROUND_RECONNECT_MS = 10_000;
const DRAFT_KEY = "organizer-remote-draft";
const PENDING_KEY = "organizer-remote-pending-v1";
const CAN_AUTOFOCUS = matchMedia("(hover: hover) and (pointer: fine)").matches;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;

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
  const attached = Array.isArray(options.images) ? options.images : [];
  if (attached.length) {
    const gallery = document.createElement("div");
    gallery.className = "message-images";
    for (const image of attached) {
      if (!ALLOWED_IMAGE_TYPES.has(image?.mimeType) || typeof image?.data !== "string") continue;
      const preview = document.createElement("img");
      preview.src = `data:${image.mimeType};base64,${image.data}`;
      preview.alt = "Attached image";
      preview.loading = "lazy";
      gallery.append(preview);
    }
    if (gallery.children.length) bubble.append(gallery);
  } else if (options.imageCount) {
    const summary = document.createElement("div");
    summary.className = "image-summary";
    summary.textContent = `${options.imageCount} image${options.imageCount === 1 ? "" : "s"} attached`;
    bubble.append(summary);
  }
  const textBlock = document.createElement("div");
  textBlock.className = "bubble-text";
  textBlock.textContent = text;
  bubble.append(textBlock);
  wrapper.append(bubble);
  if (options.status) {
    const status = document.createElement("div");
    status.className = "message-status";
    status.textContent = options.status;
    wrapper.append(status);
  }
  messages.append(wrapper);
  scrollToBottom(options.forceScroll);
  return textBlock;
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
    const safe = [...pendingPrompts.entries()].map(([id, pending]) => [id, { ...pending, images: undefined }]);
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(safe));
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

async function post(path, body = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function imagePayload(image) {
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

async function sendPrompt(text, attachments = selectedImages) {
  const message = text.trim();
  const images = attachments.map(imagePayload);
  if ((!message && !images.length) || posting) return;
  const pendingId = crypto.randomUUID();
  const requestId = `prompt-${pendingId}`;
  const visibleMessage = message || "Attached image";
  pendingPrompts.set(pendingId, { text: message || "Please help me with the attached image(s).", images, imageCount: images.length, requestId, status: "Sending…", acceptedAt: 0, syncRequested: false });
  savePendingPrompts();
  appendMessage("user", visibleMessage, { images, pendingId, status: "Sending…", forceScroll: true });
  promptInput.value = "";
  selectedImages = [];
  renderAttachmentTray();
  saveDraft();
  resizeComposer();
  posting = true;
  setWorking(true, working ? "Queueing your message…" : "Starting Pi…");
  try {
    const result = await post("/api/prompt", { message, images, clientId: pendingId }, 45_000);
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
  if (pending.imageCount && !pending.images?.length) {
    showToast("Reattach the image before retrying this message.");
    return;
  }
  pendingPrompts.delete(id);
  savePendingPrompts();
  messages.querySelector(`[data-pending-id="${CSS.escape(id)}"]`)?.remove();
  sendPrompt(pending.text, pending.images || []);
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
  sendButton.disabled = posting || (!promptInput.value.trim() && !selectedImages.length);
  attachButton.disabled = posting || selectedImages.length >= MAX_IMAGE_COUNT;
  newButton.disabled = working || posting;
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("That image could not be read."));
    reader.readAsDataURL(blob);
  });
}

function loadBrowserImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("That image format could not be opened."));
    };
    image.src = url;
  });
}

async function optimizeLargeImage(file) {
  if (file.type === "image/gif" || file.size <= 3 * 1024 * 1024) return file;
  const image = await loadBrowserImage(file);
  const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.86));
  if (!blob) throw new Error("That image could not be optimized.");
  return blob;
}

async function prepareImage(file) {
  const mimeType = String(file.type || "").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) throw new Error(`${file.name || "That file"} is not a supported image.`);
  if (!file.size) throw new Error(`${file.name || "That image"} is empty.`);
  if (file.size > 24 * 1024 * 1024) throw new Error(`${file.name || "That image"} is too large to process.`);
  const prepared = await optimizeLargeImage(file);
  if (prepared.size > MAX_IMAGE_BYTES) throw new Error(`${file.name || "That image"} must be 6 MB or smaller.`);
  const dataUrl = await readAsDataUrl(prepared);
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("That image could not be encoded.");
  return {
    type: "image",
    name: file.name || "image",
    mimeType: prepared.type || mimeType,
    data: dataUrl.slice(separator + 1),
    byteLength: prepared.size,
  };
}

function renderAttachmentTray() {
  attachmentTray.replaceChildren();
  for (const [index, image] of selectedImages.entries()) {
    const item = document.createElement("div");
    item.className = "attachment";
    const preview = document.createElement("img");
    preview.src = `data:${image.mimeType};base64,${image.data}`;
    preview.alt = "";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-attachment";
    remove.setAttribute("aria-label", `Remove ${image.name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      selectedImages.splice(index, 1);
      renderAttachmentTray();
      resizeComposer();
    });
    item.append(preview, remove);
    attachmentTray.append(item);
  }
  attachmentTray.hidden = selectedImages.length === 0;
}

async function addImageFiles(files) {
  const available = MAX_IMAGE_COUNT - selectedImages.length;
  if (available <= 0) return showToast(`You can attach up to ${MAX_IMAGE_COUNT} images.`);
  const incoming = [...files].filter((file) => file.type?.startsWith("image/"));
  if (!incoming.length) return showToast("Choose a PNG, JPEG, WebP, or GIF image.");
  if (incoming.length > available) showToast(`Only the first ${available} image${available === 1 ? "" : "s"} will be attached.`);
  attachButton.disabled = true;
  try {
    for (const file of incoming.slice(0, available)) {
      const prepared = await prepareImage(file);
      const total = selectedImages.reduce((sum, image) => sum + image.byteLength, 0) + prepared.byteLength;
      if (total > MAX_IMAGE_TOTAL_BYTES) throw new Error("Attached images must total 16 MB or less.");
      selectedImages.push(prepared);
      renderAttachmentTray();
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "That image could not be attached.");
  } finally {
    imageInput.value = "";
    resizeComposer();
  }
}

function extractText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
  return "";
}

function extractImages(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter((part) => part?.type === "image" && ALLOWED_IMAGE_TYPES.has(part.mimeType) && typeof part.data === "string")
    .map(imagePayload);
}

function renderHistory(records) {
  const useful = (records || []).filter((message) => message?.role === "user" || message?.role === "assistant");
  const matchedPending = new Set();
  messages.replaceChildren();
  assistantBubble = null;
  for (const message of useful) {
    const text = extractText(message);
    const images = extractImages(message);
    if (!text && !images.length) continue;
    const match = message.role === "user"
      ? [...pendingPrompts.entries()].find(([id, pending]) => !matchedPending.has(id) && pending.text === text)
      : null;
    if (match) {
      const [id, pending] = match;
      matchedPending.add(id);
      appendMessage("user", text || "Attached image", { images: images.length ? images : pending.images, imageCount: pending.imageCount, pendingId: id, status: pending.status });
      setPendingStatus(id, pending.status, {
        accepted: pending.acceptedAt > 0,
        failed: pending.status.includes("not confirmed") || pending.status.includes("No reply") || pending.status.includes("failed"),
        retry: Boolean(pending.retrySafe),
      });
    } else {
      appendMessage(message.role, text, { images });
    }
  }
  for (const [id, pending] of pendingPrompts) {
    if (matchedPending.has(id)) continue;
    appendMessage("user", pending.text, { images: pending.images, imageCount: pending.imageCount, pendingId: id, status: pending.status });
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
    const canRetry = pending.retrySafe && (!pending.imageCount || pending.images?.length);
    if (record.status === "accepted" || record.status === "acknowledged" || record.status === "running") pending.acceptedAt ||= record.updatedAt || Date.now();
    setPendingStatus(id, pending.status, {
      accepted: ["accepted", "acknowledged", "running"].includes(record.status),
      failed: ["failed", "empty"].includes(record.status),
      retry: canRetry,
    });
    savePendingPrompts();
    if (record.status === "empty" && record.retrySafe) {
      showToast(canRetry ? "Pi ended without a reply. You can safely retry this message." : "Pi ended without a reply. Reattach the image to retry.");
    }
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

attachButton.addEventListener("click", () => imageInput.click());
imageInput.addEventListener("change", () => addImageFiles(imageInput.files || []));

composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  composer.classList.add("is-dragging");
});
composer.addEventListener("dragleave", () => composer.classList.remove("is-dragging"));
composer.addEventListener("drop", (event) => {
  composer.classList.remove("is-dragging");
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  addImageFiles(event.dataTransfer.files);
});

promptInput.addEventListener("input", () => {
  saveDraft();
  resizeComposer();
});
promptInput.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files || [])].filter((file) => file.type?.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  addImageFiles(images);
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
