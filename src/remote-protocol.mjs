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
