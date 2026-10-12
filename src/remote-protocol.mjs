export function visibleText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasToolActivity(message) {
  if (!message) return false;
  if (message.role === "tool" || message.role === "toolResult") return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((part) => ["toolCall", "tool_call", "toolResult", "tool_result"].includes(part?.type));
}

export function classifyAgentEnd(record) {
  const messages = Array.isArray(record?.messages) ? record.messages : [];
  const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
  const text = visibleText(assistant);
  const toolActivity = messages.some(hasToolActivity)
    || (Array.isArray(record?.toolResults) && record.toolResults.length > 0);
  const stopReason = assistant?.stopReason || assistant?.rawStopReason || record?.stopReason || "";

  if (record?.willRetry) return { status: "running", reason: "retrying", retrySafe: false };
  if (text) return { status: "completed", reason: null, retrySafe: false };
  if (toolActivity) return { status: "empty", reason: "action_completed_without_text", retrySafe: false };
  if (stopReason === "length") return { status: "empty", reason: "context_limit", retrySafe: true };
  return { status: "empty", reason: "no_visible_reply", retrySafe: true };
}

export const imageUploadLimits = Object.freeze({
  count: 4,
  perImageBytes: 6 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
});

const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function normalizePromptImages(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Images must be sent as a list.");
  if (value.length > imageUploadLimits.count) throw new Error(`Attach no more than ${imageUploadLimits.count} images.`);

  let totalBytes = 0;
  return value.map((image) => {
    const mimeType = typeof image?.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const data = typeof image?.data === "string" ? image.data : "";
    if (image?.type !== "image" || !supportedImageTypes.has(mimeType)) {
      throw new Error("Only PNG, JPEG, WebP, and GIF images are supported.");
    }
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      throw new Error("An attached image is not valid base64 data.");
    }
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.toString("base64") !== data) throw new Error("An attached image is not valid base64 data.");
    if (bytes.length > imageUploadLimits.perImageBytes) throw new Error("Each image must be 6 MB or smaller.");
    totalBytes += bytes.length;
    if (totalBytes > imageUploadLimits.totalBytes) throw new Error("Attached images must total 16 MB or less.");
    return { type: "image", data, mimeType };
  });
}
