import { useChatContext, useHumanInput } from "@anvia/react-ui";
import type { ToolApproval } from "@anvia/react";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toolActivityLabelForName } from "#/components/tool-activity-panel";

/**
 * Glass approval card rendered above the composer while a tool call (e.g.
 * web_search with the web toggle off) waits for the user's decision.
 * Driven by @anvia/react-ui's headless human-input state (useHumanInput) and
 * the chat controller's approveTool/rejectTool — all styling is ours.
 */
export function ApprovalPanel() {
  const chat = useChatContext();
  const { approvals } = useHumanInput();
  const pending = approvals.pending;
  const [decisionErrorId, setDecisionErrorId] = useState<string | null>(null);

  const decide = async (approval: ToolApproval, approved: boolean) => {
    setDecisionErrorId(null);
    try {
      if (approved) {
        await chat.approveTool(approval.id);
      } else {
        await chat.rejectTool(approval.id);
      }
    } catch {
      setDecisionErrorId(approval.id);
    }
  };

  if (pending.length === 0) return null;

  return (
    <div className="mb-2 flex w-full flex-col gap-2">
      {pending.map((approval) => {
        const decodedArgs = safeParseArgs(approval.args);
        const query = decodedArgs?.query ?? decodedArgs?.url ?? null;
        const deciding = chat.decidingApprovals.has(approval.id);

        return (
          <div
            key={approval.id}
            className="glass rounded-xl border border-accent/25 px-3 py-2.5 animate-fade-in"
            role="region"
            aria-label={`Approve ${toolActivityLabelForName(approval.toolName).toLowerCase()}`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-xs font-semibold tracking-tight text-text">
                {toolActivityLabelForName(approval.toolName)}
              </p>
              <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
                Needs approval
              </span>
            </div>

            {query ? (
              <p className="mt-1 truncate text-[11px] text-text-muted">{query}</p>
            ) : null}

            {approval.reason ? (
              <p className="mt-1.5 text-[12px] leading-relaxed text-text/90">
                {approval.reason}
              </p>
            ) : null}

            <div className="mt-2.5 flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={deciding}
                onClick={() => void decide(approval, false)}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-danger/30 bg-danger-soft px-2.5 text-[11px] font-medium text-danger transition duration-150 hover:bg-danger/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Reject
              </button>
              <button
                type="button"
                disabled={deciding}
                onClick={() => void decide(approval, true)}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Allow
              </button>
            </div>

            {deciding ? (
              <span className="mt-1.5 flex items-center gap-1 text-[10px] text-text-faint">
                <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                Sending decision…
              </span>
            ) : null}

            {decisionErrorId === approval.id ? (
              <p aria-live="polite" className="mt-1.5 text-[10px] text-danger">
                Couldn't send decision — try again.
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function safeParseArgs(args?: string): { query?: string; url?: string } | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const query = typeof record.query === "string" ? record.query : undefined;
    const url = typeof record.url === "string" ? record.url : undefined;
    return { ...(query ? { query } : {}), ...(url ? { url } : {}) };
  } catch {
    return null;
  }
}
