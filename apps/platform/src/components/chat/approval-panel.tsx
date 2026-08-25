import type { ClientInteraction } from "@anvia/client";
import type { AgentInteractionRequest, AgentInteractionResponse } from "@anvia/core/agent/interactions";
import { useChatContext } from "@anvia/react-ui";
import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ImageGenParamsEditor } from "#/components/composer/image-gen-params-editor";
import { toolActivityLabelForName } from "#/components/tool-activity-panel";
import { isImageToolName } from "#/lib/chat/generated-images";
import {
  buildApprovalResponse,
  buildImageOverride,
  stageThenRespond,
  type InteractionPolicy,
} from "#/lib/chat/interaction-response";
import {
  fetchImageModels,
  stageInteractionPolicy,
  type ImageGenSettings,
  type ImageModelCatalogItem,
} from "#/lib/api";

const SETTINGS_KEYS = [
  "modelId",
  "aspectRatio",
  "quality",
  "background",
  "n",
] as const;

const SESSION_GRANTABLE_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "deep_research",
  "generate_image",
  "edit_image",
]);

type ImageModelsState =
  | { status: "loading"; items: [] }
  | { status: "error"; items: [] }
  | { status: "success"; items: ImageModelCatalogItem[] };

type ApprovalInteraction = ClientInteraction & {
  request: Extract<AgentInteractionRequest, { type: "tool-approval" }>;
};

function isApprovalInteraction(
  interaction: ClientInteraction,
): interaction is ApprovalInteraction {
  return interaction.request.type === "tool-approval";
}

/** Native v1 approval cards driven solely by the chat interaction controller. */
export function ApprovalPanel({
  onInteractionSettled,
}: {
  onInteractionSettled?: () => Promise<void>;
}) {
  const chat = useChatContext();
  const pending = chat.interactions.pending.filter(isApprovalInteraction);
  const [models, setModels] = useState<ImageModelsState>({
    status: "loading",
    items: [],
  });

  const hasImageApproval = pending.some((interaction) =>
    isImageToolName(interaction.request.toolName),
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
      {pending.map((interaction) => (
        <ApprovalCard
          key={interaction.request.id}
          interaction={interaction}
          models={models.items}
          modelsLoading={models.status === "loading"}
          modelsError={models.status === "error"}
          onRetryModels={loadImageModels}
          respondingInteractions={chat.respondingInteractions}
          respond={chat.respondToInteraction}
          onInteractionSettled={onInteractionSettled}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  interaction,
  models,
  modelsLoading,
  modelsError,
  onRetryModels,
  respondingInteractions,
  respond,
  onInteractionSettled,
}: {
  interaction: ApprovalInteraction;
  models: ImageModelCatalogItem[];
  modelsLoading: boolean;
  modelsError: boolean;
  onRetryModels: () => void;
  respondingInteractions: ReadonlySet<string>;
  respond: (input: {
    interactionId: string;
    response: AgentInteractionResponse;
  }) => Promise<void>;
  onInteractionSettled?: () => Promise<void>;
}) {
  const approval = interaction.request;
  const isImageTool = isImageToolName(approval.toolName);
  const canGrantForSession = SESSION_GRANTABLE_TOOLS.has(approval.toolName);
  const parsedImage = useMemo(
    () => parseImageArgs(approval.input),
    [approval.input],
  );
  const [editedSettings, setEditedSettings] = useState<ImageGenSettings>(
    () => parsedImage?.settings ?? {},
  );
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const inFlight = useRef(new Set<string>());

  const sendDecision = async (input: {
    approved: boolean;
    grantScope?: "session";
    reason?: string;
  }) => {
    if (
      deciding ||
      respondingInteractions.has(approval.id) ||
      inFlight.current.has(approval.id)
    ) {
      return;
    }
    setDeciding(true);
    setDecisionError(null);
    try {
      const response = buildApprovalResponse({
        approved: input.approved,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      });
      let policy: InteractionPolicy | undefined;
      if (
        input.approved === true &&
        isImageTool &&
        !imageSettingsEqual(parsedImage?.settings, editedSettings)
      ) {
        if (modelsLoading || modelsError || models.length === 0) {
          throw new Error("Image settings are unavailable. Try again.");
        }
        policy = {
          ...(input.grantScope ? { grantScope: input.grantScope } : {}),
          overrideArgs: buildImageOverride(editedSettings, { catalog: models }),
          imageCatalog: models,
        };
      } else if (input.grantScope) {
        policy = { grantScope: input.grantScope };
      }
      await stageThenRespond({
        interaction,
        response,
        ...(policy ? { policy } : {}),
        stage: stageInteractionPolicy,
        respond,
        respondingInteractions,
        inFlight: inFlight.current,
      });
      await onInteractionSettled?.();
      setRejectOpen(false);
      setRejectReason("");
    } catch (error) {
      setDecisionError(
        error instanceof Error
          ? error.message
          : "Interaction response could not be sent. Try again.",
      );
    } finally {
      setDeciding(false);
    }
  };

  const { query, url, prompt, researchPrompt } = readSafeInput(approval.input);
  const label = toolActivityLabelForName(approval.toolName);
  const responding = deciding || respondingInteractions.has(approval.id);

  return (
    <div
      className="glass rounded-xl border border-accent/25 px-3 py-2.5 animate-fade-in"
      role="region"
      aria-label={`Approve ${label.toLowerCase()}`}
      aria-busy={responding}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold tracking-tight text-text">
          {label}
        </p>
        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
          Needs approval
        </span>
      </div>

      {query || url ? (
        <p className="mt-1 truncate text-[11px] text-text-muted">{query ?? url}</p>
      ) : null}

      {prompt ? (
        <p
          className="mt-1 truncate font-mono text-[11px] text-text-muted"
          title={prompt}
        >
          {prompt}
        </p>
      ) : null}

      {researchPrompt ? (
        <p
          className="mt-1 truncate font-mono text-[11px] text-text-muted"
          title={researchPrompt}
        >
          {researchPrompt}
        </p>
      ) : null}

      {sanitizeApprovalReason(approval.reason) ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-text/90">
          {sanitizeApprovalReason(approval.reason)}
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
          requireExplicitModel={isImageTool}
        />
      ) : null}

      {rejectOpen ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          <textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="Why are you rejecting this? (optional)"
            rows={2}
            disabled={responding}
            aria-label="Rejection reason"
            className="w-full resize-none rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-text placeholder:text-text-faint outline-none ring-accent-ring focus:border-accent/40 focus:ring-2 disabled:opacity-40"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              disabled={responding}
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
              disabled={responding}
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
            disabled={responding}
            onClick={() => setRejectOpen(true)}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-danger/30 bg-danger-soft px-2.5 text-[11px] font-medium text-danger transition duration-150 hover:bg-danger/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reject
          </button>
          <button
            type="button"
            disabled={responding}
            onClick={() => void sendDecision({ approved: true })}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-accent/30 bg-accent/10 px-2.5 text-[11px] font-semibold text-accent transition duration-150 hover:bg-accent/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Allow once
          </button>
          {canGrantForSession ? (
            <button
              type="button"
              disabled={responding}
              onClick={() =>
                void sendDecision({ approved: true, grantScope: "session" })
              }
              className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Allow for session
            </button>
          ) : null}
        </div>
      )}

      {responding ? (
        <span className="mt-1.5 flex items-center gap-1 text-[10px] text-text-faint">
          <Loader2 className="size-3 animate-spin" strokeWidth={2} />
          Sending decision…
        </span>
      ) : null}

      {decisionError ? (
        <p aria-live="polite" className="mt-1.5 text-[10px] text-danger">
          {decisionError}
        </p>
      ) : null}
    </div>
  );
}

function readSafeInput(input: unknown): {
  query?: string;
  url?: string;
  prompt?: string;
  researchPrompt?: string;
} {
  if (!isRecord(input)) return {};
  const query = asBoundedString(input.query);
  const url = redactApprovalUrl(input.url);
  const prompt = asBoundedString(input.prompt);
  return {
    ...(query ? { query } : {}),
    ...(url ? { url } : {}),
    ...(prompt ? { prompt } : {}),
    ...(prompt && typeof input.researchDepth === "string"
      ? { researchPrompt: prompt }
      : {}),
  };
}

function parseImageArgs(
  input: unknown,
): { prompt?: string; settings: ImageGenSettings } | null {
  if (!isRecord(input)) return null;
  const settings: ImageGenSettings = {};
  if (typeof input.modelId === "string") settings.modelId = input.modelId;
  if (typeof input.aspectRatio === "string") {
    settings.aspectRatio = input.aspectRatio;
  }
  if (typeof input.quality === "string") settings.quality = input.quality;
  if (typeof input.background === "string") {
    settings.background = input.background;
  }
  if (typeof input.n === "number") settings.n = input.n;
  return {
    ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
    settings,
  };
}

function imageSettingsEqual(
  original: ImageGenSettings | null | undefined,
  edited: ImageGenSettings,
): boolean {
  return SETTINGS_KEYS.every(
    (key) => (original?.[key] ?? undefined) === (edited[key] ?? undefined),
  );
}

function asBoundedString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    return undefined;
  }
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeApprovalReason(value: unknown): string | undefined {
  const reason = asBoundedString(value);
  return reason && reason.length <= 500 ? reason : reason?.slice(0, 500);
}

function redactApprovalUrl(value: unknown): string | undefined {
  const url = asBoundedString(value);
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return asBoundedString(parsed.toString().replace(/\/$/, ""));
  } catch {
    const withoutSensitiveParts = url
      .split(/[?#]/, 1)[0]
      .replace(/^(https?:\/\/)(?:[^/@\s]+(?::[^/@\s]*)?@)/i, "$1");
    return asBoundedString(withoutSensitiveParts);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
