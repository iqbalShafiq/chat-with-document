import type { AnyTool, ToolApprovalsOptions } from "@anvia/core";
import type { EvalCase, EvalTarget } from "@anvia/core/evals";
import { TRANSPARENT_1X1_PNG_BASE64 } from "../e2e/image-e2e-helpers.js";
import { tracing } from "../tracing.js";
import {
  createClarificationTool,
  CLARIFICATION_INSTRUCTION,
} from "../tools/clarification.js";
import { createDocumentTools } from "../tools/documents.js";
import {
  buildImageGenerationInstruction,
  createImageGenerationTools,
} from "../tools/image-generation.js";
import {
  createWebSearchTools,
  WEB_SEARCH_INSTRUCTION,
} from "../tools/web-search.js";
import {
  createCompletionModel,
  parseReasoningEffort,
} from "../providers/openai.js";
import { evalConfig } from "./config.js";
import { runAgentAndCollect } from "./run-agent.js";
import {
  createAutoClarificationResponder,
  createFakePrisma,
  createStubChunkSearchService,
  createStubImageModel,
  createStubTavilyClient,
  createStubViewImageModel,
  createStubViewImageTool,
} from "./stub-scopes.js";
import type { BehaviorTrace, EvalCaseInput, SessionConfig } from "./types.js";

export const VISION_HELPER_INSTRUCTION =
  "Your model cannot receive image input directly. When you need to see what " +
  "an image actually looks like, call view_image — it returns an accurate " +
  "text description of the real pixels via a vision model.\n" +
  "Sources you can pass:\n" +
  "- imageId: a session image id from the active image context or session history\n" +
  "- url: a public http(s) image URL (e.g. a logo or product photo from web_search / web_fetch)\n" +
  "Prefer view_image over guessing visual details. External reference images " +
  "from the web are supported — do not assume view_image is limited to " +
  "conversation-only images.";

export function buildEvalTools(sessionConfig: SessionConfig): {
  tools: AnyTool[];
  instructions: string[];
  approvals: ToolApprovalsOptions | undefined;
} {
  const tools: AnyTool[] = [];
  const instructions: string[] = [];

  if (sessionConfig.hasDocuments) {
    tools.push(...createDocumentTools({
      userId: "eval-user", sessionId: "eval-session", projectId: null,
      prisma: createFakePrisma(), searchService: createStubChunkSearchService(),
      // Text-only models crash on tool-result image bytes (the completion
      // gateway rejects image input), so the stub drops the bytes for them:
      // get_document_page_images then returns the image id + markdown only,
      // which is exactly the "image exists but I cannot see it" state that
      // should route the model to view_image.
      fetchPageImage: sessionConfig.visionModelAvailable === false
        ? async () => {
            throw new Error(
              "fixture: text-only model cannot receive page image bytes",
            );
          }
        : async () =>
            new Uint8Array(Buffer.from(TRANSPARENT_1X1_PNG_BASE64, "base64")),
    }));
  }

  tools.push(...createWebSearchTools({
    tavilyClient: createStubTavilyClient(),
    enabled: sessionConfig.webSearchEnabled,
  }));
  instructions.push(WEB_SEARCH_INSTRUCTION);

  tools.push(...createImageGenerationTools({
    model: createStubImageModel(),
    store: {
      saveGeneratedImage: async () => ({
        id: "eval-img-1",
        mediaType: "image/png",
        width: 1024,
        height: 1024,
        modelId: "fixture/image",
        prompt: "eval fixture image",
      }),
    },
    enabled: sessionConfig.imageGenEnabled,
    hasGrant: () => false,
    takeToolOverride: () => null,
    userId: "eval-user", sessionId: "eval-session", projectId: null,
    resolveReference: async () => null,
    capabilities: () => null,
  }));
  instructions.push(buildImageGenerationInstruction({ webSearchAvailable: true }));

  tools.push(createClarificationTool({ requester: createAutoClarificationResponder() }));
  instructions.push(CLARIFICATION_INSTRUCTION);

  if (!sessionConfig.visionModelAvailable) {
    tools.push(createStubViewImageTool({ model: createStubViewImageModel() }));
    instructions.push(VISION_HELPER_INSTRUCTION);
  }

  const needsApprovals = !sessionConfig.webSearchEnabled || !sessionConfig.imageGenEnabled;
  const approvals: ToolApprovalsOptions | undefined = needsApprovals
    ? { handler: async (request) => {
        const mode = sessionConfig.approvalMode ?? "auto-approve";
        return { approved: mode === "auto-approve" };
      } }
    : undefined;

  return { tools, instructions, approvals };
}

export function createBehaviorTarget(
  suiteName?: string,
): EvalTarget<EvalCaseInput, BehaviorTrace> {
  return async (input: EvalCaseInput, testCase: EvalCase<EvalCaseInput>) => {
    const { tools, instructions, approvals } = buildEvalTools(input.sessionConfig);
    const langfuseConfigured = Boolean(
      process.env.LANGFUSE_BASE_URL &&
        process.env.LANGFUSE_PUBLIC_KEY &&
        process.env.LANGFUSE_SECRET_KEY,
    );
    return runAgentAndCollect({
      prompt: input.prompt,
      sessionConfig: input.sessionConfig,
      model: createCompletionModel(input.sessionConfig.models?.[0] ?? evalConfig.model),
      reasoningEffort: parseReasoningEffort(evalConfig.modelEffort) ?? "max",
      tools,
      instructions,
      ...(approvals ? { approvals } : {}),
      ...(langfuseConfigured ? { tracing } : {}),
      ...(suiteName ? { suiteName } : {}),
      caseId: testCase.id,
    });
  };
}
