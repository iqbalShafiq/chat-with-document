import z from "zod";
import { imageGenSettingsSchema } from "./image-gen-settings.js";

export const CHAT_AGENT_ID = "chat-agent" as const;
export const CHAT_AGENT_RECIPE_VERSION = 1 as const;

/**
 * Recipes cross the BullMQ/Redis boundary. Keep every string bounded and
 * reject whitespace-only values without normalising a value that was already
 * resolved by the authenticated route.
 */
const ID_MAX = 256;
const SHORT_TEXT_MAX = 512;
const CONTEXT_TEXT_MAX = 8_000;
const INSTRUCTION_TEXT_MAX = 16_000;
const TRACE_TEXT_MAX = 256;
const ARRAY_MAX = 128;

const bounded = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "must not be blank");

const id = bounded(ID_MAX);
const shortText = bounded(SHORT_TEXT_MAX);
const contextText = bounded(CONTEXT_TEXT_MAX);
const instructionText = bounded(INSTRUCTION_TEXT_MAX);

/** The exact five optional image-tool settings, with no unknown keys. */
export const chatAgentImageGenSettingsSchema = imageGenSettingsSchema;

const documentCatalogEntrySchema = z
  .object({
    id,
    filename: shortText,
    firstPageSummary: contextText,
  })
  .strict();

const activeImageDescriptorSchema = z
  .object({
    id,
    r2Key: bounded(ID_MAX * 2),
    mediaType: shortText,
    prompt: contextText,
  })
  .strict();

const activeSnippetDescriptorSchema = z
  .object({
    id,
    text: contextText,
    sourceRole: z.enum(["user", "assistant"]),
  })
  .strict();

const imageCapabilitySetSchema = z
  .object({
    nMax: z.number().int().min(1).max(100),
    background: z.array(shortText).max(32).optional(),
    aspectRatios: z.array(shortText).max(32).optional(),
    quality: z.array(shortText).max(32).optional(),
    resolutions: z.array(shortText).max(32).optional(),
    sizes: z.array(shortText).max(32).optional(),
  })
  .strict();

const imageModelCapabilitySchema = z
  .object({
    modelId: id,
    capabilities: imageCapabilitySetSchema,
  })
  .strict();

export const chatAgentRecipeSchema = z
  .object({
    version: z.literal(CHAT_AGENT_RECIPE_VERSION),
    agentId: z.literal(CHAT_AGENT_ID),
    identity: z
      .object({
        sessionId: id,
        userId: id,
        projectId: id.nullable(),
      })
      .strict(),
    model: z
      .object({
        id,
        reasoningEffort: z.enum(["low", "medium", "high", "max"]).nullable(),
      })
      .strict(),
    features: z
      .object({
        webSearchEnabled: z.boolean(),
        imageGenerationEnabled: z.boolean(),
        deepResearchEnabled: z.boolean(),
      })
      .strict(),
    imageGenSettings: chatAgentImageGenSettingsSchema.nullable(),
    budgets: z
      .object({
        maxTurns: z.number().int().min(1).max(1_000),
        deepResearchMaxTurns: z.number().int().min(1).max(1_000),
        deepResearchMaxSearches: z.number().int().min(1).max(10_000),
      })
      .strict(),
    documents: z
      .object({
        ids: z.array(id).max(ARRAY_MAX),
        catalog: z.array(documentCatalogEntrySchema).max(ARRAY_MAX),
      })
      .strict(),
    instructionFragments: z.array(instructionText).max(ARRAY_MAX),
    contextDescriptors: z
      .array(z.object({ id, text: contextText }).strict())
      .max(ARRAY_MAX),
    activeContext: z
      .object({
        images: z.array(activeImageDescriptorSchema).max(ARRAY_MAX),
        snippet: activeSnippetDescriptorSchema.nullable(),
      })
      .strict(),
    capabilities: z
      .object({
        modelAcceptsImage: z.boolean(),
        webSearchAvailable: z.boolean(),
        imageGenerationAvailable: z.boolean(),
        deepResearchAvailable: z.boolean(),
        profilingEnabled: z.boolean(),
        context7Requested: z.boolean(),
        imageModelCapabilities: z.array(imageModelCapabilitySchema).max(ARRAY_MAX),
      })
      .strict(),
    promptClientMessageId: id.nullable(),
    trace: z
      .object({
        traceId: bounded(TRACE_TEXT_MAX),
        observationId: bounded(TRACE_TEXT_MAX).optional(),
      })
      .strict(),
  })
  .strict();

export type ChatAgentRecipe = z.infer<typeof chatAgentRecipeSchema>;
export type ChatAgentImageDescriptor = ChatAgentRecipe["activeContext"]["images"][number];
export type ChatAgentSnippetDescriptor = NonNullable<
  ChatAgentRecipe["activeContext"]["snippet"]
>;

/** A non-serializable claim handle kept outside the recipe JSON object. */
export type ChatAgentRecipeClaim = {
  /** Finalize the consume transition after the queue accepts the job. */
  commit(): Promise<void>;
  /** Reversibly restore the claimed context after enqueue failure. */
  release(): Promise<void>;
};
const recipeClaims = new WeakMap<object, ChatAgentRecipeClaim>();

export function attachChatAgentRecipeClaim(
  recipe: ChatAgentRecipe,
  claim: ChatAgentRecipeClaim,
): void {
  recipeClaims.set(recipe, claim);
}

export function getChatAgentRecipeClaim(
  recipe: ChatAgentRecipe,
): ChatAgentRecipeClaim | undefined {
  return recipeClaims.get(recipe);
}

/** Release a fresh-run context claim after an enqueue failure. */
export async function releaseChatAgentRecipeClaim(
  recipe: ChatAgentRecipe,
): Promise<void> {
  const claim = recipeClaims.get(recipe);
  if (!claim) return;
  await claim.release();
  recipeClaims.delete(recipe);
}

/** Finalize a successfully enqueued claim without serializing its handle. */
export async function commitChatAgentRecipeClaim(
  recipe: ChatAgentRecipe,
): Promise<void> {
  const claim = recipeClaims.get(recipe);
  if (!claim) return;
  await claim.commit();
  recipeClaims.delete(recipe);
}

/** Parse untrusted queue/storage input without stripping unknown fields. */
export function parseChatAgentRecipe(value: unknown): ChatAgentRecipe {
  return chatAgentRecipeSchema.parse(value);
}

/** Validate already-resolved inputs at the persistence boundary. */
export function createChatAgentRecipe(value: unknown): ChatAgentRecipe {
  return parseChatAgentRecipe(value);
}

/** Stable aliases used by route/worker adapters while the boundary migrates. */
export const parseRunRecipe = parseChatAgentRecipe;
export const createRunRecipe = createChatAgentRecipe;

export function assertRecipeIdentity(
  recipe: ChatAgentRecipe,
  identity: Pick<ChatAgentRecipe["identity"], "sessionId" | "userId">,
): void {
  if (
    recipe.identity.sessionId !== identity.sessionId ||
    recipe.identity.userId !== identity.userId
  ) {
    throw new Error("run recipe identity does not match job identity");
  }
}

export type ImageProjectionInput = {
  [key: string]: unknown;
  id: string;
  userId: string;
  sessionId: string;
  r2Key: string;
  mediaType: string;
  prompt: string;
  projectId?: string | null;
};

export type ContextSnippetProjectionInput = {
  [key: string]: unknown;
  id: string;
  userId: string;
  sessionId: string;
  text: string;
  sourceRole: "user" | "assistant";
};

/**
 * Project a persisted image row before recipe validation. Date fields, image
 * bytes, ownership fields, and provider metadata never cross the queue.
 */
export function projectGeneratedImage(
  image: ImageProjectionInput,
  owner?: { userId: string; sessionId: string },
): ChatAgentImageDescriptor {
  if (
    owner &&
    (image.userId !== owner.userId || image.sessionId !== owner.sessionId)
  ) {
    throw new Error("active image context is not owned by this session");
  }
  return activeImageDescriptorSchema.parse({
    id: image.id,
    r2Key: image.r2Key,
    mediaType: image.mediaType,
    prompt: image.prompt,
  });
}

/** Project a persisted snippet row without Prisma Date fields. */
export function projectContextSnippet(
  snippet: ContextSnippetProjectionInput,
  owner?: { userId: string; sessionId: string },
): ChatAgentSnippetDescriptor {
  if (
    owner &&
    (snippet.userId !== owner.userId || snippet.sessionId !== owner.sessionId)
  ) {
    throw new Error("context snippet is not owned by this session");
  }
  return activeSnippetDescriptorSchema.parse({
    id: snippet.id,
    text: snippet.text,
    sourceRole: snippet.sourceRole,
  });
}
