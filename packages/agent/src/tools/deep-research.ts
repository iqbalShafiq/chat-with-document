import { createTool, type AnyTool, type ToolCallContext } from "@anvia/core";
import { z } from "zod";

export type DeepResearchProgressPhase =
  | "planning"
  | "researching"
  | "synthesizing"
  | "completed"
  | "failed";

export type DeepResearchActivityKind =
  | "planning"
  | "retrieval"
  | "analysis"
  | "verification"
  | "synthesis";

export type DeepResearchActivityStatus = "active" | "done" | "failed";

export type DeepResearchActivity = {
  id: string;
  kind: DeepResearchActivityKind;
  label: string;
  status: DeepResearchActivityStatus;
};

export type DeepResearchProgressStats = {
  retrievalCalls: number;
  retrievalLimit: number;
};

export type DeepResearchProgress = {
  phase: DeepResearchProgressPhase;
  message: string;
  activities?: DeepResearchActivity[];
  stats?: DeepResearchProgressStats;
};

export type DeepResearchProgressReporter = (
  event: DeepResearchProgress,
) => Promise<void> | void;

export type DeepResearchResearcher = {
  asTool(options: {
    name: string;
    description: string;
    maxTurns: number;
    stream: boolean;
  }): AnyTool;
};

export type DeepResearchToolScope = {
  enabled: boolean;
  researcher: DeepResearchResearcher;
  maxTurns?: number;
  maxSearches?: number;
  hasGrant?: (toolName: string) => Promise<boolean> | boolean;
  onProgress?: DeepResearchProgressReporter | undefined;
};

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_SEARCHES = 8;
const MAX_TURNS = 30;
const MAX_SEARCHES = 20;

const ACTIVITY_METADATA: Record<
  string,
  { kind: DeepResearchActivityKind; label: string }
> = {
  find_documents: { kind: "retrieval", label: "Finding relevant documents" },
  search_document_pages: {
    kind: "retrieval",
    label: "Searching document pages",
  },
  get_document_next_page: {
    kind: "retrieval",
    label: "Reading another document page",
  },
  get_document_page_images: {
    kind: "retrieval",
    label: "Inspecting document pages",
  },
  extract_document_tables: {
    kind: "retrieval",
    label: "Extracting document tables",
  },
  web_search: { kind: "retrieval", label: "Searching the web" },
  web_fetch: { kind: "retrieval", label: "Reading a web page" },
  read_dataset: { kind: "analysis", label: "Reading the dataset" },
  analyze_dataset: { kind: "analysis", label: "Analyzing the dataset" },
  query_dataset_sql: { kind: "analysis", label: "Querying the dataset" },
  descriptive_stats: {
    kind: "analysis",
    label: "Computing descriptive statistics",
  },
  pearson_correlation: { kind: "analysis", label: "Computing correlation" },
  linear_regression: { kind: "analysis", label: "Fitting regression" },
};

const deepResearchInput = z.object({
  prompt: z
    .string()
    .trim()
    .min(1)
    .max(8_000)
    .describe("The multi-source research question to investigate"),
  reason: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe("Why this question needs multi-source research"),
});

function boundedInteger(value: number | undefined, fallback: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value as number)));
}

function envInteger(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return boundedInteger(Number.isFinite(value) ? value : undefined, fallback, max);
}

export function deepResearchLimits(): { maxTurns: number; maxSearches: number } {
  return {
    maxTurns: envInteger("DEEP_RESEARCH_MAX_TURNS", DEFAULT_MAX_TURNS, MAX_TURNS),
    maxSearches: envInteger(
      "DEEP_RESEARCH_MAX_SEARCHES",
      DEFAULT_MAX_SEARCHES,
      MAX_SEARCHES,
    ),
  };
}

export const DEEP_RESEARCH_INSTRUCTION = `
Deep Research is available as a bounded, source-grounded workflow. Use it when the user needs a multi-source investigation, comparison, or current web-and-document synthesis rather than a short direct answer. The tool owns the approval boundary for the entire research run.
When the user explicitly requests Deep Research and provides a concrete question, call deep_research directly; do not ask a clarification question merely to restate the research scope.
Call deep_research before ordinary retrieval when the request explicitly asks for Deep Research; do not pre-empt it with document or web tools.
After deep_research returns, preserve any [[cite:N]] markers and the citations JSON trailer; never emit citation markers without that trailer.
`.trim();

export function buildDeepResearchPrompt(prompt: string, maxSearches: number): string {
  return [
    "You are the Deep Research specialist for the parent chat agent.",
    `Research question: ${prompt}`,
    "",
    "Workflow: Plan -> search documents/web -> analyze -> synthesize -> verify.",
    "First, produce a numbered research plan with subquestions, source targets, and a stopping criterion.",
    "Do not retrieve evidence before the plan is complete.",
    "After collecting evidence, analyze it by source type and separate verified findings from inference.",
    "Before finalizing, verify each material claim against the collected evidence; if a gap remains, perform bounded re-search or state the limitation.",
    `Do not make more than ${maxSearches} search or fetch calls in total.`,
    "Use only the tools provided to you and stop when the evidence is sufficient.",
    "Prefer primary and authoritative sources for current web claims.",
    "Separate document-grounded findings, web-grounded findings, and cautious inferences.",
    "Return a concise report with methods, findings, limitations, and a verification note.",
    "When a claim is grounded in a tool result, preserve the source details and cite it with [[cite:N]].",
    "If you emit any [[cite:N]] marker, append exactly one ```citations JSON block using the existing citation contract.",
    "Never invent document ids, page indices, URLs, or snippets. If evidence is missing, say so.",
  ].join("\n");
}

async function emit(
  scope: DeepResearchToolScope,
  event: DeepResearchProgress,
): Promise<void> {
  try {
    await scope.onProgress?.(event);
  } catch (error) {
    // Progress is observability only; a broken stream must not turn a valid
    // research result into a failed assistant answer.
    console.warn("[deep-research] progress callback failed", error);
  }
}

async function hasSessionGrant(scope: DeepResearchToolScope): Promise<boolean> {
  if (!scope.hasGrant) return false;
  try {
    return await scope.hasGrant("deep_research");
  } catch (error) {
    // Fail closed when Redis/approval state is unavailable.
    console.warn("[deep-research] grant lookup failed", error);
    return false;
  }
}

export function createDeepResearchTools(scope: DeepResearchToolScope): AnyTool[] {
  const configured = deepResearchLimits();
  const maxTurns = boundedInteger(scope.maxTurns, configured.maxTurns, MAX_TURNS);
  const maxSearches = boundedInteger(
    scope.maxSearches,
    configured.maxSearches,
    MAX_SEARCHES,
  );

  const tool = createTool({
    name: "deep_research",
    description:
      "Run a bounded multi-source research workflow over the active documents and available web sources. Returns a cited report and should be used for comparisons, investigations, and current evidence synthesis.",
    input: deepResearchInput,
    approval: {
      when: async () => !scope.enabled && !(await hasSessionGrant(scope)),
      reason: ({ args }) =>
        `${args.reason} Estimated cost/latency: bounded to up to ${maxTurns} agent turns and ${maxSearches} retrieval calls; provider-dependent latency is typically tens of seconds to a few minutes.`,
      rejectMessage:
        "Deep Research was declined by the user. Do not call web_search, web_fetch, document search, or any other retrieval/research tool for this request. Answer only from the existing conversation; if evidence is insufficient, say so.",
    },
    execute: async ({ prompt }, context: ToolCallContext) => {
      await emit(scope, {
        phase: "planning",
        message: "Planning a bounded multi-source research run",
        activities: [
          {
            id: "deep-research-planning",
            kind: "planning",
            label: "Planning the research",
            status: "active",
          },
        ],
      });

      const researcherTool = scope.researcher.asTool({
        name: "deep_research_researcher",
        description:
          "Delegate one bounded research run to the specialist researcher. The specialist must use the provided document, web, and dataset tools and return a source-grounded report.",
        maxTurns,
        stream: true,
      });

      try {
        await emit(scope, {
          phase: "researching",
          message: "Searching and analyzing the available evidence",
          activities: [
            {
              id: "deep-research-planning",
              kind: "planning",
              label: "Planning the research",
              status: "done",
            },
          ],
          stats: {
            retrievalCalls: 0,
            retrievalLimit: maxSearches,
          },
        });
        const result = await researcherTool.call(
          { prompt: buildDeepResearchPrompt(prompt, maxSearches) },
          context,
        );
        await emit(scope, {
          phase: "synthesizing",
          message: "Synthesizing findings and checking citations",
          activities: [
            {
              id: "deep-research-verification",
              kind: "verification",
              label: "Checking evidence and citations",
              status: "active",
            },
          ],
        });
        await emit(scope, {
          phase: "completed",
          message: "Deep Research report is ready",
          activities: [
            {
              id: "deep-research-verification",
              kind: "verification",
              label: "Checking evidence and citations",
              status: "done",
            },
            {
              id: "deep-research-synthesis",
              kind: "synthesis",
              label: "Preparing the final report",
              status: "done",
            },
          ],
        });
        return result;
      } catch (error) {
        await emit(scope, {
          phase: "failed",
          message: "Deep Research could not complete",
          activities: [
            {
              id: "deep-research-failure",
              kind: "verification",
              label: "Completing the research",
              status: "failed",
            },
          ],
        });
        throw error;
      }
    },
  });

  return [tool];
}

const SEARCH_TOOL_NAMES = new Set([
  "web_search",
  "web_fetch",
  "search_document_pages",
  "get_document_next_page",
  "extract_document_tables",
]);

/**
 * Wraps researcher retrieval tools with a shared hard call budget. The model
 * also receives the limit in its instructions, but this guard remains true
 * when the model ignores prose instructions.
 */
export function boundDeepResearchTools(
  tools: AnyTool[],
  maxSearches: number,
  onProgress?: DeepResearchProgressReporter,
): AnyTool[] {
  const limit = boundedInteger(maxSearches, DEFAULT_MAX_SEARCHES, MAX_SEARCHES);
  let calls = 0;
  let activitySequence = 0;

  return tools.map((tool) => {
    const metadata = ACTIVITY_METADATA[tool.name];
    if (!metadata) return tool;

    return {
      name: tool.name,
      approval: tool.approval,
      parseApprovalArgs: tool.parseApprovalArgs,
      definition: (prompt: string) => tool.definition(prompt),
      call: async (args: unknown, context?: ToolCallContext) => {
        const countsTowardBudget = SEARCH_TOOL_NAMES.has(tool.name);
        if (countsTowardBudget && calls >= limit) {
          return {
            error: `Deep Research retrieval budget exhausted after ${limit} calls. Synthesize from the evidence already collected.`,
          };
        }
        if (countsTowardBudget) calls += 1;

        const activityId = `deep-research-activity-${++activitySequence}`;
        const stats = {
          retrievalCalls: calls,
          retrievalLimit: limit,
        };
        await reportProgress(onProgress, {
          phase: "researching",
          message: `${metadata.label}…`,
          activities: [
            {
              id: activityId,
              kind: metadata.kind,
              label: metadata.label,
              status: "active",
            },
          ],
          stats,
        });

        try {
          const result = await tool.call(args, context);
          await reportProgress(onProgress, {
            phase: "researching",
            message: `${metadata.label} complete`,
            activities: [
              {
                id: activityId,
                kind: metadata.kind,
                label: metadata.label,
                status: "done",
              },
            ],
            stats,
          });
          return result;
        } catch (error) {
          await reportProgress(onProgress, {
            phase: "researching",
            message: `${metadata.label} failed`,
            activities: [
              {
                id: activityId,
                kind: metadata.kind,
                label: metadata.label,
                status: "failed",
              },
            ],
            stats,
          });
          throw error;
        }
      },
    } as AnyTool;
  });
}

async function reportProgress(
  onProgress: DeepResearchProgressReporter | undefined,
  event: DeepResearchProgress,
): Promise<void> {
  try {
    await onProgress?.(event);
  } catch (error) {
    console.warn("[deep-research] activity callback failed", error);
  }
}
