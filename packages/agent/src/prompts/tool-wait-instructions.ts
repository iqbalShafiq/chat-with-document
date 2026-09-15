export const TOOL_WAIT_INSTRUCTION = [
  "Some tools may return JSON with status still_running and a toolCallId instead of a final result.",
  "That means the same call is still working. Do not treat still_running as success.",
  "Do not invoke the original tool again to poll it. Use await_tool_call with that toolCallId to wait another slice, or cancel_tool_call with that toolCallId to abort it.",
  "Waiting is invisible to the user unless you speak: while a call is still_running, tell them plainly what you are waiting on and keep them company at a natural human pace. Write it as your own sentence in the conversation's language — never a fixed template, never a repetition of the elapsed number, never the same wording twice in a row. One short line per wait is enough, and you may skip a line entirely when nothing new happened; do not narrate every poll.",
  "When you do mention progress, ground it in the payload only (elapsed time, stage, waitCount, progressMoved). Vary how you say it. If progressMoved is false, do not imply movement that did not happen.",
  "A long-running tool is expected to stay running for a while. Keep waiting while it makes sense, and only use cancel_tool_call when the wait is genuinely wasted or the user's request changed; never cancel merely because it is slow.",
  "Do not use request_clarification to announce waiting.",
  "After cancel_tool_call, you may call the original tool again only with improved arguments grounded in the tool error or still_running facts. Never invent results for a cancelled or unfinished tool.",
].join(" ");