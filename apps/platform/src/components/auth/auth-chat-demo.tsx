import { AnimatedStatusText } from "#/components/chat/animated-status-text";
import { ReasoningEffortIcon } from "#/components/composer/model-reasoning-switcher";
import type { LucideIcon } from "lucide-react";
import {
  ArrowUp,
  ChevronDown,
  Cpu,
  FileText,
  FolderKanban,
  Globe,
  ImagePlus,
  Loader2,
  MessagesSquare,
  Paperclip,
  Plus,
  Quote,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * Decorative chat-room preview for the auth rail.
 * Mirrors production chrome: user glass bubble, reasoning + tool activity
 * rows, streaming answer, glass composer with features / model / reasoning /
 * attach / send-stop — without live chat APIs.
 */

type ToolStep = {
  label: string;
  requestTitle?: string;
  requestSummary?: string;
  resultTitle?: string;
  resultSummary?: string;
  /** Show image-gen skeleton while working, then a real demo visual when done */
  imageKind?: "heatmap" | "cover";
};

type FocusChip = {
  id: string;
  label: string;
  icon: LucideIcon;
};

type Scene = {
  userPrompt: string;
  thinkingLabel: string;
  reasoningSummary: string;
  tools: ToolStep[];
  reply: string;
  features: { web: boolean; image: boolean };
  modelName: string;
  reasoningEffort: string | null;
  reasoningEfforts: string[];
  /** Strip between brand header and thread — tied to this scene */
  focusTitle: string;
  focusChips: FocusChip[];
};

type ThreadItem =
  | { id: string; kind: "user"; text: string }
  | {
      id: string;
      kind: "reasoning";
      live: boolean;
      summary: string;
      open: boolean;
    }
  | {
      id: string;
      kind: "tool";
      label: string;
      state: "working" | "done";
      open: boolean;
      step: ToolStep;
    }
  | {
      id: string;
      kind: "image";
      variant: "heatmap" | "cover";
      caption: string;
    }
  | { id: string; kind: "assistant"; text: string; streaming: boolean };

type Phase =
  | "typing"
  | "sending"
  | "thinking"
  | "reasoning"
  | "tool"
  | "streaming"
  | "hold-scene"
  | "hold-loop";

const LOGIN_SCENES: Scene[] = [
  {
    userPrompt: "Where is the revenue risk in the board pack?",
    thinkingLabel: "Thinking and writing",
    reasoningSummary:
      "Locate renewal risk sections and cross-check pipeline coverage against target.",
    tools: [
      {
        label: "Searching document pages",
        requestTitle: "Request",
        requestSummary: "Board_Pack_Q3.pdf · “revenue risk” · “renewals”",
        resultTitle: "Result",
        resultSummary: "3 pages · pp. 12–14 · Board_Pack_Q3.pdf",
      },
    ],
    reply:
      "Risk concentrates in enterprise renewals (pp. 12–14): two accounts delayed, pipeline coverage at 0.9× target.",
    features: { web: false, image: false },
    modelName: "GPT-5.2",
    reasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Grounded document Q&A",
    focusChips: [
      { id: "docs", label: "Documents", icon: FileText },
      { id: "cite", label: "Citations", icon: Quote },
      { id: "chat", label: "Chat", icon: MessagesSquare },
    ],
  },
  {
    userPrompt: "Any public news on those delayed accounts?",
    thinkingLabel: "Thinking and writing",
    reasoningSummary:
      "Search recent web coverage, then summarize only what is attributable.",
    tools: [
      {
        label: "Searching the web",
        requestTitle: "Request",
        requestSummary: "delayed enterprise renewals · last 30 days",
        resultTitle: "Result",
        resultSummary: "4 sources · filtered for company names in the pack",
      },
      {
        label: "Fetching web page",
        requestTitle: "Request",
        requestSummary: "reuters.com · renewal outlook brief",
        resultTitle: "Result",
        resultSummary: "Fetched · 1 relevant paragraph on cycle delays",
      },
    ],
    reply:
      "One trade brief notes longer enterprise cycles this quarter — nothing company-specific beyond what is already in your pack.",
    features: { web: true, image: false },
    modelName: "GPT-5.2",
    reasoningEffort: "high",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Optional web tools in the same thread",
    focusChips: [
      { id: "web", label: "Web search", icon: Globe },
      { id: "docs", label: "Your files", icon: FileText },
      { id: "chat", label: "One thread", icon: MessagesSquare },
    ],
  },
  {
    userPrompt: "Generate a simple risk heatmap for the exec review.",
    thinkingLabel: "Thinking and writing",
    reasoningSummary:
      "Map renewals vs coverage into a clean heatmap suitable for slides.",
    tools: [
      {
        label: "Generating image",
        requestTitle: "Request",
        requestSummary: "Risk heatmap · dark UI · exec slide",
        resultTitle: "Result",
        imageKind: "heatmap",
        resultSummary: "1 image · 1024×1024",
      },
    ],
    reply:
      "Heatmap is ready below — pin it to context from the images rail when you want follow-up edits.",
    features: { web: false, image: true },
    modelName: "GPT-5.2",
    reasoningEffort: "low",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Image generation in chat",
    focusChips: [
      { id: "img", label: "Image gen", icon: ImagePlus },
      { id: "proj", label: "Projects", icon: FolderKanban },
      { id: "chat", label: "Composer", icon: MessagesSquare },
    ],
  },
];

const REGISTER_SCENES: Scene[] = [
  {
    userPrompt: "What can I do with a PDF here?",
    thinkingLabel: "Thinking and writing",
    reasoningSummary:
      "Explain grounded chat, citations, and private account scope for a first-time user.",
    tools: [
      {
        label: "Finding documents",
        requestTitle: "Request",
        requestSummary: "session library · ready documents",
        resultTitle: "Result",
        resultSummary: "Empty library — upload to get started",
      },
    ],
    reply:
      "Upload a PDF, then ask in plain language. Answers stay grounded in your file, with citations you can open.",
    features: { web: false, image: false },
    modelName: "GPT-5.2",
    reasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Start with your documents",
    focusChips: [
      { id: "docs", label: "Upload PDF", icon: FileText },
      { id: "cite", label: "Citations", icon: Quote },
      { id: "chat", label: "Ask anything", icon: MessagesSquare },
    ],
  },
  {
    userPrompt: "Can it search the web if I need fresher context?",
    thinkingLabel: "Thinking and writing",
    reasoningSummary: "Describe optional web tools and when they appear in chat.",
    tools: [
      {
        label: "Searching the web",
        requestTitle: "Request",
        requestSummary: "demo query · capability check",
        resultTitle: "Result",
        resultSummary: "Web tools available when enabled in the composer",
      },
    ],
    reply:
      "Yes — turn on web search from the + menu. Fetches stay visible as tool steps in the same thread.",
    features: { web: true, image: false },
    modelName: "GPT-5.2",
    reasoningEffort: "medium",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Web search when you need it",
    focusChips: [
      { id: "web", label: "Web search", icon: Globe },
      { id: "tools", label: "Tool steps", icon: MessagesSquare },
      { id: "docs", label: "Still private", icon: FileText },
    ],
  },
  {
    userPrompt: "Also generate a cover image for my project brief.",
    thinkingLabel: "Thinking and writing",
    reasoningSummary: "Run image generation and point to the session images rail.",
    tools: [
      {
        label: "Generating image",
        requestTitle: "Request",
        requestSummary: "Cover · minimal · document product",
        resultTitle: "Result",
        imageKind: "cover",
        resultSummary: "1 image · ready to pin as context",
      },
    ],
    reply:
      "Image generation lives in the same composer. Results land inline and in Images — pin any of them into the next message.",
    features: { web: false, image: true },
    modelName: "GPT-5.2",
    reasoningEffort: "low",
    reasoningEfforts: ["low", "medium", "high"],
    focusTitle: "Images without leaving chat",
    focusChips: [
      { id: "img", label: "Image gen", icon: ImagePlus },
      { id: "proj", label: "Projects", icon: FolderKanban },
      { id: "chat", label: "One flow", icon: MessagesSquare },
    ],
  },
];

const LOGIN_SEED: ThreadItem[] = [
  {
    id: "seed-u",
    kind: "user",
    text: "Summarize the open risks from last week’s notes.",
  },
  {
    id: "seed-a",
    kind: "assistant",
    text: "Three open risks: delayed renewals, coverage gap vs plan, and one vendor dependency on the critical path.",
    streaming: false,
  },
];

const REGISTER_SEED: ThreadItem[] = [
  {
    id: "seed-u",
    kind: "user",
    text: "Is this workspace private to my account?",
  },
  {
    id: "seed-a",
    kind: "assistant",
    text: "Yes. Chats, uploads, and projects stay scoped to your account — nothing is shared across users.",
    streaming: false,
  },
];

/** Public entry — remounts each cycle for a clean loop. */
export function AuthChatDemo({ isRegister }: { isRegister: boolean }) {
  const [cycle, setCycle] = useState(0);
  return (
    <AuthChatDemoCycle
      key={`${isRegister ? "register" : "login"}-${cycle}`}
      isRegister={isRegister}
      onCycleComplete={() => setCycle((c) => c + 1)}
    />
  );
}

function AuthChatDemoCycle({
  isRegister,
  onCycleComplete,
}: {
  isRegister: boolean;
  onCycleComplete: () => void;
}) {
  const scenes = isRegister ? REGISTER_SCENES : LOGIN_SCENES;
  const seed = isRegister ? REGISTER_SEED : LOGIN_SEED;
  const reducedMotion = usePrefersReducedMotion();

  const [sceneIndex, setSceneIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("typing");
  const [draft, setDraft] = useState("");
  const [thread, setThread] = useState<ThreadItem[]>(() => seed);
  const [features, setFeatures] = useState(scenes[0]!.features);
  const [modelName, setModelName] = useState(scenes[0]!.modelName);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(
    scenes[0]!.reasoningEffort,
  );
  const [reasoningEfforts, setReasoningEfforts] = useState(
    scenes[0]!.reasoningEfforts,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const onCompleteRef = useRef(onCycleComplete);
  onCompleteRef.current = onCycleComplete;
  const scene = scenes[sceneIndex] ?? scenes[0]!;

  useEffect(() => {
    let cancelled = false;
    const timers: number[] = [];
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = window.setTimeout(() => {
          if (!cancelled) resolve();
        }, ms);
        timers.push(id);
      });

    const run = async () => {
      if (reducedMotion) {
        const last = scenes[scenes.length - 1]!;
        setPhase("hold-loop");
        setDraft("");
        setFeatures(last.features);
        setModelName(last.modelName);
        setReasoningEffort(last.reasoningEffort);
        setReasoningEfforts(last.reasoningEfforts);
        setThread([
          ...seed,
          ...scenes.flatMap((s, si) => {
            const items: ThreadItem[] = [
              { id: `u-${si}`, kind: "user", text: s.userPrompt },
            ];
            for (const [ti, tool] of s.tools.entries()) {
              items.push({
                id: `t-${si}-${ti}`,
                kind: "tool",
                label: tool.label,
                state: "done",
                open: false,
                step: tool,
              });
              if (tool.imageKind) {
                items.push({
                  id: `img-${si}-${ti}`,
                  kind: "image",
                  variant: tool.imageKind,
                  caption:
                    tool.imageKind === "heatmap"
                      ? "Risk heatmap · exec review"
                      : "Cover · project brief",
                });
              }
            }
            items.push({
              id: `a-${si}`,
              kind: "assistant",
              text: s.reply,
              streaming: false,
            });
            return items;
          }),
        ]);
        return;
      }

      setThread(seed);
      setDraft("");

      for (let si = 0; si < scenes.length; si += 1) {
        if (cancelled) return;
        const current = scenes[si]!;
        setSceneIndex(si);
        setFeatures(current.features);
        setModelName(current.modelName);
        setReasoningEffort(current.reasoningEffort);
        setReasoningEfforts(current.reasoningEfforts);

        setPhase("typing");
        setDraft("");
        for (let i = 1; i <= current.userPrompt.length; i += 1) {
          if (cancelled) return;
          setDraft(current.userPrompt.slice(0, i));
          await wait(i === 1 ? 360 : 26 + (i % 6 === 0 ? 14 : 0));
        }
        await wait(320);
        if (cancelled) return;

        setPhase("sending");
        setDraft("");
        setThread((prev) => [
          ...prev,
          {
            id: `u-${si}-${Date.now()}`,
            kind: "user",
            text: current.userPrompt,
          },
        ]);
        await wait(280);
        if (cancelled) return;

        // Thread.Loading only (not also a thread row) — matches real chat.
        setPhase("thinking");
        await wait(900);
        if (cancelled) return;

        setPhase("reasoning");
        const reasoningId = `reason-${si}`;
        setThread((prev) => [
          ...prev,
          {
            id: reasoningId,
            kind: "reasoning",
            live: true,
            summary: "",
            open: true,
          },
        ]);

        for (let i = 1; i <= current.reasoningSummary.length; i += 1) {
          if (cancelled) return;
          const slice = current.reasoningSummary.slice(0, i);
          setThread((prev) =>
            prev.map((item) =>
              item.id === reasoningId && item.kind === "reasoning"
                ? { ...item, summary: slice }
                : item,
            ),
          );
          await wait(10);
        }
        await wait(420);
        if (cancelled) return;
        setThread((prev) =>
          prev.map((item) =>
            item.id === reasoningId && item.kind === "reasoning"
              ? { ...item, live: false, open: false }
              : item,
          ),
        );
        await wait(220);
        if (cancelled) return;

        setPhase("tool");
        for (const [ti, tool] of current.tools.entries()) {
          if (cancelled) return;
          const toolId = `tool-${si}-${ti}`;
          setThread((prev) => [
            ...prev,
            {
              id: toolId,
              kind: "tool",
              label: tool.label,
              state: "working",
              open: true,
              step: tool,
            },
          ]);
          await wait(tool.imageKind ? 1600 : 1100);
          if (cancelled) return;
          // Keep tool open when an image result is about to appear.
          setThread((prev) =>
            prev.map((item) =>
              item.id === toolId && item.kind === "tool"
                ? {
                    ...item,
                    state: "done",
                    open: Boolean(tool.imageKind),
                  }
                : item,
            ),
          );
          if (tool.imageKind) {
            await wait(280);
            if (cancelled) return;
            setThread((prev) => [
              ...prev,
              {
                id: `img-${si}-${ti}`,
                kind: "image",
                variant: tool.imageKind!,
                caption:
                  tool.imageKind === "heatmap"
                    ? "Risk heatmap · exec review"
                    : "Cover · project brief",
              },
            ]);
            // Collapse tool chrome after the image is on screen.
            await wait(500);
            if (cancelled) return;
            setThread((prev) =>
              prev.map((item) =>
                item.id === toolId && item.kind === "tool"
                  ? { ...item, open: false }
                  : item,
              ),
            );
          }
          await wait(360);
        }
        if (cancelled) return;

        setPhase("streaming");
        const assistantId = `a-${si}-${Date.now()}`;
        setThread((prev) => [
          ...prev,
          {
            id: assistantId,
            kind: "assistant",
            text: "",
            streaming: true,
          },
        ]);
        for (let i = 1; i <= current.reply.length; i += 1) {
          if (cancelled) return;
          const slice = current.reply.slice(0, i);
          setThread((prev) =>
            prev.map((item) =>
              item.id === assistantId && item.kind === "assistant"
                ? { ...item, text: slice, streaming: true }
                : item,
            ),
          );
          await wait(current.reply[i - 1] === " " ? 11 : 15);
        }
        setThread((prev) =>
          prev.map((item) =>
            item.id === assistantId && item.kind === "assistant"
              ? { ...item, streaming: false }
              : item,
          ),
        );

        setPhase("hold-scene");
        await wait(si === scenes.length - 1 ? 2800 : 1400);
      }

      if (cancelled) return;
      setPhase("hold-loop");
      await wait(2000);
      if (cancelled) return;
      onCompleteRef.current();
    };

    void run();

    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
    };
  }, [isRegister, reducedMotion, scenes, seed]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [thread, draft, phase]);

  const streaming =
    phase === "thinking" ||
    phase === "reasoning" ||
    phase === "tool" ||
    phase === "streaming" ||
    phase === "sending";

  return (
    <div className="relative flex h-full min-h-0 flex-col" aria-hidden>
      {/* Between brand header and thread — scene-aware feature focus */}
      <DemoFocusStrip
        title={scene.focusTitle}
        chips={scene.focusChips}
        sceneKey={`${isRegister ? "r" : "l"}-${sceneIndex}`}
      />

      <div
        ref={scrollRef}
        className="chat-scroll-bleed min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex min-h-full w-full min-w-0 max-w-[760px] flex-col px-3 pb-[calc(9.5rem+40px)] pt-2">
          <div
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
            {thread.map((item) => (
              <DemoThreadItem key={item.id} item={item} />
            ))}
          </div>

          {/* Single Thread.Loading analogue — not also a message row */}
          {phase === "thinking" ? (
            <div className="mt-4 w-full text-sm text-text-muted">
              <AnimatedStatusText label={scene.thinkingLabel} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pb-3">
        <div className="relative mx-auto w-full max-w-[760px] px-3">
          <DemoComposer
            draft={draft}
            phase={phase}
            streaming={streaming}
            features={features}
            modelName={modelName}
            reasoningEffort={reasoningEffort}
            reasoningEfforts={reasoningEfforts}
          />
        </div>
      </div>
    </div>
  );
}

function DemoFocusStrip({
  title,
  chips,
  sceneKey,
}: {
  title: string;
  chips: FocusChip[];
  sceneKey: string;
}) {
  return (
    <div
      key={sceneKey}
      className="shrink-0 px-3 py-2.5 animate-fade-in"
    >
      <p className="px-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-text-faint">
        {title}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {chips.map((chip, index) => {
          const Icon = chip.icon;
          return (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-text-muted ring-1 ring-white/[0.06] animate-fade-up"
              style={{ animationDelay: `${index * 40}ms` }}
            >
              <Icon className="size-3 text-accent" strokeWidth={1.75} />
              {chip.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function DemoThreadItem({ item }: { item: ThreadItem }) {
  if (item.kind === "user") {
    return (
      <div
        data-role="user"
        className="relative flex w-full min-w-0 flex-col animate-fade-up"
      >
        <div
          className="group grid w-full min-w-0 justify-items-end gap-1.5"
          data-role="user"
        >
          <div className="glass-bubble min-w-0 max-w-[min(100%,42rem)] rounded-2xl px-4 py-3 text-sm leading-relaxed text-text">
            {item.text}
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "image") {
    return (
      <div
        data-role="assistant"
        className="relative flex w-full min-w-0 flex-col animate-fade-up"
      >
        <div
          className="chat-scroll-x mt-1 flex max-w-full gap-2 overflow-x-auto pb-1.5"
          role="list"
          aria-label="Generated images"
        >
          <div className="w-40 shrink-0" role="listitem">
            <DemoGeneratedVisual variant={item.variant} caption={item.caption} />
          </div>
        </div>
      </div>
    );
  }

  if (item.kind === "reasoning") {
    const label = item.live ? "Thinking…" : "Thought for a moment";
    return (
      <div
        data-role="assistant"
        data-activity-only=""
        data-starts-activity=""
        className="relative flex w-full min-w-0 flex-col"
      >
        <div
          className="text-xs text-text-muted"
          data-reasoning-state={item.live ? "live" : "done"}
        >
          <div className="group/activity inline-flex max-w-full items-center gap-1.5 py-0.5 text-left">
            <ChevronDown
              className={`size-3.5 shrink-0 text-text-faint transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                item.open ? "rotate-0" : "-rotate-90"
              }`}
              strokeWidth={2}
            />
            {item.live ? (
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-accent"
                strokeWidth={2}
              />
            ) : null}
            <span
              className={`min-w-0 truncate font-medium tracking-tight ${
                item.live
                  ? "text-text"
                  : "text-text-muted group-hover/activity:text-text"
              }`}
            >
              {label}
            </span>
          </div>
          {item.open ? (
            <div className="mt-1.5 ml-1.5 border-l border-white/[0.08] pl-3 animate-fade-in">
              {item.summary ? (
                <p className="text-[12px] leading-relaxed text-text-muted">
                  {item.summary}
                </p>
              ) : (
                <p className="text-[12px] text-text-faint">
                  Waiting for summary…
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  if (item.kind === "tool") {
    const working = item.state === "working";
    const labelTone = working
      ? "text-text"
      : "text-text-muted group-hover/activity:text-text";
    const statusTone = working ? "text-accent" : "text-text-faint";
    return (
      <div
        data-role="tool"
        data-activity-only=""
        data-starts-activity=""
        className="relative flex w-full min-w-0 flex-col"
      >
        <div className="text-xs text-text-muted">
          <div className="group/activity inline-flex max-w-full items-center gap-1.5 py-0.5 text-left">
            <ChevronDown
              className={`size-3.5 shrink-0 text-text-faint transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                item.open ? "rotate-0" : "-rotate-90"
              }`}
              strokeWidth={2}
            />
            {working ? (
              <Loader2
                className="size-3.5 shrink-0 animate-spin text-accent"
                strokeWidth={2}
              />
            ) : null}
            <span
              className={`min-w-0 truncate font-medium tracking-tight ${labelTone}`}
            >
              {item.label}
            </span>
            <span className={`shrink-0 text-[11px] font-medium ${statusTone}`}>
              · {working ? "Working" : "Done"}
            </span>
          </div>
          {item.open ? (
            <div className="mt-1.5 ml-1.5 space-y-3 border-l border-white/[0.08] pl-3 animate-fade-in">
              {item.step.requestTitle ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint">
                    {item.step.requestTitle}
                  </p>
                  {item.step.requestSummary ? (
                    <p className="text-[12px] font-medium leading-relaxed text-text/90">
                      {item.step.requestSummary}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint">
                  {item.step.resultTitle ?? "Result"}
                </p>
                {working && item.step.imageKind ? (
                  <div
                    className="flex items-center gap-2.5"
                    role="status"
                    aria-label="Generating image"
                  >
                    <div className="skeleton-shimmer aspect-square w-14 shrink-0 rounded-lg" />
                    <div className="flex flex-col gap-1.5">
                      <div className="skeleton-shimmer h-2.5 w-24 rounded-full" />
                      <div className="skeleton-shimmer h-2.5 w-16 rounded-full" />
                    </div>
                  </div>
                ) : working ? (
                  <p className="text-[12px] text-text-faint">Working…</p>
                ) : item.step.imageKind ? (
                  <div className="space-y-2">
                    {item.step.resultSummary ? (
                      <p className="text-[12px] font-medium leading-relaxed text-text/90">
                        {item.step.resultSummary}
                      </p>
                    ) : null}
                    <div className="w-28">
                      <DemoGeneratedVisual
                        variant={item.step.imageKind}
                        caption={
                          item.step.imageKind === "heatmap"
                            ? "Risk heatmap"
                            : "Cover"
                        }
                        compact
                      />
                    </div>
                  </div>
                ) : item.step.resultSummary ? (
                  <p className="text-[12px] font-medium leading-relaxed text-text/90">
                    {item.step.resultSummary}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      data-role="assistant"
      className="relative flex w-full min-w-0 flex-col animate-fade-in"
    >
      <div className="group grid w-full min-w-0 justify-items-start gap-1.5">
        <div className="min-w-0 w-full max-w-full text-sm leading-relaxed text-text">
          <p className="text-pretty whitespace-pre-wrap">
            {item.text}
            {item.streaming ? (
              <span
                className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] bg-accent align-middle animate-pulse"
                aria-hidden
              />
            ) : null}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Decorative generated-image tile — heatmap grid or cover art (no network). */
function DemoGeneratedVisual({
  variant,
  caption,
  compact = false,
}: {
  variant: "heatmap" | "cover";
  caption: string;
  compact?: boolean;
}) {
  if (variant === "heatmap") {
    // 5×4 risk matrix — warm amber → cool muted cells
    const cells = [
      0.15, 0.25, 0.4, 0.55, 0.7, 0.22, 0.35, 0.5, 0.75, 0.85, 0.3, 0.45, 0.62,
      0.8, 0.92, 0.18, 0.38, 0.58, 0.72, 0.88,
    ];
    return (
      <div className="overflow-hidden rounded-lg border border-white/[0.08] bg-canvas-elevated animate-scale-in">
        <div
          className={`grid grid-cols-5 gap-0.5 p-1.5 ${compact ? "aspect-square" : "aspect-square"}`}
        >
          {cells.map((intensity, i) => (
            <div
              key={i}
              className="rounded-[3px]"
              style={{
                background: `rgba(232, 163, 23, ${0.12 + intensity * 0.78})`,
              }}
            />
          ))}
        </div>
        {!compact ? (
          <p className="border-t border-white/[0.06] px-2 py-1.5 text-[10px] leading-snug text-text-faint">
            {caption}
          </p>
        ) : null}
      </div>
    );
  }

  // Cover — soft aurora-like gradient card
  return (
    <div className="overflow-hidden rounded-lg border border-white/[0.08] animate-scale-in">
      <div
        className={`relative flex aspect-square items-end p-2.5 ${compact ? "" : ""}`}
        style={{
          background:
            "radial-gradient(circle at 28% 30%, rgba(232,163,23,0.45), transparent 52%), radial-gradient(circle at 78% 70%, rgba(194,98,28,0.35), transparent 48%), #0c0c0c",
        }}
      >
        <div className="w-full">
          <div className="h-1 w-8 rounded-full bg-accent/80" />
          <div className="mt-1.5 h-1 w-14 rounded-full bg-white/20" />
          <div className="mt-1 h-1 w-10 rounded-full bg-white/10" />
        </div>
      </div>
      {!compact ? (
        <p className="border-t border-white/[0.06] bg-canvas-elevated px-2 py-1.5 text-[10px] leading-snug text-text-faint">
          {caption}
        </p>
      ) : null}
    </div>
  );
}

function DemoComposer({
  draft,
  phase,
  streaming,
  features,
  modelName,
  reasoningEffort,
  reasoningEfforts,
}: {
  draft: string;
  phase: Phase;
  streaming: boolean;
  features: { web: boolean; image: boolean };
  modelName: string;
  reasoningEffort: string | null;
  reasoningEfforts: string[];
}) {
  const showCaret = phase === "typing";
  const placeholder = streaming
    ? "The agent is generating…"
    : "Ask about your documents…";
  const anyFeature = features.web || features.image;
  const canSend = draft.trim().length > 0 && !streaming;
  const reasoningLabel =
    reasoningEffort === null
      ? "None"
      : reasoningEffort.charAt(0).toUpperCase() + reasoningEffort.slice(1);

  return (
    <div className="glass-composer group/composer flex flex-col gap-2.5 rounded-[1.35rem] p-3.5">
      <div className="relative flex min-h-[2.75rem] flex-col pb-11">
        <div className="composer-input min-h-[1.5rem] w-full min-w-0 flex-1 bg-transparent px-1 text-sm leading-relaxed text-text">
          {draft ? (
            <span>
              {draft}
              {showCaret ? (
                <span
                  className="ml-px inline-block h-[1.05em] w-[1.5px] translate-y-[2px] bg-text/80 align-middle animate-pulse"
                  aria-hidden
                />
              ) : null}
            </span>
          ) : (
            <span className="text-text-faint">{placeholder}</span>
          )}
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {/* FeaturesPopover visual shell */}
            <div className="relative inline-flex">
              <div className="glass inline-flex h-8 items-stretch overflow-hidden rounded-xl">
                <span
                  className={`inline-flex size-8 shrink-0 items-center justify-center ${
                    anyFeature
                      ? "rounded-l-xl text-accent"
                      : "rounded-xl text-text-muted"
                  }`}
                >
                  <Plus className="size-4" strokeWidth={1.75} />
                </span>
                {anyFeature ? (
                  <>
                    <span
                      className="my-1.5 w-px shrink-0 self-stretch bg-white/[0.1]"
                      aria-hidden
                    />
                    <span className="inline-flex items-center gap-1 rounded-r-xl px-1">
                      {features.web ? (
                        <span className="inline-flex size-7 items-center justify-center rounded-lg">
                          <Globe
                            className="size-4 text-accent"
                            strokeWidth={1.75}
                          />
                        </span>
                      ) : null}
                      {features.image ? (
                        <span className="inline-flex size-7 items-center justify-center rounded-lg">
                          <ImagePlus
                            className="size-4 text-accent"
                            strokeWidth={1.75}
                          />
                        </span>
                      ) : null}
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {/* ModelReasoningSwitcher visual shell */}
            <div className="relative inline-flex max-w-full">
              <div
                className={`glass inline-flex h-8 max-w-full items-stretch overflow-hidden rounded-xl text-[11px] font-medium text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  streaming ? "opacity-40" : ""
                }`}
              >
                <span className="inline-flex min-w-0 max-w-[7.25rem] items-center gap-1.5 rounded-l-xl px-2">
                  <Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{modelName}</span>
                  <ChevronDown
                    className="size-3 shrink-0 opacity-60"
                    strokeWidth={2}
                  />
                </span>
                <span
                  className="my-1.5 w-px shrink-0 self-stretch bg-white/[0.1]"
                  aria-hidden
                />
                <span className="inline-flex min-w-0 max-w-[6.5rem] items-center gap-1.5 rounded-r-xl px-2">
                  <ReasoningEffortIcon
                    effort={reasoningEffort}
                    efforts={reasoningEfforts}
                  />
                  <span className="min-w-0 truncate">{reasoningLabel}</span>
                  <ChevronDown
                    className="size-3 shrink-0 opacity-60"
                    strokeWidth={2}
                  />
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <span className="glass glass-interactive inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-text-muted opacity-70">
              <Paperclip className="size-4" strokeWidth={1.75} />
            </span>

            {streaming && phase !== "sending" && phase !== "typing" ? (
              <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-text text-canvas">
                <Square className="size-3 fill-current" strokeWidth={0} />
              </span>
            ) : (
              <span
                className={`inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                  canSend || phase === "sending" ? "opacity-100" : "opacity-40"
                } ${phase === "sending" ? "scale-95" : ""}`}
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
