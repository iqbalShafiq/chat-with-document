import { useHumanInput } from "@anvia/react-ui";
import type { ToolApproval } from "@anvia/react";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ImageGenParamsEditor } from "#/components/composer/image-gen-params-editor";
import { toolActivityLabelForName } from "#/components/tool-activity-panel";
import {
  decideApproval,
  fetchImageModels,
  type DecideApprovalInput,
  type ImageGenSettings,
  type ImageModelCatalogItem,
} from "#/lib/api";

const IMAGE_TOOLS = new Set(["generate_image", "edit_image"]);

const SETTINGS_KEYS = [
  "modelId",
  "aspectRatio",
  "quality",
  "background",
  "n",
] as const;

type ImageModelsState =
  | { status: "loading"; items: [] }
  | { status: "error"; items: [] }
  | { status: "success"; items: ImageModelCatalogItem[] };

/**
 * Glass approval cards rendered above the composer while tool calls (e.g.
 * web_search with the web toggle off, or image generation) wait for the
 * user's decision. Driven by @anvia/react-ui's headless human-input state
 * (useHumanInput); all styling is ours.
 *
 * Decisions go straight to api.ts decideApproval: @anvia/react's
 * chat.approveTool only forwards { approvalId, approved, reason } to the
 * humanInput config, so grantScope / overrideArgs would never reach the
 * backend. Local deciding state replaces chat.decidingApprovals (read-only,
 * only populated by chat.approveTool).
 */
export function ApprovalPanel() {
  const { approvals } = useHumanInput();
  const pending = approvals.pending;
  const [models, setModels] = useState<ImageModelsState>({
    status: "loading",
    items: [],
  });

  const hasImageApproval = pending.some((approval) =>
    IMAGE_TOOLS.has(approval.toolName),
  );

  const loadImageModels = () => {
    setModels({ status: "loading", items: [] });
    void fetchImageModels()
      .then((items) => setModels({ status: "success", items }))
      .catch(() => setModels({ status: "error", items: [] }));
  };

  useEffect(() => {
    if (!hasImageApproval) return;
    if (models.status === "success" || models.status === "error") return;
    loadImageModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetched on retry only
  }, [hasImageApproval]);

  if (pending.length === 0) return null;

  return (
    <div className="mb-2 flex w-full flex-col gap-2">
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          models={models.items}
          modelsLoading={models.status === "loading"}
          modelsError={models.status === "error"}
          onRetryModels={loadImageModels}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
}: {
  approval: ToolApproval;
  models: ImageModelCatalogItem[];
  modelsLoading: boolean;
  modelsError: boolean;
  onRetryModels: () => void;
}) {
  const isImageTool = IMAGE_TOOLS.has(approval.toolName);
  const parsedImage = useMemo(
    () => parseImageArgs(approval.args),
    [approval.args],
  );
  const [editedSettings, setEditedSettings] = useState<ImageGenSettings>(
    () => parsedImage?.settings ?? {},
  );
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const sendDecision = async (input: {
    approved: boolean;
    grantScope?: "once" | "session";
    reason?: string;
  }) => {
    if (deciding) return;
    setDeciding(true);
    setDecisionError(false);
    try {
      const payload: DecideApprovalInput = {
        approvalId: approval.id,
        approved: input.approved,
      };
      if (input.grantScope) payload.grantScope = input.grantScope;
      if (input.reason !== undefined) payload.reason = input.reason;
      if (
        isImageTool &&
        !imageSettingsEqual(parsedImage?.settings, editedSettings)
      ) {
        payload.overrideArgs = { ...editedSettings };
      }
      await decideApproval(payload);
    } catch {
      setDecisionError(true);
    } finally {
      setDeciding(false);
    }
  };

  const decodedArgs = safeParseArgs(approval.args);
  const query = decodedArgs?.query ?? decodedArgs?.url ?? null;
  const prompt = isImageTool ? parsedImage?.prompt ?? null : null;
  const label = toolActivityLabelForName(approval.toolName);

  return (
    <div
      className="glass rounded-xl border border-accent/25 px-3 py-2.5 animate-fade-in"
      role="region"
      aria-label={`Approve ${label.toLowerCase()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold tracking-tight text-text">
          {label}
        </p>
        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
          Needs approval
        </span>
      </div>

      {query ? (
        <p className="mt-1 truncate text-[11px] text-text-muted">{query}</p>
      ) : null}

      {prompt ? (
        <p
          className="mt-1 truncate font-mono text-[11px] text-text-muted"
          title={prompt}
        >
          {prompt}
        </p>
      ) : null}

      {approval.reason ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-text/90">
          {approval.reason}
        </p>
      ) : null}

      {isImageTool ? (
        <ImageGenParamsEditor
          settings={editedSettings}
          onChange={setEditedSettings}
          models={models}
          loading={modelsLoading}
          error={modelsError}
          onRetry={onRetryModels}
        />
      ) : null}

      {rejectOpen ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="Why are you rejecting this? (optional)"
            rows={2}
            disabled={deciding}
            aria-label="Rejection reason"
            className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-text placeholder:text-text-faint outline-none ring-accent-ring focus:border-accent/40 focus:ring-2 disabled:opacity-40"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={deciding}
              onClick={() => {
                setRejectOpen(false);
                setRejectReason("");
              }}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg bg-white/[0.06] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={deciding}
              onClick={() =>
                void sendDecision({
                  approved: false,
                  reason: rejectReason.trim() || undefined,
                })
              }
              className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-danger/30 bg-danger-soft px-2.5 text-[11px] font-medium text-danger transition duration-150 hover:bg-danger/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={deciding}
            onClick={() => setRejectOpen(true)}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-danger/30 bg-danger-soft px-2.5 text-[11px] font-medium text-danger transition duration-150 hover:bg-danger/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reject
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() => void sendDecision({ approved: true, grantScope: "once" })}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-accent/30 bg-accent/10 px-2.5 text-[11px] font-semibold text-accent transition duration-150 hover:bg-accent/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Allow once
          </button>
          <button
            type="button"
            disabled={deciding}
            onClick={() =>
              void sendDecision({ approved: true, grantScope: "session" })
            }
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Allow for session
          </button>
        </div>
      )}

      {deciding ? (
        <span className="mt-1.5 flex items-center gap-1 text-[10px] text-text-faint">
          <Loader2 className="size-3 animate-spin" strokeWidth={2} />
          Sending decision…
        </span>
      ) : null}

      {decisionError ? (
        <p aria-live="polite" className="mt-1.5 text-[10px] text-danger">
          Couldn't send decision — try again.
        </p>
      ) : null}
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

function parseImageArgs(
  args?: string,
): { prompt?: string; settings: ImageGenSettings } | null {
  if (!args) return null;
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const settings: ImageGenSettings = {};
    if (typeof record.modelId === "string") settings.modelId = record.modelId;
    if (typeof record.aspectRatio === "string") {
      settings.aspectRatio = record.aspectRatio;
    }
    if (typeof record.quality === "string") settings.quality = record.quality;
    if (typeof record.background === "string") {
      settings.background = record.background;
    }
    if (typeof record.n === "number") settings.n = record.n;
    return {
      prompt: typeof record.prompt === "string" ? record.prompt : undefined,
      settings,
    };
  } catch {
    return null;
  }
}

/** Normalized shallow equality over the ImageGenSettings-shaped keys only. */
function imageSettingsEqual(
  original: ImageGenSettings | null | undefined,
  edited: ImageGenSettings,
): boolean {
  return SETTINGS_KEYS.every(
    (key) => (original?.[key] ?? undefined) === (edited[key] ?? undefined),
  );
}
