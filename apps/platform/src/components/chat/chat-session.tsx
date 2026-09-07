import {
  initialMessagesFromMemory,
  useChat,
} from "@anvia/react";
import type {
  ClientStreamEvent,
  ClientMetadataSchema,
  UIAttachment,
  UIMessage,
  UIMessagePart,
} from "@anvia/client";
import { parseUIMessages } from "@anvia/client";
import type { UseChatResult } from "@anvia/react";
import {
  ChatProvider,
  ComposerPrimitive,
  ThreadPrimitive,
} from "@anvia/react-ui";
import { X } from "lucide-react";
import { AnimatedStatusText } from "#/components/chat/animated-status-text";
import { ApprovalPanel } from "#/components/chat/approval-panel";
import { ChatMessageRow } from "#/components/chat/chat-message-row";
import { CitationSessionProvider } from "#/components/chat/citation-session-context";
import { ClarificationPanel } from "#/components/chat/clarification-panel";
import { EmptyState } from "#/components/chat/empty-state";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import { QueueConflictDialog } from "#/components/chat/queue-conflict-dialog";
import { StaleSessionDialog } from "#/components/chat/stale-session-dialog";
import {
  SessionDocumentsRail,
  type IngestionItem,
} from "#/components/chat/session-documents-panel";
import { ChatComposer } from "#/components/composer/chat-composer";
import { DeepResearchActivityPanel } from "#/components/composer/deep-research-activity-panel";
import type { AttachmentReject } from "#/lib/documents/upload-file";
import {
  API_BASE,
  ApiAuthError,
  fetchContextUsage,
  fetchRunStatus,
  fetchInteractionStatus,
  fetchChatCapabilities,
  listSessionDocuments,
  loadChatMessages,
  markSessionRead,
  stopChatRun,
  truncateSessionMemory,
  unlinkDocumentFromSession,
  uploadDocument,
  uploadSessionImage,
  isImageAttachmentLike,
  imageDimensionsFromFile,
  waitForDocumentReady,
  fetchSessionImages,
  fetchSessionImageContexts,
  fetchSessionState,
  addSessionImageContext,
  removeSessionImageContext,
  fetchImageBytes,
  isSteerNoActiveRunError,
  steerChatMessages,
  syncQueuedMessageIds,
  type ContextUsageInfo,
  type GeneratedImageMeta,
  type ImageGenSettings,
  type ModelInfo,
  type ReasoningEffortInfo,
  type SessionDocument,
  type SteerMessageInput,
  type WebCapabilities,
} from "#/lib/api";
import { type ImagePreviewContextActions } from "#/components/images/image-preview";
import { collectCitedDocuments } from "#/lib/documents/cited-documents";
import { collectWebSources } from "#/lib/chat/web-sources";
import {
  collectGeneratedImagesFromMessages,
  countRunningImageToolPartsFromMessages,
  mergeGeneratedImages,
  type GeneratedImageItem,
} from "#/lib/chat/generated-images";
import { ensureUploadableFile } from "#/lib/documents/upload-file";
import {
  parseMessageCitations,
  validateCitationsAgainstSession,
} from "#/lib/chat/citations";
import {
  canTargetMessageForTruncate,
  readChatMessageMeta,
  withChatMessageMeta,
} from "#/lib/chat/message-metadata";
import {
  createAnviaChatTransport,
  isAuthFailure,
  isRunActiveConflict,
  requireChatReasoningEffort,
  stopChatPreservingMessages,
  type ChatClientMetadata,
  type ChatRequestMetadata,
} from "#/lib/chat/anvia-transport";
import {
  createInteractionResumeStorage,
  discardChatResumeSnapshot,
  peekPendingResumeInteractionIds,
} from "#/lib/chat/interaction-resume-storage";
import {
  ChatDataSchemas,
  ChatStreamMetadataSchema,
  type ChatDataMap,
} from "#/lib/chat/client-data";
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";
import { finalizeInterruptedTools } from "#/lib/chat/finalize-interrupted-tools";
import { failedTailTruncate } from "#/lib/chat/failed-tail";
import {
  blocksDestructiveSessionAction,
  sessionFreshnessFromCount,
  type SessionFreshness,
} from "#/lib/chat/session-freshness";
import {
  nextFlushableItem,
  pendingBeforeEditing,
  chunkIds,
  type QueuedDraft,
  type QueuedItem,
} from "#/lib/chat/queued-messages";
import {
  computeGenerationActionInfo,
  getMessageRawText,
} from "#/lib/chat/message-text";
import {
  initialDeepResearchActivityState,
  reduceDeepResearchProgress,
  resetDeepResearchActivity,
  type DeepResearchActivityState,
} from "#/lib/chat/deep-research-activity";
import {
  persistImageGenSettings,
  persistImageGenerationEnabled,
  persistSelectedModel,
  persistSelectedReasoningEffort,
  readImageGenSettings,
  readImageGenerationEnabled,
  readSelectedModel,
  readSelectedReasoningEffort,
} from "#/lib/chat-preferences";
import {
  modelById,
  resolveReasoningFallback,
} from "#/lib/chat/models";
import { useContextSnippet } from "#/hooks/use-context-snippet";
import { useQueuedMessages } from "#/hooks/use-queued-messages";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

export type ChatUIMessage = UIMessage<ChatClientMetadata, ChatDataMap>;
type ChatTransport = ReturnType<typeof createAnviaChatTransport>;
export type ChatController = UseChatResult<ChatTransport>;
type MemoryMessages = Parameters<typeof initialMessagesFromMemory>[0];

const ChatClientMetadataSchema: ClientMetadataSchema<ChatClientMetadata> = {
  safeParse(value) {
    const streamMetadata = ChatStreamMetadataSchema.safeParse(value);
    if (streamMetadata.success) return streamMetadata;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { success: false, error: { message: "Invalid chat metadata" } };
    }
    return {
      success: true,
      data: readChatMessageMeta(value),
    };
  },
};

export function parseMemoryMessages(value: unknown): ChatUIMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("Chat history must be an array of Anvia messages");
  }
  const memoryMessages = value as MemoryMessages;
  return parseUIMessages(initialMessagesFromMemory(memoryMessages), {
    metadataSchema: ChatClientMetadataSchema,
    dataSchemas: ChatDataSchemas,
  });
}

function documentIdsFromMetadata(metadata: UIMessage["metadata"]): string[] {
  return readChatMessageMeta(metadata).documentIds ?? [];
}

/**
 * `kind` joins `ChatMessageMeta` in a later task; for now read it straight
 * from the raw metadata object.
 */
function metadataKind(metadata: UIMessage["metadata"]): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const kind = (metadata as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : undefined;
}

/** Raw text of the most recent user message, for prefill after a failed run. */
function failedUserMessageText(messages: readonly UIMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return getMessageRawText(message);
  }
  return null;
}

function createClientMessageId() {
  return crypto.randomUUID();
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function resolveAttachmentFile(attachment: UIAttachment) {
  if (attachment.url?.startsWith("blob:")) {
    const response = await fetch(attachment.url);
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Attachment is empty: ${attachment.name ?? attachment.id}`);
    }
    return ensureUploadableFile(
      new File([blob], attachment.name ?? "document", {
        type: attachment.mediaType ?? "application/octet-stream",
      }),
    );
  }

  if (attachment.data) {
    const dataUrl = attachment.data.startsWith("data:")
      ? attachment.data
      : `data:${attachment.mediaType ?? "application/octet-stream"};base64,${attachment.data}`;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error(`Attachment is empty: ${attachment.name ?? attachment.id}`);
    }
    return ensureUploadableFile(
      new File([blob], attachment.name ?? "document", {
        type: attachment.mediaType ?? (blob.type || "application/octet-stream"),
      }),
    );
  }

  throw new Error(`Unable to read attachment: ${attachment.name ?? attachment.id}`);
}

export function ChatSession({
  sessionId,
  projectId,
  initialMessages,
  models,
  reasoningEfforts,
  modelsStatus,
  modelsError,
  modelsRetry,
  onStreamSettled,
  onAuthFailure,
  onImageContextActions,
  onReloadMessages,
}: {
  sessionId: string;
  projectId?: string | null;
  initialMessages: ChatUIMessage[];
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  modelsStatus: "loading" | "success" | "error";
  modelsError: string | null;
  modelsRetry: () => void;
  onStreamSettled: () => void;
  onAuthFailure: () => void;
  onImageContextActions?: (
    actions: ImagePreviewContextActions | null,
  ) => void;
  /** Replaces the loaded conversation (fresh history after a stale dialog). */
  onReloadMessages?: (messages: ChatUIMessage[]) => void;
}) {
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const wasActiveRunRef = useRef(false);
  const [ingestionItems, setIngestionItems] = useState<IngestionItem[]>([]);
  const [sessionDocuments, setSessionDocuments] = useState<SessionDocument[]>(
    [],
  );
  const [sessionImages, setSessionImages] = useState<GeneratedImageMeta[]>([]);
  const [sessionImagesError, setSessionImagesError] = useState(false);
  const [interactionReconcileVersion, setInteractionReconcileVersion] =
    useState(0);
  const [activeContextImages, setActiveContextImages] = useState<
    GeneratedImageMeta[]
  >([]);
  const [removingDocumentId, setRemovingDocumentId] = useState<string | null>(
    null,
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [attachmentErrors, setAttachmentErrors] = useState<AttachmentReject[]>(
    [],
  );
  const [isIngesting, setIsIngesting] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    readSelectedModel(models),
  );
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(false);
  const [imageGenerationEnabled, setImageGenerationEnabled] = useState(() =>
    readImageGenerationEnabled(),
  );
  const [imageGenSettings, setImageGenSettings] = useState<ImageGenSettings>(() =>
    readImageGenSettings(),
  );
  const [capabilities, setCapabilities] = useState<WebCapabilities | null>(null);
  const [selectedReasoningEffort, setSelectedReasoningEffort] =
    useState<string | null>(null);
  const [hydratedResumePolicy, setHydratedResumePolicy] = useState<{
    modelId: string;
    reasoningEffort: string | null;
  } | null>(null);
  const [deepResearch, setDeepResearch] = useState<DeepResearchActivityState>(
    initialDeepResearchActivityState,
  );
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo | null>(
    null,
  );
  const [previousRunError, setPreviousRunError] = useState(false);
  /** Latest request policy for the v1 transport (avoids stale closures). */
  const selectedModelRef = useRef(selectedModel);
  const selectedReasoningEffortRef = useRef(selectedReasoningEffort);
  /** Latest catalog for synchronous model-switch fallback (avoids stale closures). */
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const reasoningEffortsRef = useRef(reasoningEfforts);
  reasoningEffortsRef.current = reasoningEfforts;
  const webSearchEnabledRef = useRef(webSearchEnabled);
  const deepResearchEnabledRef = useRef(deepResearchEnabled);
  const imageGenerationEnabledRef = useRef(imageGenerationEnabled);
  const imageGenSettingsRef = useRef(imageGenSettings);
  selectedModelRef.current = selectedModel;
  selectedReasoningEffortRef.current = selectedReasoningEffort;
  webSearchEnabledRef.current = webSearchEnabled;
  deepResearchEnabledRef.current = deepResearchEnabled;
  imageGenerationEnabledRef.current = imageGenerationEnabled;
  imageGenSettingsRef.current = imageGenSettings;
  /** Last submitted turn's document subset for native interaction responses. */
  const lastSubmittedDocumentIdsRef = useRef<string[]>(
    (() => {
      for (let index = initialMessages.length - 1; index >= 0; index -= 1) {
        const message = initialMessages[index];
        if (message?.role === "user") {
          return documentIdsFromMetadata(message.metadata);
        }
      }
      return [];
    })(),
  );
  /** Latest chat messages for stable event handlers (see handleChatEvent). */
  const messagesRef = useRef<readonly ChatUIMessage[]>([]);
  /** Latest chat controller for stable event handlers (see onError / stop). */
  const chatRef = useRef<ChatController | null>(null);
  /** useChat reports transport failures through onError instead of rejecting sendMessage. */
  const chatRequestFailedRef = useRef(false);
  const modelsStatusRef = useRef(modelsStatus);
  modelsStatusRef.current = modelsStatus;
  const reasoningInitializedRef = useRef(false);
  const resumedSessionRef = useRef<string | null>(null);
  const contextUsageVersionRef = useRef(0);
  /** Deferred composer prefill after a streamed run failure (editor is read-only while streaming). */
  const pendingFailedTextRef = useRef<string | null>(null);
  /** Shared with doc rail so its bottom band matches the textfield dock. */
  const [composerDockH, setComposerDockH] = useState(120);

  const queuedState = useQueuedMessages(sessionId);
  const { items: queuedItems, actions: queueActions } = queuedState;
  const queuedItemsRef = useRef(queuedItems);
  queuedItemsRef.current = queuedItems;
  const [queueHold, setQueueHold] = useState(false);
  const [queueConflictOpen, setQueueConflictOpen] = useState(false);
  const autoFlushBusyRef = useRef(false);
  const autoFlushPreserveRef = useRef(false);
  const submitBypassRef = useRef(false);
  const pendingManualSubmitRef = useRef<{
    input: string;
    attachments: UIAttachment[];
    chatController: ChatController;
    clear: () => void;
  } | null>(null);
  const [editHydration, setEditHydration] = useState<{
    version: number;
    draft: QueuedDraft | null;
  } | null>(null);
  const editHydrationVersionRef = useRef(0);
  const [clearComposerSignal, setClearComposerSignal] = useState<{
    version: number;
  } | null>(null);
  const clearSignalVersionRef = useRef(0);

  useEffect(() => {
    if (queuedItems.length === 0 && queueHold) setQueueHold(false);
  }, [queuedItems.length, queueHold]);

  useEffect(() => {
    const el = composerDockRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (typeof h === "number" && h > 0) setComposerDockH(Math.ceil(h));
    });
    ro.observe(el);
    setComposerDockH(Math.ceil(el.getBoundingClientRect().height));
    return () => ro.disconnect();
  }, []);

  const refreshSessionDocuments = useCallback(async () => {
    try {
      const documents = await listSessionDocuments(sessionId);
      setSessionDocuments(documents);
    } catch {
      // Keep the previous list if refresh fails.
    }
  }, [sessionId]);

  /**
   * Session image history. Refetched on mount, after regenerate/truncate, and
   * retried when the last fetch failed. Version guard drops stale responses
   * (e.g. a fetch kicked off by an action in a previous run).
   */
  const sessionImagesVersionRef = useRef(0);
  const refreshSessionImages = useCallback(async () => {
    const version = ++sessionImagesVersionRef.current;
    try {
      const images = await fetchSessionImages(sessionId);
      if (version !== sessionImagesVersionRef.current) return;
      setSessionImages(images);
      setSessionImagesError(false);
    } catch {
      if (version === sessionImagesVersionRef.current) {
        // Keep the previous list, but flag it so the next relevant event
        // (docs refresh / regenerate / truncate) retries instead of silently
        // serving stale data.
        setSessionImagesError(true);
      }
    }
  }, [sessionId]);

  const sessionDocumentIds = useMemo(
    () => new Set(sessionDocuments.map((doc) => doc.id)),
    [sessionDocuments],
  );

  const handleLinkedDocuments = useCallback((documents: SessionDocument[]) => {
    setSessionDocuments(documents);
  }, []);

  /** Guardrail rejects (size limit…) reported at attach time by the composer. */
  const handleAttachmentRejected = useCallback((rejects: AttachmentReject[]) => {
    setAttachmentErrors((current) => [...current, ...rejects]);
  }, []);

  const handleDismissAttachmentError = useCallback((id: string) => {
    setAttachmentErrors((current) =>
      current.filter((item) => item.id !== id),
    );
  }, []);

  const handleRemoveActiveDocument = useCallback(
    async (documentId: string) => {
      setRemovingDocumentId(documentId);
      try {
        await unlinkDocumentFromSession({ sessionId, documentId });
        setSessionDocuments((current) =>
          current.filter((doc) => doc.id !== documentId),
        );
      } finally {
        setRemovingDocumentId(null);
      }
    },
    [sessionId],
  );

  const chatTransport = useMemo(
    () =>
      createAnviaChatTransport({
        endpoint: `${API_BASE}/api/chat`,
        getRequestMetadata: (request): ChatRequestMetadata => {
          if (request.type === "messages") {
            const last = request.messages.at(-1);
            if (last?.role === "user") {
              lastSubmittedDocumentIdsRef.current = documentIdsFromMetadata(
                last.metadata,
              );
            }
          }
          return {
            sessionId,
            documentIds: lastSubmittedDocumentIdsRef.current,
            modelId: selectedModelRef.current,
            reasoningEffort: requireChatReasoningEffort(
              selectedReasoningEffortRef.current,
            ),
            webSearchEnabled: webSearchEnabledRef.current,
            imageGenerationEnabled: imageGenerationEnabledRef.current,
            deepResearchEnabled: deepResearchEnabledRef.current,
            imageGenSettings: imageGenerationEnabledRef.current
              ? imageGenSettingsRef.current
              : null,
          };
        },
      }),
    [sessionId],
  );

  /** Writes failed-run text through the public v1 textarea composer contract. */
  const setComposerInputText = useCallback((text: string) => {
    const textarea = composerInputRef.current;
    if (!textarea) return;
    textarea.value = text;
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }),
    );
  }, []);

  /** Fetch context usage once; shared by the polling effect and message_end. */
  const refreshContextUsage = useCallback(async () => {
    if (modelsStatusRef.current !== "success") return;
    if (!selectedModelRef.current) return;
    const version = ++contextUsageVersionRef.current;
    try {
      const usage = await fetchContextUsage({
        sessionId,
        model: selectedModelRef.current,
        reasoningEffort: selectedReasoningEffortRef.current,
      });
      if (version !== contextUsageVersionRef.current) return;
      setContextUsage(usage);
    } catch {
      // Fresh chats and catalog races must not banner the composer.
      if (version === contextUsageVersionRef.current) {
        setContextUsage(null);
      }
    }
  }, [sessionId]);

  const handleChatEvent = useCallback(
    (event: ClientStreamEvent<ChatClientMetadata, ChatDataMap>) => {
      if (event.type === "data") {
        switch (event.name) {
          case "deepResearchProgress":
            setDeepResearch((state) =>
              reduceDeepResearchProgress(state, event.data),
            );
            return;
          case "queuedMessageApplied": {
            const item = queuedItemsRef.current.find(
              (entry) => entry.id === event.data.clientMessageId,
            );
            if (!item) return;
            chatRef.current?.setMessages((current) => {
              const exists = current.some(
                (message) =>
                  message.role === "user" &&
                  readChatMessageMeta(message.metadata).clientMessageId ===
                    event.data.clientMessageId,
              );
              if (exists) return current;
              const parts: UIMessagePart<ChatDataMap>[] = [
                ...item.attachments.map((attachment) => ({
                  id: crypto.randomUUID(),
                  type: "attachment" as const,
                  attachment,
                })),
              ];
              if (item.text.trim().length > 0) {
                parts.push({
                  id: crypto.randomUUID(),
                  type: "text",
                  text: item.text,
                });
              }
              return [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts,
                  metadata: withChatMessageMeta(undefined, {
                    clientMessageId: event.data.clientMessageId,
                    createdAt: new Date().toISOString(),
                    documentIds: item.documentIds,
                    ...(item.contextSnippet
                      ? { contextSnippet: item.contextSnippet }
                      : {}),
                  }),
                },
              ];
            });
            queueActions.applyAck(event.data.clientMessageId);
            if (event.data.attachmentCount > 0) {
              void refreshSessionImages();
            }
            return;
          }
        }
        return;
      }

      switch (event.type) {
        case "message_end":
          setDeepResearch(resetDeepResearchActivity());
          void refreshContextUsage();
          return;
        case "error":
          setComposerError(`Run failed: ${event.error.message}`);
          setQueueHold(true);
          {
            const failedText = failedUserMessageText(messagesRef.current);
            if (failedText !== null) {
              // The editor is read-only while streaming; apply once the stream ends.
              pendingFailedTextRef.current = failedText;
            }
          }
          return;
        default:
          return;
      }
    },
    [queueActions, refreshContextUsage, refreshSessionImages],
  );

  const interactionResumeStorage = useMemo(
    () => createInteractionResumeStorage(window.sessionStorage),
    [],
  );

  const chat = useChat({
    transport: chatTransport,
    initialMessages,
    // Resume is driven explicitly by the run-status join effect; the v1
    // controller owns the version-3 snapshot and canonical request.
    resume: { key: sessionId, storage: interactionResumeStorage, auto: false },
    onEvent: handleChatEvent,
    onError: (error) => {
      chatRequestFailedRef.current = true;
      if (error instanceof ApiAuthError) {
        onAuthFailure();
        return;
      }
      if (isAuthFailure(error)) {
        onAuthFailure();
        return;
      }
      if (isRunActiveConflict(error)) {
        // Another tab already holds the active-run lock for this session.
        setComposerError(
          "This session is already being processed in another tab.",
        );
        chatRef.current?.setMessages((current) => {
          const last = current.at(-1);
          if (!last || last.role !== "user") return current;
          return current.slice(0, -1);
        });
        return;
      }
      if (error.name !== "AbortError") {
        setComposerError("The chat request could not be completed.");
      }
    },
  });

  chatRef.current = chat;

  // Keep the latest messages readable from stable event handlers.
  useEffect(() => {
    messagesRef.current = chat.messages;
  }, [chat.messages]);

  const resumeChatRef = useRef(chat.resume);
  resumeChatRef.current = chat.resume;
  const stopInFlightRef = useRef(false);

  useEffect(() => {
    if (chat.status !== "submitted" && chat.status !== "streaming") {
      stopInFlightRef.current = false;
    }
  }, [chat.status]);

  /** Stop the server run, abort the v1 stream, and finalize visible tool cards. */
  const handleStopRun = useCallback(() => {
    if (stopInFlightRef.current) return;
    const current = chatRef.current;
    if (!current) return;
    stopInFlightRef.current = true;
    const streamId = current.streamId;
    void (async () => {
      try {
        if (streamId) await stopChatRun(streamId, sessionId);
      } catch (error) {
        setComposerError(
          error instanceof Error ? error.message : "The chat run could not be stopped.",
        );
      } finally {
        stopChatPreservingMessages(
          {
            messages: current.messages,
            stop: () => current.stop(),
            setMessages: (messages) => current.setMessages([...messages]),
          },
          (messages) => finalizeInterruptedTools([...messages]),
        );
        setQueueHold(true);
      }
    })();
  }, [sessionId]);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    persistSelectedModel(model);
    // Resolve the reasoning effort against the NEW model's supported set
    // immediately, so no request (chat or context-usage) can carry the
    // previous model's stale effort (e.g. max on the Meta contributor tier).
    const nextModel = modelById(modelsRef.current, model);
    if (nextModel) {
      const next = resolveReasoningFallback(
        selectedReasoningEffortRef.current,
        nextModel.reasoningEfforts,
        reasoningEffortsRef.current,
      );
      if (next !== selectedReasoningEffortRef.current) {
        setSelectedReasoningEffort(next);
        persistSelectedReasoningEffort(next);
      }
    }
  }, []);

  const handleReasoningChange = useCallback((effort: string | null) => {
    setSelectedReasoningEffort(effort);
    persistSelectedReasoningEffort(effort);
  }, []);

  /**
   * Active image context — images pinned by the user as chat context for this
   * session. Refetched on mount/session change; toggled via the pin button on
   * thumbnails (a confirmation modal gates non-vision models).
   */
  const activeContextVersionRef = useRef(0);
  const refreshActiveContext = useCallback(async () => {
    const version = ++activeContextVersionRef.current;
    try {
      const images = await fetchSessionImageContexts(sessionId);
      if (version !== activeContextVersionRef.current) return;
      setActiveContextImages(images);
    } catch {
      // keep previous list on failure
    }
  }, [sessionId]);

  const contextSnippetState = useContextSnippet(sessionId);

  const handleAddContext = useCallback(
    async (text: string, sourceRole: ContextSnippetSourceRole) => {
      return contextSnippetState.setSnippet(text, sourceRole);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snippet state is internal to the hook
    [contextSnippetState.setSnippet],
  );

  // Pinning works with any model: vision models receive the images as image
  // input, text-only models get them via the view_image helper tool.
  const handleToggleImageContext = useCallback(
    async (image: GeneratedImageItem) => {
      const isPinned = activeContextImages.some((item) => item.id === image.id);
      if (isPinned) {
        try {
          await removeSessionImageContext({ sessionId, imageId: image.id });
          void refreshActiveContext();
        } catch (error) {
          setComposerError(
            error instanceof Error
              ? error.message
              : "Could not update image context",
          );
        }
        return;
      }

      try {
        await addSessionImageContext({ sessionId, imageId: image.id });
        void refreshActiveContext();
      } catch (error) {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not add image context",
        );
      }
    },
    [activeContextImages, sessionId, refreshActiveContext],
  );

  const handleImageGenerationToggle = useCallback((enabled: boolean) => {
    setImageGenerationEnabled(enabled);
    persistImageGenerationEnabled(enabled);
  }, []);

  // Register the context actions with the ImagePreviewProvider (rendered one
  // level up) so the viewer's "Add to context" button can toggle pinning.
  const previewIsPinned = useCallback(
    (image: GeneratedImageItem) =>
      activeContextImages.some((item) => item.id === image.id),
    [activeContextImages],
  );
  useEffect(() => {
    onImageContextActions?.({
      toggle: handleToggleImageContext,
      isPinned: previewIsPinned,
    });
    return () => onImageContextActions?.(null);
  }, [onImageContextActions, handleToggleImageContext, previewIsPinned]);

  const handleImageGenSettingsChange = useCallback(
    (settings: ImageGenSettings) => {
      setImageGenSettings(settings);
      persistImageGenSettings(settings);
    },
    [],
  );

  const focusComposer = useCallback(() => {
    composerInputRef.current?.focus();
  }, []);

  const handleStarterPrompt = useCallback(
    (prompt: string) => {
      setComposerInputText(prompt);
      focusComposer();
    },
    [focusComposer, setComposerInputText],
  );

  useEffect(() => {
    const activeRun =
      chat.status === "submitted" || chat.status === "streaming";
    if (wasActiveRunRef.current && !activeRun) {
      // Stamp createdAt + dual-write citations on the latest assistant turn.
      const sessionDocIds = new Set(sessionDocuments.map((d) => d.id));
      chat.setMessages((messages) => {
        const last = messages.at(-1);
        if (!last || last.role !== "assistant") return messages;

        const existing = readChatMessageMeta(last.metadata);
        const rawText = getMessageRawText(last);
        const parsed = parseMessageCitations(rawText).citations;
        const citations =
          parsed.length > 0
            ? validateCitationsAgainstSession(parsed, sessionDocIds)
            : existing.citations;

        const needsCreatedAt = !existing.createdAt;
        const needsCitations =
          citations !== undefined &&
          citations.length > 0 &&
          (!existing.citations || existing.citations.length === 0);

        if (!needsCreatedAt && !needsCitations) return messages;

        return messages.map((message, index) =>
          index === messages.length - 1
            ? {
                ...message,
                metadata: withChatMessageMeta(message.metadata, {
                  ...(needsCreatedAt
                    ? { createdAt: new Date().toISOString() }
                    : {}),
                  ...(needsCitations ? { citations } : {}),
                }),
              }
            : message,
        );
      });
      onStreamSettled();
      void refreshSessionImages();
      // Anything still inflight at stream end was never acked — send-now
      // items that lost their run revert to pending for the next flush.
      queueActions.revertInflight();
      void markSessionRead(sessionId).catch(() => {});
      // A failed run defers its composer prefill until the editor is editable.
      if (pendingFailedTextRef.current !== null) {
        setComposerInputText(pendingFailedTextRef.current);
        pendingFailedTextRef.current = null;
      }
      focusComposer();
    }
    wasActiveRunRef.current = activeRun;
  }, [
    chat.setMessages,
    chat.status,
    focusComposer,
    onStreamSettled,
    queueActions,
    sessionDocuments,
    setComposerInputText,
  ]);

  useEffect(() => {
    focusComposer();
  }, [focusComposer]);

  useEffect(() => {
    setSessionDocuments([]);
    setSessionImages([]);
    setSessionImagesError(false);
    setActiveContextImages([]);
    setIngestionItems([]);
    setComposerError(null);
    setAttachmentErrors([]);
    setIsIngesting(false);
    setContextUsage(null);
    setDeepResearch(resetDeepResearchActivity());
    setPreviousRunError(false);
    void refreshSessionDocuments();
    void refreshSessionImages();
    void refreshActiveContext();
  }, [
    refreshSessionDocuments,
    refreshSessionImages,
    refreshActiveContext,
  ]);

  // Capability fetch is session-aware so document-only Deep Research can be
  // enabled even when this deployment has no web-search key.
  useEffect(() => {
    void fetchChatCapabilities(sessionId)
      .then(setCapabilities)
      .catch(() => {
        // capabilities stay null; toggles render as unavailable
      });
  }, [sessionId]);

  useEffect(() => {
    setEditingMessageId(null);
  }, [sessionId]);

  // Reconcile the selected model once the catalog arrives:
  // stored preference > first active model > default. Always apply the
  // storage-aware read — at mount the catalog is still empty (loading), so
  // without this the stored preference would never be restored.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    const next = readSelectedModel(models);
    if (next !== selectedModelRef.current) {
      setSelectedModel(next);
      persistSelectedModel(next);
    }
  }, [models, modelsStatus]);

  const activeModel = useMemo(
    () => modelById(models, selectedModel),
    [models, selectedModel],
  );

  // Init the reasoning effort from storage on first catalog arrival; on model
  // change, resolve a supported fallback for the new model and persist both.
  useEffect(() => {
    if (!activeModel) return;
    // Model and effort form one policy tuple in persisted interaction recipes.
    // On reload React applies the stored model asynchronously; do not map the
    // stored effort through the temporary default model in the intervening
    // render or a pending interaction will resume with mismatched metadata.
    if (activeModel.modelId !== readSelectedModel(models)) return;
    const base = reasoningInitializedRef.current
      ? selectedReasoningEffortRef.current
      : readSelectedReasoningEffort(activeModel.reasoningEfforts);
    reasoningInitializedRef.current = true;
    const next = resolveReasoningFallback(
      base,
      activeModel.reasoningEfforts,
      reasoningEfforts,
    );
    if (next !== selectedReasoningEffortRef.current) {
      setSelectedReasoningEffort(next);
      persistSelectedReasoningEffort(next);
    }
    setHydratedResumePolicy((current) =>
      current?.modelId === activeModel.modelId &&
      current.reasoningEffort === next
        ? current
        : { modelId: activeModel.modelId, reasoningEffort: next },
    );
  }, [activeModel, models, reasoningEfforts]);

  const resumePolicyReady =
    modelsStatus === "success" &&
    activeModel !== null &&
    hydratedResumePolicy?.modelId === selectedModel &&
    hydratedResumePolicy.reasoningEffort === selectedReasoningEffort;

  // Poll context usage every 30s while the catalog is available.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    void refreshContextUsage();
    const timer = window.setInterval(() => {
      void refreshContextUsage();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [modelsStatus, refreshContextUsage]);

  // Refetch context usage whenever the selected model / effort changes so the
  // ring and popover always reflect the ACTIVE model's window and ratio.
  useEffect(() => {
    if (modelsStatus !== "success") return;
    void refreshContextUsage();
  }, [selectedModel, selectedReasoningEffort, modelsStatus, refreshContextUsage]);

  // Rejoin a still-running run on load (closed-tab recovery) and surface a
  // banner for a run that failed server-side. The v1 continuation recipe
  // includes the exact model/reasoning tuple, so never resume until the stored
  // policy has been hydrated through the live catalog. "missing" is idle.
  useEffect(() => {
    if (!resumePolicyReady || resumedSessionRef.current === sessionId) return;
    let cancelled = false;
    void (async () => {
      let status: Awaited<ReturnType<typeof fetchRunStatus>> | null = null;
      try {
        status = await fetchRunStatus(sessionId);
      } catch {
        // Run status is advisory; the persisted v3 snapshot remains the
        // authoritative browser-side input for controller restoration.
      }
      if (cancelled) return;
      if (status?.status === "error") {
        setPreviousRunError(true);
      }
      try {
        // sessionStorage keeps a suspended approval after refresh. Redis may
        // already have expired it — drop the snapshot so the card does not
        // return as a live prompt.
        const pendingIds = peekPendingResumeInteractionIds(
          window.sessionStorage,
          sessionId,
        );
        if (pendingIds.length > 0) {
          const statuses = await Promise.all(
            pendingIds.map((id) => fetchInteractionStatus(id)),
          );
          const anyLive = statuses.some((status) => status === "pending");
          if (!anyLive) {
            discardChatResumeSnapshot(window.sessionStorage, sessionId);
            if (status?.status !== "running") return;
          }
        }
        // A native suspended interaction is terminal from the worker's
        // perspective but still resumable by the user. The custom storage
        // retains that v3 snapshot, so always let the controller restore it.
        await resumeChatRef.current();
      } catch {
        if (!cancelled) {
          setComposerError(
            status?.status === "running" && status.streamId
              ? "This active run could not be resumed in this browser. Reload the session to recover it."
              : "Saved run state could not be restored. Reload the session to retry.",
          );
        }
      } finally {
        if (!cancelled) resumedSessionRef.current = sessionId;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resumePolicyReady, sessionId]);

  // Prefill the composer from a persisted failed [user, assistant error] tail.
  useEffect(() => {
    if (modelsStatus !== "success" || initialMessages.length < 2) return;
    const last = initialMessages.at(-1);
    const secondLast = initialMessages.at(-2);
    if (
      !last ||
      last.role !== "assistant" ||
      !secondLast ||
      secondLast.role !== "user"
    ) {
      return;
    }
    if (metadataKind(last.metadata) !== "error") return;
    setComposerInputText(getMessageRawText(secondLast));
  }, [initialMessages, modelsStatus, setComposerInputText]);

  // ─── Stale-session guard (freshness check before send) ───────────────────
  // The server memory is the source of truth; another window/device may have
  // appended messages. Compare persisted counts: stale ⟺ server has MORE
  // messages than this view knows. Destructive truncate/resubmit fails closed
  // when freshness cannot be proven. Ordinary sends still notice stale views
  // after the non-destructive append.
  const [staleDialog, setStaleDialog] = useState<{
    kind: "send" | "resubmit";
  } | null>(null);
  /**
   * Latest send body, kept in a ref so handlers can re-invoke it without
   * stale closures (same pattern as chatRef/resumeChatRef).
   */
  const submitComposerRef = useRef<
    (
      input: string,
      attachments: UIAttachment[],
      chat: ChatController,
      clear: () => void,
    ) => Promise<void>
  >(async () => {});

  /**
   * Shared doc-upload step for manual and queued sends: ingests every
   * non-image attachment, returns their session document ids. Throws on
   * failure (composerError already set by the caller).
   */
  const uploadComposerDocuments = useCallback(
    async (attachments: UIAttachment[]): Promise<string[]> => {
      const documentAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      const documentIds: string[] = [];
      if (documentAttachments.length === 0) return documentIds;

      setIsIngesting(true);
      setIngestionItems([]);
      try {
        for (const attachment of documentAttachments) {
          const file = await resolveAttachmentFile(attachment);
          if (file.size === 0) {
            throw new Error(`File is empty: ${file.name}`);
          }
          const itemId = attachment.id || crypto.randomUUID();
          setIngestionItems((current) => [
            ...current,
            { id: itemId, filename: file.name, status: "uploading" },
          ]);
          const uploaded = await uploadDocument({ sessionId, file, projectId });
          const ready = await waitForDocumentReady({
            sessionId,
            documentId: uploaded.id,
            onStatus: (status) => {
              setIngestionItems((current) =>
                current.map((item) =>
                  item.id === itemId ? { ...item, status: status.status } : item,
                ),
              );
            },
          });
          documentIds.push(ready.id);
        }
        await refreshSessionDocuments();
        // Retry a failed image-history fetch alongside the docs refresh
        // so the rail doesn't silently serve stale data.
        if (sessionImagesError) void refreshSessionImages();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Document processing failed";
        setComposerError(message);
        setIngestionItems((current) =>
          current.map((item) =>
            item.status === "uploading" ||
            item.status === "queued" ||
            item.status === "ocr_processing" ||
            item.status === "embedding_processing"
              ? { ...item, status: "failed" }
              : item,
          ),
        );
        throw error;
      } finally {
        setIsIngesting(false);
      }
      return documentIds;
    },
    [projectId, refreshSessionDocuments, sessionId, sessionImagesError],
  );

  /**
   * Queue the composer draft (send-while-streaming / hold): pre-uploads
   * documents at queue time, snapshots single-use context (snippet + pins)
   * into the item, and clears the composer via the versioned clear signal.
   */
  const queueComposerDraft = useCallback(
    async ({
      input,
      attachments,
    }: {
      input: string;
      attachments: UIAttachment[];
    }): Promise<void> => {
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds: string[] = [];
      try {
        documentIds = await uploadComposerDocuments(attachments);
      } catch (error) {
        // uploadComposerDocuments sets composerError on its own failure paths;
        // this guard also surfaces non-Error throws so a failed queue is never
        // silent (the composer keeps the draft, nothing is queued).
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not queue the message",
        );
        return;
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.queueItem({
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setClearComposerSignal({
        version: ++clearSignalVersionRef.current,
      });
      // Single-use context moved into the item: clear chip (server row) + pins.
      if (snippet) void contextSnippetState.remove().catch(() => {});
      for (const image of activeContextImages) {
        void removeSessionImageContext({ sessionId, imageId: image.id }).catch(
          () => {},
        );
      }
      if (pinnedImageIds.length > 0) void refreshActiveContext();
      void refreshSessionDocuments();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      refreshSessionDocuments,
      sessionId,
      uploadComposerDocuments,
    ],
  );

  /**
   * Recall a queued item for editing: mark it editing, hydrate the composer
   * with its draft, and restore its single-use context (snippet + pins).
   */
  const handleQueueRecall = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "pending") return;
      queueActions.startEdit(id);
      setEditHydration({
        version: ++editHydrationVersionRef.current,
        draft: {
          text: item.text,
          attachments: item.attachments,
          documentIds: item.documentIds,
          contextSnippet: item.contextSnippet,
          pinnedImageIds: item.pinnedImageIds,
        },
      });
      contextSnippetState.setLocal(
        item.contextSnippet
          ? {
              id: `queue-${item.id}`,
              text: item.contextSnippet.text,
              sourceRole: item.contextSnippet.sourceRole,
              createdAt: new Date().toISOString(),
            }
          : null,
      );
      for (const imageId of item.pinnedImageIds) {
        void addSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
      focusComposer();
    },
    [
      addSessionImageContext,
      contextSnippetState,
      focusComposer,
      queueActions,
      refreshActiveContext,
      sessionId,
    ],
  );

  /** Commit the composer contents back into the editing queue item. */
  const handleSubmitQueueEdit = useCallback(
    async (input: string, attachments: UIAttachment[]) => {
      const editing = queuedItemsRef.current.find(
        (entry) => entry.status === "editing",
      );
      if (!editing) return;
      const trimmed = input.trim();
      if (!trimmed && attachments.length === 0) return;

      let documentIds = editing.documentIds;
      const docAttachments = attachments.filter(
        (attachment) => !isImageAttachmentLike(attachment),
      );
      if (docAttachments.length > 0) {
        try {
          const uploaded = await uploadComposerDocuments(docAttachments);
          documentIds = [...editing.documentIds, ...uploaded];
        } catch {
          return;
        }
      }

      const imageAttachments: UIAttachment[] = [];
      for (const attachment of attachments) {
        if (!isImageAttachmentLike(attachment)) continue;
        if (attachment.url?.startsWith("blob:")) {
          try {
            const response = await fetch(attachment.url);
            const blob = await response.blob();
            imageAttachments.push({
              ...attachment,
              url: undefined,
              data: await blobToDataUrl(blob),
            });
          } catch {
            setComposerError("Could not read image attachment");
            return;
          }
        } else {
          imageAttachments.push(attachment);
        }
      }

      const snippet = contextSnippetState.snippet;
      const pinnedImageIds = activeContextImages.map((image) => image.id);

      queueActions.submitEdit(editing.id, {
        text: trimmed,
        attachments: imageAttachments,
        documentIds,
        contextSnippet: snippet
          ? { text: snippet.text, sourceRole: snippet.sourceRole }
          : null,
        pinnedImageIds,
      });

      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      if (snippet) void contextSnippetState.remove().catch(() => {});
      if (pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [
      activeContextImages,
      contextSnippetState,
      queueActions,
      refreshActiveContext,
      uploadComposerDocuments,
    ],
  );

  /** Application-owned submit boundary for an already running v1 chat. */
  const handleActiveComposerSubmit = useCallback(
    async (input: string, attachments: UIAttachment[]) => {
      const editing = queuedItemsRef.current.find(
        (item) => item.status === "editing",
      );
      if (editing) {
        await handleSubmitQueueEdit(input, attachments);
        return;
      }
      await queueComposerDraft({ input, attachments });
    },
    [handleSubmitQueueEdit, queueComposerDraft],
  );

  /** Abort a queue edit: back to pending, composer cleared, context restored. */
  const handleQueueCancelEdit = useCallback(
    (id: string) => {
      const item = queuedItemsRef.current.find((entry) => entry.id === id);
      if (!item || item.status !== "editing") return;
      queueActions.cancelEdit(id);
      setEditHydration({ version: ++editHydrationVersionRef.current, draft: null });
      setClearComposerSignal({ version: ++clearSignalVersionRef.current });
      contextSnippetState.setLocal(null);
      for (const imageId of item.pinnedImageIds) {
        void removeSessionImageContext({ sessionId, imageId }).catch(() => {});
      }
      if (item.pinnedImageIds.length > 0) void refreshActiveContext();
    },
    [contextSnippetState, queueActions, refreshActiveContext, sessionId],
  );

  /**
   * Build the steer payload for a queued item: record local images in the
   * session gallery, then serialize image attachments + pinned images as
   * base64 attachment data for the active run.
   */
  const buildSteerPayload = useCallback(
    async (item: QueuedItem): Promise<SteerMessageInput> => {
      const steerAttachments: { mediaType: string; data: string }[] = [];
      for (const attachment of item.attachments) {
        if (attachment.type !== "image") continue;
        try {
          // Record the image in the session gallery.
          const file = await resolveAttachmentFile(attachment);
          const dims = await imageDimensionsFromFile(file);
          await uploadSessionImage({
            sessionId,
            file,
            width: dims.width,
            height: dims.height,
            projectId,
          });
        } catch {
          setComposerError("Could not upload queued image");
          throw new Error("Could not upload queued image");
        }
        const raw = attachment.data ?? "";
        const base64 = raw.startsWith("data:")
          ? (raw.split(",", 2)[1] ?? "")
          : raw;
        if (base64.length === 0) {
          setComposerError("Queued image is missing data");
          throw new Error("Queued image is missing data");
        }
        steerAttachments.push({
          mediaType: attachment.mediaType ?? "image/png",
          data: base64,
        });
      }
      for (const imageId of item.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          const dataUrl = await blobToDataUrl(blob);
          steerAttachments.push({
            mediaType,
            data: dataUrl.split(",", 2)[1] ?? "",
          });
        } catch {
          // skip images that fail to load
        }
      }
      return {
        clientMessageId: item.id,
        text: item.text,
        ...(steerAttachments.length > 0 ? { attachments: steerAttachments } : {}),
        ...(item.contextSnippet ? { contextSnippet: item.contextSnippet } : {}),
      };
    },
    [projectId, sessionId],
  );

  /** Send every pending item into the session's ACTIVE run via steer. */
  const handleQueueSendNow = useCallback(async () => {
    if (autoFlushBusyRef.current) return;
    const toSend = pendingBeforeEditing(queuedItemsRef.current);
    if (toSend.length === 0) return;
    queueActions.markInflight(new Set(toSend.map((item) => item.id)));
    try {
      const payloads: SteerMessageInput[] = [];
      for (const item of toSend) {
        payloads.push(await buildSteerPayload(item));
      }
      for (const chunk of chunkIds(payloads, 20)) {
        await steerChatMessages({ sessionId, messages: chunk });
      }
      setQueueHold(false);
    } catch (error) {
      queueActions.revertInflight();
      if (isSteerNoActiveRunError(error)) {
        // The run ended between render and post — the auto-flush effect
        // sends it as a new run once idle.
        setQueueHold(false);
      } else {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not send queued messages",
        );
      }
    }
  }, [buildSteerPayload, queueActions, sessionId]);

  /**
   * Shared send step for manual and queued sends: uploads local image
   * attachments, attaches pinned context, builds the bubble attachments and
   * metadata, and sends the message through the live chat controller.
   */
  const sendDraft = useCallback(
    async (input: {
      text: string;
      attachments: UIAttachment[];
      documentIds: string[];
      pinnedImageIds: string[];
      clientMessageId?: string;
    }): Promise<void> => {
      // Local images attach to the message like pinned context (uploaded
      // to the session image store + auto-pinned so the model sees them).
      const uploadedImageAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        data?: string;
        text?: string;
      }> = [];
      for (const attachment of input.attachments.filter((a) =>
        isImageAttachmentLike(a),
      )) {
        const file = await resolveAttachmentFile(attachment);
        if (file.size === 0) {
          throw new Error(`File is empty: ${file.name}`);
        }
        const dims = await imageDimensionsFromFile(file);
        const meta = await uploadSessionImage({
          sessionId,
          file,
          width: dims.width,
          height: dims.height,
          projectId,
        });
        // Auto-pin so the worker injects it as image input (vision)
        // or exposes it via view_image (text-only models).
        await addSessionImageContext({ sessionId, imageId: meta.id });
        const { blob, mediaType } = await fetchImageBytes(meta.id);
        uploadedImageAttachments.push({
          id: `ctx-${meta.id}`,
          type: "image",
          name: meta.prompt || "Uploaded image",
          mediaType,
          data: await blobToDataUrl(blob),
          text: meta.prompt || "Uploaded image",
        });
      }

      // Documents ingest after images — the old manual-submit order, so a
      // failed image upload never leaves freshly ingested docs orphaned.
      // Queued-path compatibility (Task 12): queued items carry image-only
      // attachments with their documentIds pre-uploaded at queue time, so
      // the non-image filter finds nothing here and the prelinked ids pass
      // through untouched.
      const documentIds = [
        ...input.documentIds,
        ...(await uploadComposerDocuments(input.attachments)),
      ];

      // Active image context: attach pinned images to the user bubble so
      // they are visible in the sent message (the worker injects them as
      // image input to the model).
      const contextAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        url?: string;
        data?: string;
        text?: string;
      }> = [];
      for (const imageId of input.pinnedImageIds) {
        try {
          const { blob, mediaType } = await fetchImageBytes(imageId);
          contextAttachments.push({
            id: `ctx-${imageId}`,
            type: "image",
            name: "Image context",
            mediaType,
            data: await blobToDataUrl(blob),
            text: "Image context",
          });
        } catch {
          // skip images that fail to load — the context still works
        }
      }

      const attachedDocuments = input.attachments.map((attachment) => {
        const name = attachment.name ?? "Document";
        return attachment.mediaType
          ? { name, mediaType: attachment.mediaType }
          : { name };
      });

      // Bubble stubs for document attachments only. Uploaded images are
      // attached via uploadedImageAttachments; a bare type:"file" stub with
      // an image mediaType would trip @anvia/core's image-attachment
      // conversion, which requires url/data.
      const documentBubbleAttachments = input.attachments
        .filter((attachment) => !isImageAttachmentLike(attachment))
        .map((attachment) => {
          const name = attachment.name ?? "Document";
          return {
            id: crypto.randomUUID(),
            type: (name === "Document"
              ? "document"
              : "file") as UIAttachment["type"],
            name,
            mediaType: attachment.mediaType,
            text: name,
          };
        });

      const contextSnippet = contextSnippetState.snippet;

      chatRequestFailedRef.current = false;
      const sendPromise = chatRef.current!.sendMessage({
        text: input.text,
        metadata: withChatMessageMeta(undefined, {
          documentIds,
          attachedDocuments,
          createdAt: new Date().toISOString(),
          clientMessageId: input.clientMessageId ?? createClientMessageId(),
          ...(contextSnippet
            ? {
                contextSnippet: {
                  text: contextSnippet.text,
                  sourceRole: contextSnippet.sourceRole,
                },
              }
            : {}),
        }),
        attachments: [
          ...documentBubbleAttachments,
          ...uploadedImageAttachments,
          ...contextAttachments,
        ],
      });

      // Text context is single-use: drop the composer chip the moment the
      // optimistic user bubble exists. Waiting for the stream made the
      // chip linger on the field after Send. The server still clears its
      // own row after the run reads it.
      if (contextSnippet) {
        contextSnippetState.reset();
      }
      await sendPromise;
      if (chatRequestFailedRef.current) {
        throw new Error("The chat request could not be completed.");
      }

      if (input.pinnedImageIds.length > 0) {
        await refreshActiveContext();
      }
      if (uploadedImageAttachments.length > 0) {
        // Locally uploaded images now live in the session image store —
        // refresh the rail so they appear alongside generated images.
        void refreshSessionImages();
      }
    },
    [
      addSessionImageContext,
      contextSnippetState,
      projectId,
      refreshActiveContext,
      refreshSessionImages,
      sessionId,
      uploadComposerDocuments,
    ],
  );

  /**
   * Auto-flush: when the chat is idle and items wait, send the next one as
   * a fresh run (queue-held items wait for "Send now" / hold release).
   */
  useEffect(() => {
    if (chat.status !== "ready") return;
    if (!initialMessages) return;
    if (queueHold || autoFlushBusyRef.current) return;
    if (nextFlushableItem(queuedItemsRef.current) === null) return;

    autoFlushBusyRef.current = true;
    void (async () => {
      try {
        // Purge items already applied server-side (missed acks across reloads).
        // Applied ids accumulate into ONE set so every chunk's dedupe is
        // applied at once — filtering per-chunk would read a stale snapshot.
        const ids = queuedItemsRef.current.map((item) => item.id);
        const applied = new Set<string>();
        for (const chunk of chunkIds(ids, 50)) {
          try {
            const { appliedIds } = await syncQueuedMessageIds({
              sessionId,
              ids: chunk,
            });
            for (const id of appliedIds) applied.add(id);
          } catch {
            // best-effort dedupe — a duplicate would only re-ask the agent
          }
        }
        let remaining = queuedItemsRef.current;
        if (applied.size > 0) {
          remaining = remaining.filter((item) => !applied.has(item.id));
          queueActions.replaceAll(remaining);
        }
        const candidate = nextFlushableItem(remaining);
        if (!candidate) return;

        const item = candidate.item;
        if (item.contextSnippet) {
          const ok = await contextSnippetState.setSnippet(
            item.contextSnippet.text,
            item.contextSnippet.sourceRole,
          );
          if (!ok) return;
        }
        for (const imageId of item.pinnedImageIds) {
          await addSessionImageContext({ sessionId, imageId }).catch(() => {});
        }

        autoFlushPreserveRef.current = true;
        try {
          await sendDraft({
            text: item.text,
            attachments: item.attachments,
            documentIds: item.documentIds,
            pinnedImageIds: item.pinnedImageIds,
            clientMessageId: item.id,
          });
        } finally {
          autoFlushPreserveRef.current = false;
        }
        queueActions.removeItem(item.id);
      } catch (error) {
        setComposerError(
          error instanceof Error ? error.message : "Auto-flush failed",
        );
        setQueueHold(true);
      } finally {
        autoFlushBusyRef.current = false;
      }
    })();
  }, [
    chat.status,
    contextSnippetState,
    initialMessages,
    queueActions,
    queueHold,
    queuedItems,
    sendDraft,
    sessionId,
  ]);

  const checkSessionFreshness = useCallback(async (): Promise<SessionFreshness> => {
    try {
      const state = await fetchSessionState(sessionId);
      const localCount = messagesRef.current.filter(
        (message) => message.role === "user" || message.role === "assistant",
      ).length;
      return sessionFreshnessFromCount(state.messageCount, localCount);
    } catch {
      return "unknown";
    }
  }, [sessionId]);

  /** Reload the conversation from server truth (used by the stale dialog). */
  const reloadChatFromServer = useCallback(async () => {
    const data = await loadChatMessages(sessionId);
    const fresh = finalizeInterruptedTools(parseMemoryMessages(data));
    onReloadMessages?.(fresh);
    chatRef.current?.setMessages(fresh);
  }, [sessionId, onReloadMessages]);

  /**
   * A resumed interaction is a separate v3 stream. Once it settles, replace
   * the optimistic suspended snapshot with authoritative native memory and
   * refresh persisted image metadata. This keeps tool output/state attached
   * to its original message without prompt/time-based reconciliation.
   */
  const requestSettledInteractionReconcile = useCallback(async () => {
    setInteractionReconcileVersion((version) => version + 1);
  }, []);

  const reconciledInteractionVersionRef = useRef(0);
  useEffect(() => {
    if (chat.status !== "ready") return;
    if (
      interactionReconcileVersion <= reconciledInteractionVersionRef.current
    ) {
      return;
    }
    const version = interactionReconcileVersion;
    reconciledInteractionVersionRef.current = version;
    void (async () => {
      try {
        await reloadChatFromServer();
        await refreshSessionImages();
      } catch {
        if (reconciledInteractionVersionRef.current === version) {
          setComposerError(
            "The completed interaction could not be synchronized. Reload the conversation.",
          );
        }
      }
    })();
  }, [
    chat.status,
    interactionReconcileVersion,
    refreshSessionImages,
    reloadChatFromServer,
  ]);

  const handleStaleReload = useCallback(() => {
    setStaleDialog(null);
    setEditingMessageId(null);
    setEditContextImages([]);
    void reloadChatFromServer().catch(() => {
      setComposerError("The conversation could not be reloaded.");
    });
  }, [reloadChatFromServer]);

  /**
   * Shared path for revert (same text) and edit (new text):
   * truncate memory to exclude the target user message, drop later UI messages,
   * then send a fresh user turn so the agent appends a single clean prompt.
   *
   * Reads chat through `chatRef` so the callback identity is stable (the
   * useChat result object is recreated every render) — memoized message rows
   * depend on the stability of onSubmitEdit/onRevert.
   */
  const [editContextImages, setEditContextImages] = useState<GeneratedImageItem[]>(
    [],
  );

  const resubmitFromUserMessage = useCallback(
    async (message: UIMessage, text: string) => {
      const currentChat = chatRef.current;
      if (!currentChat) {
        throw new Error("Chat is not ready");
      }
      if (
        currentChat.status === "submitted" ||
        currentChat.status === "streaming"
      ) {
        throw new Error("Wait for the current reply to finish");
      }

      const index = currentChat.messages.findIndex(
        (item) => item.id === message.id,
      );
      if (index === -1) {
        throw new Error("Message is no longer in this conversation");
      }

      const meta = readChatMessageMeta(message.metadata);
      if (!canTargetMessageForTruncate(meta)) {
        throw new Error("This message cannot be regenerated yet");
      }

      const trimmed = text.trim();
      if (!trimmed) {
        throw new Error("Message cannot be empty");
      }

      // Freshness guard: resubmitting from a stale or unverified view would
      // truncate newer messages added by another window/device.
      const freshness = await checkSessionFreshness();
      if (blocksDestructiveSessionAction(freshness)) {
        if (freshness === "unknown") {
          setComposerError(
            "Could not verify this conversation is current. Reload and try again.",
          );
          return;
        }
        setStaleDialog({ kind: "resubmit" });
        return;
      }

      await truncateSessionMemory({
        sessionId,
        mode: "exclude",
        memoryPosition: meta.memoryPosition,
        clientMessageId: meta.clientMessageId,
        expectedPrefixMessageCount: currentChat.messages
          .slice(0, index)
          .filter(
            (item) => item.role === "user" || item.role === "assistant",
          ).length,
      });

      // The dropped run's tool parts leave chat.messages, so live image
      // collection shrinks — resync history to server truth (fire-and-forget).
      void refreshSessionImages();

      currentChat.setMessages(currentChat.messages.slice(0, index));
      setEditingMessageId(null);

      // Attach the context images managed in the edit bubble (view/add/remove)
      // to the resubmitted message, like the normal send flow does.
      const editAttachments: Array<{
        id: string;
        type: "image";
        name: string;
        mediaType: string;
        data?: string;
        text?: string;
      }> = [];
      for (const image of editContextImages) {
        try {
          const { blob, mediaType } = await fetchImageBytes(image.id);
          editAttachments.push({
            id: `ctx-${image.id}`,
            type: "image",
            name: image.prompt || "Image context",
            mediaType,
            data: await blobToDataUrl(blob),
            text: image.prompt || "Image context",
          });
        } catch {
          // skip images that fail to load
        }
      }
      setEditContextImages([]);

      await currentChat.sendMessage({
        text: trimmed,
        metadata: withChatMessageMeta(undefined, {
          documentIds: meta.documentIds ?? [],
          createdAt: new Date().toISOString(),
          clientMessageId: createClientMessageId(),
        }),
        attachments: editAttachments,
      });
    },
    [sessionId, refreshSessionImages, editContextImages, checkSessionFreshness],
  );

  const handleRevert = useCallback(
    async (message: UIMessage) => {
      await resubmitFromUserMessage(message, getMessageRawText(message));
    },
    [resubmitFromUserMessage],
  );

  const handleSubmitEdit = useCallback(
    async (message: UIMessage, text: string) => {
      await resubmitFromUserMessage(message, text);
    },
    [resubmitFromUserMessage],
  );

  // Stable callbacks so memoized ChatMessageRow rows skip re-renders on
  // unrelated state changes (e.g. model switches).
  const generationInfoMap = useMemo(
    () => computeGenerationActionInfo(chat.messages),
    [chat.messages],
  );
  const citedDocuments = useMemo(
    () => collectCitedDocuments(chat.messages),
    [chat.messages],
  );

  const webSources = useMemo(
    () => collectWebSources(chat.messages),
    [chat.messages],
  );

  const liveGeneratedImages = useMemo(
    () => collectGeneratedImagesFromMessages(chat.messages),
    [chat.messages],
  );

  const runningImageParts = useMemo(
    () => countRunningImageToolPartsFromMessages(chat.messages),
    [chat.messages],
  );

  const generatedImages = useMemo(
    () => mergeGeneratedImages(liveGeneratedImages, sessionImages),
    [liveGeneratedImages, sessionImages],
  );

  /**
   * Resolve the context images attached to a user message so the edit bubble
   * can show / manage them. Live messages carry the id as `ctx-<imageId>`;
   * rebuilt-from-memory messages lose it, so fall back to matching the raw
   * base64 payload against the session's generated images.
   */
  const resolveEditContextImages = useCallback(
    async (message: UIMessage): Promise<GeneratedImageItem[]> => {
      const parts = message.parts.filter(
        (part): part is Extract<UIMessagePart, { type: "attachment" }> =>
          part.type === "attachment" && part.attachment?.type === "image",
      );
      if (parts.length === 0) return [];
      const byId = new Map(generatedImages.map((image) => [image.id, image]));
      const found: GeneratedImageItem[] = [];
      const dataParts: Array<
        Extract<UIMessagePart, { type: "attachment" }>
      > = [];
      for (const part of parts) {
        const idMatch = part.attachment.id?.match(/^ctx-(.+)$/);
        const item = idMatch ? (byId.get(idMatch[1]) ?? null) : null;
        if (item) {
          if (!found.some((existing) => existing.id === item.id)) found.push(item);
        } else {
          dataParts.push(part);
        }
      }
      if (dataParts.length > 0) {
        const candidates = generatedImages.filter(
          (image) => !found.some((existing) => existing.id === image.id),
        );
        for (const part of dataParts) {
          const target = part.attachment.data ?? "";
          if (!target) continue;
          for (const candidate of candidates) {
            try {
              const { blob } = await fetchImageBytes(candidate.id);
              const dataUrl = await blobToDataUrl(blob);
              if (dataUrl.slice(dataUrl.indexOf(",") + 1) === target) {
                found.push(candidate);
                break;
              }
            } catch {
              // skip images that fail to load
            }
          }
        }
      }
      return found;
    },
    [generatedImages],
  );


  const handleStartEdit = useCallback(
    (message: UIMessage) => {
      if (chat.status === "submitted" || chat.status === "streaming") return;
      setEditingMessageId(message.id);
      setEditContextImages([]);
      void resolveEditContextImages(message).then(setEditContextImages);
    },
    [chat.status, resolveEditContextImages],
  );
  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditContextImages([]);
  }, []);

  const editAvailableImages = useMemo(
    () =>
      generatedImages.filter(
        (image) =>
          !editContextImages.some((item) => item.id === image.id),
      ),
    [generatedImages, editContextImages],
  );
  const handleEditContextAdd = useCallback((image: GeneratedImageItem) => {
    setEditContextImages((current) =>
      current.some((item) => item.id === image.id)
        ? current
        : [...current, image],
    );
  }, []);
  const handleEditContextRemove = useCallback((image: GeneratedImageItem) => {
    setEditContextImages((current) =>
      current.filter((item) => item.id !== image.id),
    );
  }, []);


  // Keep the latest send body in a ref (avoids stale closures for the stale
  // dialog's "Send anyway"); the submit handler wraps it with the freshness
  // check.
  submitComposerRef.current = async (
    input,
    attachments,
    chatController,
    clear,
  ) => {
    setComposerError(null);
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;

    // Queue conflict gate — bypassed for the modal's own "send new" action
    // via submitBypassRef. Reached only while idle with a non-empty queue
    // (auto-flush drains it unless held), so the queue is paused: ask the
    // user whether this draft joins the queue or sends immediately.
    if (
      !submitBypassRef.current &&
      chatRef.current?.status !== "submitted" &&
      chatRef.current?.status !== "streaming" &&
      queuedItemsRef.current.length > 0
    ) {
      pendingManualSubmitRef.current = {
        input,
        attachments,
        chatController,
        clear,
      };
      setQueueConflictOpen(true);
      return;
    }

    // Truncate-before-send: a persisted failed tail [user, assistant
    // kind:"error"] would re-enter memory — drop it first. This delete is
    // destructive, so freshness must be proven and truncate must commit
    // before the retry prompt is sent.
    const messages = chatController.messages;
    const failedTail = failedTailTruncate(messages);
    if (failedTail) {
      const freshness = await checkSessionFreshness();
      if (blocksDestructiveSessionAction(freshness)) {
        if (freshness === "unknown") {
          setComposerError(
            "Could not verify this conversation is current. Reload and try again.",
          );
          return;
        }
        setStaleDialog({ kind: "resubmit" });
        return;
      }
      try {
        await truncateSessionMemory({
          sessionId,
          mode: "exclude",
          clientMessageId: failedTail.clientMessageId,
          expectedPrefixMessageCount: failedTail.expectedPrefixMessageCount,
        });
      } catch (error) {
        setComposerError(
          error instanceof Error
            ? error.message
            : "Could not clear the failed message",
        );
        return;
      }
      chatController.setMessages(messages.slice(0, -2));
      void refreshSessionImages();
    }

    const stalePromise = checkSessionFreshness();

    // Upload steps set composerError themselves before throwing; the catch
    // keeps the submit promise from rejecting (the composer awaits it).
    try {
      await sendDraft({
        text: trimmed,
        attachments,
        documentIds: [],
        pinnedImageIds: activeContextImages.map((image) => image.id),
      });
    } catch (error) {
      if (error instanceof Error) {
        setComposerError(error.message);
      }
      return;
    }

    clear();

    // Active image context is single-use: it was consumed by this message,
    // so clear the pins (the server also clears after the run reads them).
    if (activeContextImages.length > 0) {
      setActiveContextImages([]);
    }
    setIngestionItems([]);

    // Non-blocking freshness notice: the message was already sent (normal
    // sends are non-destructive); offer a reload so the view catches up
    // with the other window/device.
    if ((await stalePromise) === "stale") {
      setStaleDialog({ kind: "send" });
    }
  };

  /** Dialog "Send queue": the pending draft joins the queue; hold releases. */
  const handleQueueConflictSendQueue = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    await queueComposerDraft({
      input: pending.input,
      attachments: pending.attachments,
    });
    setQueueHold(false);
  }, [queueComposerDraft]);

  /** Dialog "Send new message": bypass the conflict gate and send now. */
  const handleQueueConflictSendNew = useCallback(async () => {
    setQueueConflictOpen(false);
    const pending = pendingManualSubmitRef.current;
    pendingManualSubmitRef.current = null;
    if (!pending) return;
    submitBypassRef.current = true;
    try {
      await submitComposerRef.current(
        pending.input,
        pending.attachments,
        pending.chatController,
        pending.clear,
      );
    } finally {
      submitBypassRef.current = false;
    }
  }, []);

  return (
    <ChatProvider<ChatClientMetadata, ChatDataMap> controller={chat}>
      <CitationSessionProvider sessionDocuments={sessionDocuments}>
      {/*
        ComposerPrimitive.Root wraps chat + right doc rail so attachments share context.
        When docs exist, rail opens (272px = left sidebar) and pushes chat left.
      */}
      <ComposerPrimitive.Root
        className="flex min-h-0 w-full flex-1 flex-col overflow-hidden"
        submitMessage={async ({
          input,
          attachments,
          clear,
        }) => {
          if (modelsStatus !== "success") return;
          const editing = queuedItemsRef.current.find(
            (item) => item.status === "editing",
          );
          if (
            chatRef.current?.status === "submitted" ||
            chatRef.current?.status === "streaming"
          ) {
            await handleActiveComposerSubmit(input, attachments);
            return;
          }
          // Idle + editing: the composer holds the recalled draft — commit it
          // back into the queue item (a held queue would otherwise trap the
          // submit behind the conflict gate).
          if (editing) {
            await handleSubmitQueueEdit(input, attachments);
            return;
          }
          const currentChat = chatRef.current;
          if (!currentChat) return;
          await submitComposerRef.current(input, attachments, currentChat, clear);
        }}
      >
        <div
          className="flex min-h-0 w-full flex-1 items-stretch overflow-hidden"
          style={
            {
              ["--composer-dock-h" as string]: `${composerDockH}px`,
              // Gap above textfield (last bubble → field); top chrome stays 24px
              ["--chat-composer-gap" as string]: "40px",
            } as CSSProperties
          }
        >
          {/* Center chat column — shrinks when right rail opens */}
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <ThreadPrimitive.Root className="absolute inset-0 overflow-hidden">
              {/*
                Full-bleed scroll: content passes under top bar + textfield.
                Native scrollbar hidden; InsetScrollbar insets from top bar
                and above the textfield (see --chat-composer-gap).
              */}
              <ThreadPrimitive.Viewport
                ref={chatViewportRef}
                className="chat-scroll-bleed absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
                autoScroll
              >
                <div
                  className="mx-auto flex min-h-full w-full min-w-0 max-w-[760px] flex-col px-3"
                  style={{
                    paddingTop: "calc(3.5rem + 24px)",
                    paddingBottom:
                      "calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))",
                  }}
                >
                  <ThreadPrimitive.Empty className="flex min-h-0 flex-1 flex-col">
                    <EmptyState onSelectPrompt={handleStarterPrompt} />
                  </ThreadPrimitive.Empty>

                  <ThreadPrimitive.Suggestions className="mb-4 flex w-full flex-wrap gap-2" />

                  {/*
                    Same-thread vs cross-message spacing:
                    - activity chain (tool↔reasoning, any message split): tight mt-1
                    - only jump to a message that *starts with answer text*: mt-4
                    - around user turns: mt-4
                  */}
                  <ThreadPrimitive.Messages
                    className={[
                      "flex w-full min-w-0 flex-col",
                      "[&>*]:min-w-0",
                      "[&>*+*]:mt-1",
                      "[&>[data-activity-only]+[data-role=assistant]:not([data-starts-activity])]:mt-4",
                      "[&>[data-role=tool]+[data-role=assistant]:not([data-starts-activity])]:mt-4",
                      "[&>[data-role=user]+*]:mt-4",
                      "[&>*+[data-role=user]]:mt-4",
                    ].join(" ")}
                  >
                    {(message) => (
                      <ChatMessageRow
                        message={message}
                        chatStatus={chat.status}
                        lastMessageId={chat.messages.at(-1)?.id}
                        editingMessageId={editingMessageId}
                        onStartEdit={handleStartEdit}
                        onCancelEdit={handleCancelEdit}
                        onSubmitEdit={handleSubmitEdit}
                        onRevert={handleRevert}
                        generationInfo={generationInfoMap.get(message.id)}
                        editContextImages={editContextImages}
                        editAvailableImages={editAvailableImages}
                        onEditContextAdd={handleEditContextAdd}
                        onEditContextRemove={handleEditContextRemove}
                        onAddContext={handleAddContext}
                      />
                    )}
                  </ThreadPrimitive.Messages>

                  <ThreadPrimitive.Loading className="mt-4 w-full text-sm text-text-muted">
                    <AnimatedStatusText
                      label={
                        chat.status === "streaming"
                          ? "Thinking and writing"
                          : "Writing"
                      }
                    />
                  </ThreadPrimitive.Loading>

                  <ThreadPrimitive.Error className="mt-4 w-full rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger" />
                </div>
              </ThreadPrimitive.Viewport>

              <InsetScrollbar
                scrollRef={chatViewportRef}
                top="calc(3.5rem + 24px)"
                bottom="calc(var(--composer-dock-h, 7.5rem) + var(--chat-composer-gap, 40px))"
              />

              {/* Below the composer dock so Add as context cannot cover the field. */}
              <div
                id="chat-surface"
                className="pointer-events-none absolute inset-0 z-10"
              />

              {/* Overlay dock — content scrolls underneath */}
              <div
                ref={composerDockRef}
                className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-3"
              >
                <div className="pointer-events-auto relative mx-auto w-full max-w-[760px] px-3">
                  <ThreadPrimitive.ViewportFooter className="pointer-events-none absolute inset-x-3 bottom-full mb-2 flex justify-center">
                    <ThreadPrimitive.ScrollToBottom className="pointer-events-auto glass glass-interactive inline-flex min-h-10 cursor-pointer items-center rounded-full px-4 text-sm font-medium text-text-muted transition hover:text-text active:scale-[0.98] data-[state=bottom]:invisible">
                      Latest
                    </ThreadPrimitive.ScrollToBottom>
                  </ThreadPrimitive.ViewportFooter>

                  {previousRunError ? (
                    <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger animate-fade-in">
                      <span className="min-w-0">
                        The previous run failed — review the conversation and
                        send again.
                      </span>
                      <button
                        type="button"
                        aria-label="Dismiss failed run notice"
                        onClick={() => setPreviousRunError(false)}
                        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-danger/70 transition hover:bg-white/[0.06] hover:text-danger active:scale-[0.96]"
                      >
                        <X className="size-3.5" strokeWidth={2} />
                      </button>
                    </div>
                  ) : null}

                  <ApprovalPanel
                    onInteractionSettled={requestSettledInteractionReconcile}
                  />

                  <ClarificationPanel
                    onInteractionSettled={requestSettledInteractionReconcile}
                  />

                  <StaleSessionDialog
                    open={staleDialog !== null}
                    kind={staleDialog?.kind ?? "send"}
                    onReload={handleStaleReload}
                  />

                  <QueueConflictDialog
                    open={queueConflictOpen}
                    onClose={() => {
                      pendingManualSubmitRef.current = null;
                      setQueueConflictOpen(false);
                    }}
                    onSendQueue={() => void handleQueueConflictSendQueue()}
                    onSendNew={() =>
                      void handleQueueConflictSendNew().catch(() => {})
                    }
                  />

                  {deepResearch.phase !== "idle" ? (
                    <div className="mb-2">
                      <DeepResearchActivityPanel state={deepResearch} />
                    </div>
                  ) : null}

                  <ChatComposer
                    sessionId={sessionId}
                    projectId={projectId}
                    activeDocumentIds={sessionDocumentIds}
                    chatStatus={chat.status}
                    isIngesting={isIngesting}
                    composerError={composerError}
                    attachmentErrors={attachmentErrors}
                    composerInputRef={composerInputRef}
                    model={selectedModel}
                    reasoningEffort={selectedReasoningEffort}
                    onModelChange={handleModelChange}
                    onReasoningChange={handleReasoningChange}
                    onStopRun={handleStopRun}
                    onQueueSubmit={handleActiveComposerSubmit}
                    onLinkedDocuments={handleLinkedDocuments}
                    onAttachmentRejected={handleAttachmentRejected}
                    onDismissAttachmentError={handleDismissAttachmentError}
                    models={models}
                    reasoningEfforts={reasoningEfforts}
                    modelsStatus={modelsStatus}
                    modelsError={modelsError}
                    onRetryModels={modelsRetry}
                    contextUsage={contextUsage}
                    deepResearchEnabled={deepResearchEnabled}
                    deepResearchAvailable={
                      capabilities?.deepResearchAvailable ?? false
                    }
                    onDeepResearchToggle={setDeepResearchEnabled}
                    webSearchEnabled={webSearchEnabled}
                    webSearchAvailable={capabilities?.webSearchAvailable ?? false}
                    onWebSearchToggle={setWebSearchEnabled}
                    imageGenerationEnabled={imageGenerationEnabled}
                    imageGenerationAvailable={
                      capabilities?.imageGenerationAvailable ?? false
                    }
                    onImageGenerationToggle={handleImageGenerationToggle}
                    imageGenSettings={imageGenSettings}
                    onImageGenSettingsChange={handleImageGenSettingsChange}
                    activeContextImages={activeContextImages}
                    onToggleImageContext={(image) => {
                      void handleToggleImageContext(image);
                    }}
                    contextSnippet={contextSnippetState.snippet}
                    contextSnippetError={contextSnippetState.error}
                    onRemoveContextSnippet={() => {
                      void contextSnippetState.remove();
                    }}
                    queuedItems={queuedItems}
                    onQueueSendNow={handleQueueSendNow}
                    onQueueRemove={queueActions.removeItem}
                    onQueueReorder={queueActions.reorder}
                    onQueueRecall={handleQueueRecall}
                    onQueueCancelEdit={handleQueueCancelEdit}
                    editHydration={editHydration}
                    clearComposerSignal={clearComposerSignal}
                    suppressOptimisticClear={autoFlushPreserveRef}
                  />
                </div>
              </div>
            </ThreadPrimitive.Root>
          </div>

          {/* Right doc rail — same 272px + full height as left sidebar */}
          <SessionDocumentsRail
            sessionDocuments={sessionDocuments}
            citedDocuments={citedDocuments}
            webSources={webSources}
            generatedImages={generatedImages}
            runningImageCount={runningImageParts}
            activeContextImages={activeContextImages}
            ingestionItems={ingestionItems}
            onRemoveActiveDocument={handleRemoveActiveDocument}
            removingDocumentId={removingDocumentId}
            onToggleImageContext={(image) => {
              void handleToggleImageContext(image);
            }}
          />
        </div>
      </ComposerPrimitive.Root>
      </CitationSessionProvider>
    </ChatProvider>
  );
}
