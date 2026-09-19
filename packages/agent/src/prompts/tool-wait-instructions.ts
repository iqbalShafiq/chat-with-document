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

/**
 * Wait guidance for a nested specialist agent. Same tool contract, but the
 * narration rules differ: the parent agent owns everything the user reads, so
 * a sub-agent must not spend its own turns talking to the user.
 */
export const SUB_AGENT_TOOL_WAIT_INSTRUCTION = [
  "Some of your tools may return JSON with status still_running and a toolCallId instead of a final result.",
  "That means the same call is still working. Do not treat still_running as success.",
  "Keep waiting with await_tool_call on that toolCallId while the work is plausibly progressing; a slow tool is expected, so never cancel it merely because it is slow. Use cancel_tool_call only when the wait is genuinely wasted for the research question.",
  "Do not invoke the original tool again to poll it, and do not re-plan around a call that is still running.",
  "Do not write user-facing prose while you wait: your output is a research report, and the parent agent reports progress to the user. Keep waiting silent and continue your work once the result arrives.",
  "Never invent results for a cancelled or unfinished tool. If a call could not be completed, say so in the report and state the limitation.",
].join(" ");