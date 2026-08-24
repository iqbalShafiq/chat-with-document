import type { ClientInteraction } from "@anvia/client";
import {
  assertAgentInteractionResponse,
  parseAgentInteractionRequest,
  parseAgentInteractionResponse,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentToolQuestionRequest,
} from "@anvia/core/agent/interactions";
import type { ImageModelCatalogItem } from "#/lib/api";

const MAX_REJECTION_REASON_LENGTH = 500;
const IMAGE_OVERRIDE_KEYS = new Set([
  "modelId",
  "aspectRatio",
  "quality",
  "background",
  "n",
]);
const IMAGE_TOOL_NAMES = new Set(["generate_image", "edit_image"]);

export type StageInteractionInput = {
  interactionId: string;
  response: Extract<AgentInteractionResponse, { type: "tool-approval" }>;
  grantScope?: "session";
  overrideArgs?: Record<string, unknown>;
};

export type InteractionPolicy = {
  grantScope?: "session";
  overrideArgs?: Record<string, unknown>;
  /** The already fetched server catalog used to validate image overrides. */
  imageCatalog?: readonly ImageModelCatalogItem[];
};

export type InteractionResponseErrorCode =
  | "invalid_response"
  | "invalid_policy"
  | "duplicate"
  | "stage_failed"
  | "response_failed";

export class InteractionResponseError extends Error {
  readonly name = "InteractionResponseError";

  constructor(
    readonly code: InteractionResponseErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Build the only approval response shape accepted by the native controller. */
export function buildApprovalResponse(input: {
  approved: boolean;
  reason?: string;
}): Extract<AgentInteractionResponse, { type: "tool-approval" }> {
  if (typeof input.approved !== "boolean") {
    throw new InteractionResponseError(
      "invalid_response",
      "The approval response is invalid.",
    );
  }
  if (
    input.reason !== undefined &&
    (typeof input.reason !== "string" ||
      input.reason.length > MAX_REJECTION_REASON_LENGTH)
  ) {
    throw new InteractionResponseError(
      "invalid_response",
      "The approval response is invalid.",
    );
  }
  const reason = input.reason?.trim();
  const value = {
    type: "tool-approval" as const,
    approved: input.approved,
    ...(reason ? { reason } : {}),
  };
  return parseAgentInteractionResponse(value) as Extract<
    AgentInteractionResponse,
    { type: "tool-approval" }
  >;
}

/** Build and assert one answer for every prompt in a native question request. */
export function buildQuestionResponse(input: {
  request: AgentToolQuestionRequest;
  answers: readonly { questionId: string; value: string }[];
}): Extract<AgentInteractionResponse, { type: "tool-question" }> {
  let request: AgentInteractionRequest;
  try {
    request = parseAgentInteractionRequest(input.request);
  } catch (error) {
    throw new InteractionResponseError(
      "invalid_response",
      "The question response is invalid.",
      { cause: error },
    );
  }
  if (request.type !== "tool-question") {
    throw new InteractionResponseError(
      "invalid_response",
      "The question response is invalid.",
    );
  }
  let response: AgentInteractionResponse;
  try {
    response = parseAgentInteractionResponse({
      type: "tool-question",
      answers: input.answers,
    });
    assertAgentInteractionResponse(request, response);
  } catch (error) {
    throw new InteractionResponseError(
      "invalid_response",
      "Every question needs one valid answer.",
      { cause: error },
    );
  }
  return response as Extract<
    AgentInteractionResponse,
    { type: "tool-question" }
  >;
}

/** Validate and copy the exact image settings the approval editor can stage. */
export function buildImageOverride(
  input: unknown,
  options: { catalog: readonly ImageModelCatalogItem[] },
): Record<string, unknown> {
  if (!isRecord(input)) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The image settings are invalid.",
    );
  }
  const keys = Object.keys(input);
  if (
    keys.length === 0 ||
    keys.some((key) => !IMAGE_OVERRIDE_KEYS.has(key)) ||
    !keys.includes("modelId")
  ) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The image settings are invalid.",
    );
  }

  const override: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (key === "n") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 10
      ) {
        throw new InteractionResponseError(
          "invalid_policy",
          "The image settings are invalid.",
        );
      }
      override[key] = value;
      continue;
    }
    if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
      throw new InteractionResponseError(
        "invalid_policy",
        "The image settings are invalid.",
      );
    }
    override[key] = value.trim();
  }

  const catalog = options.catalog;
  const modelId = override.modelId;
  const model =
    typeof modelId === "string"
      ? catalog.find((candidate) => candidate.modelId === modelId)
      : undefined;
  if (!model) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The selected image model is unavailable.",
    );
  }
  const capabilities = model.imageCapabilities;
  if (!capabilities) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The selected image model has no known capabilities.",
    );
  }
  if (
    override.aspectRatio !== undefined &&
    (!Array.isArray(capabilities.aspectRatios) ||
      !capabilities.aspectRatios.includes(String(override.aspectRatio)))
  ) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The selected image aspect ratio is unavailable.",
    );
  }
  if (
    override.quality !== undefined &&
    (!Array.isArray(capabilities.quality) ||
      !capabilities.quality.includes(String(override.quality)))
  ) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The selected image quality is unavailable.",
    );
  }
  if (
    override.background !== undefined &&
    (!Array.isArray(capabilities.background) ||
      !capabilities.background.includes(String(override.background)))
  ) {
    throw new InteractionResponseError(
      "invalid_policy",
      "The selected image background is unavailable.",
    );
  }
  if (override.n !== undefined) {
    const range = capabilities.n;
    if (
      !range ||
      !Number.isInteger(range.min) ||
      !Number.isInteger(range.max) ||
      range.min < 1 ||
      range.max < range.min ||
      Number(override.n) < range.min ||
      Number(override.n) > range.max
    ) {
      throw new InteractionResponseError(
        "invalid_policy",
        "The selected image count is unavailable.",
      );
    }
  }
  return override;
}

export function assertResponseForRequest(
  request: AgentInteractionRequest,
  response: AgentInteractionResponse,
): void {
  const parsedRequest = parseAgentInteractionRequest(request);
  const parsedResponse = parseAgentInteractionResponse(response);
  assertAgentInteractionResponse(parsedRequest, parsedResponse);
}

export type StageThenRespondInput = {
  interaction: ClientInteraction;
  response: AgentInteractionResponse;
  policy?: InteractionPolicy;
  stage?: (input: StageInteractionInput) => Promise<void>;
  respond: (input: {
    interactionId: string;
    response: AgentInteractionResponse;
  }) => Promise<void>;
  respondingInteractions?: ReadonlySet<string>;
  /** A component-owned set that survives rerenders and guards rapid clicks. */
  inFlight?: Set<string>;
};

/**
 * Validate, optionally stage application policy, then submit one native
 * interaction response. The native response never carries staging fields.
 */
export async function stageThenRespond(
  input: StageThenRespondInput,
): Promise<void> {
  let request: AgentInteractionRequest;
  try {
    request = parseAgentInteractionRequest(input.interaction.request);
  } catch (error) {
    throw new InteractionResponseError(
      "invalid_response",
      "The interaction request is invalid.",
      { cause: error },
    );
  }
  const interactionId = request.id;
  const inFlight = input.inFlight ?? new Set<string>();
  if (
    input.respondingInteractions?.has(interactionId) ||
    inFlight.has(interactionId)
  ) {
    throw new InteractionResponseError(
      "duplicate",
      "This interaction is already being submitted.",
    );
  }

  let response: AgentInteractionResponse;
  try {
    response = parseAgentInteractionResponse(input.response);
    assertAgentInteractionResponse(request, response);
  } catch (error) {
    throw new InteractionResponseError(
      "invalid_response",
      "The interaction response is invalid.",
      { cause: error },
    );
  }

  const policy = input.policy;
  const hasPolicy =
    policy !== undefined &&
    (policy.grantScope !== undefined || policy.overrideArgs !== undefined);
  let stageInput: StageInteractionInput | undefined;
  if (hasPolicy) {
    if (
      request.type !== "tool-approval" ||
      response.type !== "tool-approval" ||
      !response.approved ||
      input.stage === undefined
    ) {
      throw new InteractionResponseError(
        "invalid_policy",
        "Only an approved tool interaction can stage policy.",
      );
    }
    let overrideArgs: Record<string, unknown> | undefined;
    if (policy.overrideArgs !== undefined) {
      if (!IMAGE_TOOL_NAMES.has(request.toolName)) {
        throw new InteractionResponseError(
          "invalid_policy",
          "Image settings cannot be staged for this tool.",
        );
      }
      overrideArgs = buildImageOverride(policy.overrideArgs, {
        catalog: policy.imageCatalog ?? [],
      });
    }
    stageInput = {
      interactionId,
      response,
      ...(policy.grantScope !== undefined
        ? { grantScope: policy.grantScope }
        : {}),
      ...(overrideArgs !== undefined ? { overrideArgs } : {}),
    };
  }

  inFlight.add(interactionId);
  try {
    if (stageInput !== undefined) {
      try {
        await input.stage!(stageInput);
      } catch (error) {
        throw new InteractionResponseError(
          "stage_failed",
          "Interaction policy could not be staged. Try again.",
          { cause: error },
        );
      }
    }
    try {
      await input.respond({ interactionId, response });
    } catch (error) {
      throw new InteractionResponseError(
        "response_failed",
        "Interaction response could not be sent. Try again.",
        { cause: error },
      );
    }
  } finally {
    inFlight.delete(interactionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
