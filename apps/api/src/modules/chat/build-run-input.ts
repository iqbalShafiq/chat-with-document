import { prisma } from "../../utils/prisma.js";
import { getObjectBuffer } from "../../lib/r2.js";
import {
  buildDocumentCatalogInstruction,
  CLARIFICATION_INSTRUCTION,
  CONTEXT7_INSTRUCTION,
  createAgent,
  createChunkSearchService,
  createClarificationTool,
  createCompletionModel,
  createDataAnalysisTools,
  createDocumentTools,
  createImageGenerationTools,
  createRememberUserProfileTool,
  createTavilyClient,
  createWebSearchTools,
  DOCUMENT_IMAGE_INSTRUCTION,
  hasProfileContent,
  buildImageGenerationInstruction,
  normalizePageImages,
  OpenRouterImageGenerationModel,
  renderProfileContextText,
  tracing,
  WEB_SEARCH_INSTRUCTION,
  type AgentContextBlock,
  type ClarificationRequest,
  type ClarificationResponse,
  type ImageCapabilitySet,
  type ImageGenSettings,
  type ProfileScope,
  type ProfileSectionKey,
  type ReasoningEffort,
} from "@assingment/agent";
import type { AnyTool, MemoryStore, ToolApprovalsOptions } from "@anvia/core";
import type { McpServer } from "@anvia/core/mcp";
import { resolveActiveDocuments } from "../documents/service.js";
import {
  getImageStore,
  type GeneratedImageRecord,
} from "../images/service.js";
import { parseImageCapabilities } from "./image-capabilities.js";
import {
  resolveImageReference,
  type ImageResolveDeps,
} from "./image-resolve.js";
import {
  createNonVisionMemoryProxy,
  createSanitizedMemoryStore,
} from "./memory-sanitizer.js";
import { findActiveModel, listModels } from "../models/service.js";
import {
  createDefaultViewImageTool,
  resolveVisionHelperModel,
  VISION_HELPER_INSTRUCTION,
} from "./vision-helper.js";
import {
  rescheduleProfileRefresh,
  waitForActiveProfileJob,
} from "../profiling/queue.js";
import {
  appendExplicitFact,
  loadProfileData,
  profileConfig,
  summarizeProfileForScope,
} from "../profiling/service.js";

/** Request facts only (Anvia context). Policy goes in instructions. */
function buildProjectWorkspaceContext(input: {
  name: string;
  description: string | null;
}): string {
  const lines = ["Project workspace", `Name: ${input.name}`];
  if (input.description?.trim()) {
    lines.push(`Description: ${input.description.trim()}`);
  }
  return lines.join("\n");
}

/** Durable project-scoped behavior (Anvia instructions), only when in a project. */
const PROJECT_WORKSPACE_INSTRUCTION = [
  "You are answering inside a project workspace.",
  "Only use the active document catalog and tools for this chat.",
  "Do not assume access to other projects or the user's standalone library.",
].join("\n");

/** Personalization policy (Anvia rule: policy in instructions, facts in context). */
const PROFILE_INSTRUCTION = [
  "A user profile may be included in the context.",
  "Use it to personalize tone, format, and recall of the user's preferences.",
  "Never reveal the raw profile content to the user.",
  "If the user explicitly asks you to remember something about them, call the remember_user_profile tool.",
  "Never invent profile facts not present in the context.",
].join("\n");

export function webSearchConfig() {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

/** Image generation is available when the image provider env pair is set. */
export function imageGenerationConfig() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const baseUrl = process.env.OPENAI_BASE_URL?.trim();
  return apiKey && baseUrl ? { apiKey, baseUrl } : null;
}

export type ToolGrantHelpers = {
  hasGrant(toolName: string): Promise<boolean> | boolean;
  takeToolOverride(
    toolName: string,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

/** Capability map for active image models; unknown model ids → null (tool defaults). */
async function loadImageCapabilities(): Promise<Map<string, ImageCapabilitySet>> {
  const models = await prisma.chatModel.findMany({
    where: { outputType: "image", isActive: true },
    select: { modelId: true, imageCapabilities: true },
  });
  const capabilities = new Map<string, ImageCapabilitySet>();
  for (const model of models) {
    capabilities.set(model.modelId, parseImageCapabilities(model.imageCapabilities));
  }
  return capabilities;
}

/**
 * Document-page image lookup for edit_image references: a document image id
 * only exists inside its page's images JSON, so scan the ready documents
 * linked to this session (the same corpus the model saw image ids from).
 */
async function findSessionDocumentImage(
  imageId: string,
  userId: string,
  sessionId: string,
): Promise<{ mediaType: string; buffer: Uint8Array } | null> {
  const pages = await prisma.documentPage.findMany({
    where: {
      document: {
        userId,
        status: "ready",
        sessionLinks: { some: { sessionId, userId } },
      },
    },
    select: { images: true },
  });
  for (const page of pages) {
    const match = normalizePageImages(page.images).find(
      (entry) => entry.id === imageId,
    );
    if (!match) continue;
    try {
      const buffer = await getObjectBuffer(match.r2Key);
      return { mediaType: match.mediaType, buffer };
    } catch (error) {
      console.error("[chat] document image fetch failed", { imageId, error });
      return null;
    }
  }
  return null;
}

export type ChatRunInput = {
  agent: ReturnType<typeof createAgent>;
  sessionId: string;
  userId: string;
  projectId: string | null;
  model: string;
  reasoningEffort: string | null;
  instructions: string[];
  contextBlocks: AgentContextBlock[];
  tools: AnyTool[];
  memory: MemoryStore;
  hasActiveDocuments: boolean;
  /** Web tools registered (TAVILY_API_KEY set). */
  webSearchAvailable: boolean;
  /** Image generation tools registered (OPENAI_API_KEY + OPENAI_BASE_URL set). */
  imageGenerationAvailable: boolean;
  /** Context7 MCP tools available (configured + connected). */
  context7Available: boolean;
  /** Images pinned as active context for this session (in pin order). */
  activeContextImages: GeneratedImageRecord[];
};

export async function buildChatRunInput(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
  agentId?: string;
  /** Per-session web-search toggle (default false). */
  webSearchEnabled?: boolean;
  /** Per-session image generation toggle (default false). */
  imageGenerationEnabled?: boolean;
  /** Session image defaults: model, aspect ratio, quality, background, count. */
  imageGenSettings?: ImageGenSettings | null;
  /** Grant/override lookups for approval-gated tools (per-session, live reads). */
  grantHelpers?: ToolGrantHelpers;
  /** Suspends runs awaiting user answers to agent clarification questions. */
  clarificationRequester?: (
    request: ClarificationRequest,
  ) => Promise<ClarificationResponse>;
  /** Approval handler suspending web tools for user confirmation. */
  approvals?: ToolApprovalsOptions;
  /** Connected context7 MCP server (nullable when unavailable). */
  context7Server?: McpServer | null;
}): Promise<ChatRunInput> {
  const {
    sessionId,
    userId,
    model,
    reasoningEffort,
    agentId,
    webSearchEnabled = false,
    imageGenerationEnabled = false,
    imageGenSettings = null,
    grantHelpers,
    clarificationRequester,
    approvals,
    context7Server,
  } = input;

  const memory = createSanitizedMemoryStore(prisma);

  // Model capability gate: text-only models (e.g. DeepSeek) 404 on image
  // content replayed from memory. For those runs, wrap the memory store so
  // loaded messages drop image parts (rows keep them — a later vision-model
  // run still sees the images), and register the view_image helper tool so
  // the model can still understand images via a cheap vision chat model.
  const modelInfo = await findActiveModel(model);
  const modelAcceptsImage =
    modelInfo?.inputModalities?.includes("image") ?? false;
  const runMemory = modelAcceptsImage
    ? memory
    : createNonVisionMemoryProxy(memory);

  // Session row is guaranteed to exist: the router runs ensureChatSession
  // before building the run input.
  const chatSession = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  const projectId = chatSession?.projectId ?? null;

  const sessionDocuments = await resolveActiveDocuments({
    userId,
    sessionId,
    projectId,
  });
  const catalogInstruction = buildDocumentCatalogInstruction(sessionDocuments);
  const hasActiveDocuments = sessionDocuments.length > 0;

  // Document tools only when the session has linked ready docs — avoids the
  // model re-searching unlinked files based on conversation memory.
  const documentTools = hasActiveDocuments
    ? createDocumentTools({
        sessionId,
        userId,
        projectId,
        prisma,
        searchService: createChunkSearchService(),
        fetchPageImage: (r2Key) => getObjectBuffer(r2Key),
        includeImageBytes: modelAcceptsImage,
      })
    : [];

  let projectContext: { text: string; id: string } | undefined;
  let projectInstruction: string | undefined;
  if (projectId) {
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId },
      select: { name: true, description: true },
    });
    if (project) {
      projectContext = {
        id: "project_workspace",
        text: buildProjectWorkspaceContext(project),
      };
      projectInstruction = PROJECT_WORKSPACE_INSTRUCTION;
    }
  }

  const profilingEnabled = profileConfig().enabled;

  const profileContext: AgentContextBlock[] = [];
  let profileTool: ReturnType<typeof createRememberUserProfileTool> | undefined;

  if (profilingEnabled) {
    const userProfile = await loadProfileData({ kind: "user", userId });
    if (userProfile && hasProfileContent(userProfile)) {
      profileContext.push({
        id: "user_profile",
        text: renderProfileContextText(userProfile, "User profile"),
      });
    }

    if (projectId) {
      const projectProfile = await loadProfileData({
        kind: "project",
        userId,
        projectId,
      });
      if (projectProfile && hasProfileContent(projectProfile)) {
        profileContext.push({
          id: "project_profile",
          text: renderProfileContextText(projectProfile, "Project profile"),
        });
      }
    }

    const profileScope: ProfileScope = projectId
      ? { kind: "project", userId, projectId }
      : { kind: "user", userId };

    profileTool = createRememberUserProfileTool({
      scope: profileScope,
      waitForActiveJob: () => waitForActiveProfileJob(profileScope),
      appendFact: (input) =>
        appendExplicitFact(profileScope, {
          section: input.section as ProfileSectionKey | null,
          fact: input.fact,
        }),
      refreshNow: () => summarizeProfileForScope(profileScope),
      reschedule: () => rescheduleProfileRefresh(profileScope),
    });
  }

  const instructions = [
    catalogInstruction,
    ...(hasActiveDocuments ? [DOCUMENT_IMAGE_INSTRUCTION] : []),
    ...(projectInstruction ? [projectInstruction] : []),
    ...(profilingEnabled ? [PROFILE_INSTRUCTION] : []),
  ];
  const contextBlocks = [
    ...(projectContext ? [projectContext] : []),
    ...profileContext,
  ];
  const tools = [
    ...createDataAnalysisTools(),
    ...documentTools,
    ...(profileTool ? [profileTool] : []),
  ];

  // Active image context: images the user pinned for this session. They are
  // injected into the agent prompt as image input (worker) when the selected
  // model supports image input, and described in a prioritized context block
  // so the model treats them as the primary visual reference.
  const activeContextImages =
    await getImageStore().listSessionImageContexts({ userId, sessionId });
  if (activeContextImages.length > 0) {
    contextBlocks.push({
      id: "active_image_context",
      text:
        "Active image context\n" +
        "The user pinned the following images as context for this conversation. " +
        "They take priority over any other images mentioned in the session:\n" +
        activeContextImages
          .map(
            (image, index) =>
              `${index + 1}. ${image.prompt || image.id} (${image.mediaType}) — imageId: ${image.id}`,
          )
          .join("\n"),
    });
  }

  // Web tools: registered only when TAVILY_API_KEY is set; the per-session
  // toggle decides whether approval is required for each call.
  const tavilyConfig = webSearchConfig();
  const webSearchAvailable = tavilyConfig !== null;
  if (webSearchAvailable) {
    tools.push(
      ...createWebSearchTools({
        tavilyClient: createTavilyClient(tavilyConfig.apiKey),
        enabled: webSearchEnabled,
      }),
    );
    instructions.push(WEB_SEARCH_INSTRUCTION);
  }

  // Image generation tools: registered only when the image provider env pair
  // is set. Grants/overrides come from the approval registry (live per-call
  // reads); references resolve to generated or document images.
  const imgConfig = imageGenerationConfig();
  const imageGenerationAvailable = imgConfig !== null;
  if (imageGenerationAvailable) {
    const capabilities = await loadImageCapabilities();
    const resolveDeps: ImageResolveDeps = {
      getGeneratedImage: (id) => getImageStore().getImage(id),
      getObjectBuffer,
      findDocumentImage: findSessionDocumentImage,
    };
    tools.push(
      ...createImageGenerationTools({
        model: new OpenRouterImageGenerationModel({
          apiKey: imgConfig.apiKey,
          baseUrl: imgConfig.baseUrl,
        }),
        store: {
          saveGeneratedImage: (input) => getImageStore().saveGeneratedImage(input),
        },
        enabled: imageGenerationEnabled,
        hasGrant: (name) => grantHelpers?.hasGrant(name) ?? Promise.resolve(false),
        takeToolOverride: (name) =>
          grantHelpers?.takeToolOverride(name) ?? Promise.resolve(null),
        userId,
        sessionId,
        projectId,
        resolveReference: (imageId) =>
          resolveImageReference({ imageId, userId, sessionId }, resolveDeps),
        capabilities: (modelId) => capabilities.get(modelId) ?? null,
        defaultSettings: imageGenSettings ?? undefined,
      }),
    );
    // The instruction's web_search-first guidance only makes sense when web
    // tools are actually registered this run.
    instructions.push(
      buildImageGenerationInstruction({ webSearchAvailable }),
    );
  }

  // Clarification: the generic request_clarification tool suspends the run
  // until the user answers (surfaced via the stream by the requester).
  if (clarificationRequester) {
    tools.push(createClarificationTool({ requester: clarificationRequester }));
    instructions.push(CLARIFICATION_INSTRUCTION);
  }

  const context7Available = context7Server !== null && context7Server !== undefined;
  if (context7Available) {
    instructions.push(CONTEXT7_INSTRUCTION);
  }

  // Vision helper for text-only models: describe session images, document
  // page images, *or* public image URLs (e.g. logos from web_search) via the
  // cheapest active vision chat model (VISION_HELPER_MODEL overrides the pick).
  if (!modelAcceptsImage) {
    const visionModel = await resolveVisionHelperModel();
    if (visionModel) {
      tools.push(
        createDefaultViewImageTool({
          userId,
          sessionId,
          model: visionModel,
          resolveDocumentImage: (imageId, imageUserId, imageSessionId) =>
            findSessionDocumentImage(imageId, imageUserId, imageSessionId),
        }),
      );
      instructions.push(VISION_HELPER_INSTRUCTION);
    }
  }

  const agent = createAgent({
    agentId: agentId ?? "my-agent",
    model: createCompletionModel(model),
    reasoningEffort: (reasoningEffort ?? undefined) as
      | ReasoningEffort
      | undefined,
    tracing: tracing,
    additionalInstructions: instructions,
    additionalContext: contextBlocks,
    additionalTools: tools,
    ...((webSearchAvailable || imageGenerationAvailable) && approvals
      ? { approvals }
      : {}),
    ...(context7Available ? { mcpServers: [context7Server] } : {}),
    memory: runMemory,
  });

  return {
    agent,
    sessionId,
    userId,
    projectId,
    model,
    reasoningEffort,
    instructions,
    contextBlocks,
    tools,
    memory: runMemory,
    hasActiveDocuments,
    webSearchAvailable,
    imageGenerationAvailable,
    context7Available,
    /** Images pinned as active context (bytes fetched by the worker). */
    activeContextImages,
  };
}
