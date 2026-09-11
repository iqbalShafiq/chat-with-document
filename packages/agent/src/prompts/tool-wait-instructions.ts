export const TOOL_WAIT_INSTRUCTION = [
  "Some tools may return JSON with status still_running and a toolCallId instead of a final result.",
  "That means the same call is still working. Do not treat still_running as success.",
  "Do not invoke the original tool again to poll it. Use await_tool_call with that toolCallId to wait another slice, or cancel_tool_call with that toolCallId to abort it.",
  "In the same turn as await_tool_call or cancel_tool_call, write a short user-visible message explaining that you are still waiting or that you stopped the work, using only elapsed time, stage, and progress from the still_running payload. Do not use request_clarification for this.",
  "After cancel_tool_call, you may call the original tool again only with improved arguments grounded in the tool error or still_running facts. Never invent results for a cancelled or unfinished tool.",
].join(" ");
