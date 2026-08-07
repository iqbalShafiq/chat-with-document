import { createTool, type AnyTool } from "@anvia/core";
import { tavily, type TavilyClient } from "@tavily/core";
import z from "zod";

/** Create a Tavily client from a server-side API key (never ship this to the browser). */
export function createTavilyClient(apiKey: string): TavilyClient {
  return tavily({ apiKey });
}

/**
 * Web search + fetch tools backed by Tavily. Both tools share one approval
 * gate: when the per-session web-search toggle is off, the model may still
 * call them, but the run suspends and asks the user to approve with the
 * reason the model supplied in `args.reason` (dynamic justification).
 */

const MAX_RESULTS = 5;

const TIME_RANGE = ["day", "week", "month", "year"] as const;

const webSearchInput = z.object({
  query: z
    .string()
    .min(2, "Query must be at least 2 characters")
    .max(300, "Query must be at most 300 characters")
    .describe(
      "The precise web search query. Include quotes for exact phrases.",
    ),
  reason: z
    .string()
    .min(1, "A reason is required")
    .max(500, "Reason must be at most 500 characters")
    .describe(
      "Why you need this web search and what question it will answer. " +
        "Shown to the user when approval is required.",
    ),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .describe(`Number of results to return (default ${MAX_RESULTS}, max ${MAX_RESULTS})`),
  timeRange: z
    .enum(TIME_RANGE)
    .optional()
    .describe("Only search results published or updated within this window"),
});

const webFetchInput = z.object({
  url: z
    .string()
    .url("A valid http(s) URL is required")
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "Only http(s) URLs are supported",
    })
    .describe("The exact URL to fetch and read"),
  reason: z
    .string()
    .min(1, "A reason is required")
    .max(500, "Reason must be at most 500 characters")
    .describe(
      "Why you need this page and what information it should provide. " +
        "Shown to the user when approval is required.",
    ),
});

export type WebSearchToolScope = {
  tavilyClient: TavilyClient;
  /** Per-session toggle: false → the model must ask the user before searching. */
  enabled: boolean;
  maxResults?: number;
  /** Truncate result content to this many characters (default 400). */
  contentLimitChars?: number;
};

export type WebSearchResultItem = {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
  score?: number;
};

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

/** Map Tavily failures to bounded, non-sensitive messages. */
export function mapTavilyError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Web access temporarily unavailable";
  }
  const record = error as { status?: unknown; message?: unknown };
  const status =
    typeof record.status === "number" ? record.status : null;
  if (status === 401 || status === 403) {
    return "Web search is not configured (invalid API key)";
  }
  if (status === 429 || status === 432 || status === 433) {
    return "Web search rate limit exceeded; try again later";
  }
  if (status === 400) {
    return "Web search rejected the request; try a different query";
  }
  return "Web access temporarily unavailable";
}

export function createWebSearchTools(
  scope: WebSearchToolScope,
): AnyTool[] {
  const maxResults = scope.maxResults ?? MAX_RESULTS;
  const contentLimitChars = scope.contentLimitChars ?? 400;

  const approval = {
    when: () => !scope.enabled,
    reason: (ctx: { args: { reason: string } }) => ctx.args.reason,
    rejectMessage:
      "Web access was declined by the user; answer from available knowledge without the web.",
  };

  return [
    createTool({
      name: "web_search",
      description:
        "Search the live web for up-to-date information using Tavily. Use when the answer needs current, factual, or out-of-scope information not present in the session documents — news, prices, dates, specs, events. Always provide a precise query and a clear reason.",
      input: webSearchInput,
      approval,
      execute: async ({ query, maxResults: requestedMax, timeRange }) => {
        try {
          const response = await scope.tavilyClient.search(query, {
            searchDepth: "basic",
            maxResults: Math.min(requestedMax ?? maxResults, MAX_RESULTS),
            ...(timeRange ? { timeRange } : {}),
            includeAnswer: "basic",
          });
          return {
            query: response.query,
            answer: response.answer ?? null,
            results: response.results.slice(0, MAX_RESULTS).map((item) => ({
              title: item.title,
              url: item.url,
              content: truncate(item.content, contentLimitChars),
              ...(item.publishedDate
                ? { publishedDate: item.publishedDate }
                : {}),
              ...(typeof item.score === "number"
                ? { score: Number(item.score.toFixed(4)) }
                : {}),
            })),
          };
        } catch (error) {
          return { query, answer: null, results: [], error: mapTavilyError(error) };
        }
      },
    }),
    createTool({
      name: "web_fetch",
      description:
        "Fetch and read the full content of a specific web page (http/https) using Tavily Extract. Use when you already know the exact URL to consult — follow up on a search result, verify a claim, or read a page the user linked.",
      input: webFetchInput,
      approval,
      execute: async ({ url }) => {
        try {
          const response = await scope.tavilyClient.extract([url], {
            format: "markdown",
          });
          const result = response.results[0];
          if (!result) {
            const failed = response.failedResults[0];
            return {
              url,
              title: null,
              content: failed
                ? `Could not fetch the page: ${failed.error}`
                : "No content could be extracted from the page",
            };
          }
          return {
            url: result.url,
            title: result.title,
            content: truncate(result.rawContent, contentLimitChars * 3),
          };
        } catch (error) {
          return {
            url,
            title: null,
            content: `Could not fetch the page: ${mapTavilyError(error)}`,
          };
        }
      },
    }),
  ];
}

/** Agent guidance on when to use web tools vs context7 (added to instructions). */
export const WEB_SEARCH_INSTRUCTION = [
  "You have web access through the web_search and web_fetch tools.",
  "Use web_search for up-to-date or external facts; use web_fetch to read a specific page you know the URL of.",
  "Always fill the `reason` argument: a short, honest sentence explaining why the web is needed.",
  "When web_search or web_fetch requires approval, respect the user's decision — if declined, answer from the available context and say you could not verify online.",
  "For library/API documentation questions, prefer the context7 tools over web_search.",
  "Cite web sources in your answer with their URLs when you rely on them.",
].join("\n");
