import { prisma } from "../../utils/prisma.js";
import { getObjectBuffer } from "../../lib/r2.js";
import {
  buildDocumentCatalogInstruction,
  createAgent,
  createChunkSearchService,
  createCompletionModel,
  createDataAnalysisTools,
  createDocumentTools,
  createRememberUserProfileTool,
  DOCUMENT_IMAGE_INSTRUCTION,
  hasProfileContent,
  renderProfileContextText,
  tracing,
  type AgentContextBlock,
  type ProfileScope,
  type ProfileSectionKey,
  type ReasoningEffort,
} from "@assingment/agent";
import type { AnyTool, MemoryStore } from "@anvia/core";
import { resolveActiveDocuments } from "../documents/service.js";
import { createSanitizedMemoryStore } from "./memory-sanitizer.js";
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
};

export async function buildChatRunInput(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
  agentId?: string;
}): Promise<ChatRunInput> {
  const { sessionId, userId, model, reasoningEffort, agentId } = input;

  const memory = createSanitizedMemoryStore(prisma);

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
    memory,
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
    memory,
    hasActiveDocuments,
  };
}
