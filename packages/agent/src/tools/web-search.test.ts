import { describe, expect, it, vi } from "vitest";
import type {
  TavilyClient,
  TavilyExtractResponse,
  TavilySearchResponse,
} from "@tavily/core";
import {
  createWebSearchTools,
  mapTavilyError,
  type WebSearchResultItem,
} from "./web-search.js";

type SearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate: string;
};

/** Minimal shape of the approval policy returned on an AnyTool (approval is `unknown`). */
type ApprovalPolicy = {
  when(ctx: { args: { reason: string } }): boolean | Promise<boolean>;
  reason(ctx: { args: { reason: string } }): string | Promise<string>;
};

type SearchOutput = {
  query: string;
  answer: string | null;
  results: WebSearchResultItem[];
  error?: string;
};

type FetchOutput = {
  url: string;
  title: string | null;
  content: string;
};

function fakeClient(): {
  client: TavilyClient;
  search: ReturnType<typeof vi.fn>;
  extract: ReturnType<typeof vi.fn>;
} {
  const search = vi.fn();
  const extract = vi.fn();
  const client = { search, extract } as unknown as TavilyClient;
  return { client, search, extract };
}

function result(
  title: string,
  url: string,
  content: string,
  score = 0.9,
): SearchResult {
  return { title, url, content, score, publishedDate: "2026-08-07" };
}

function searchResponse(
  results: SearchResult[],
  answer?: string,
): TavilySearchResponse {
  return {
    query: "gold price today",
    ...(answer !== undefined ? { answer } : {}),
    responseTime: 100,
    images: [],
    results,
    requestId: "req-1",
  };
}

function extractResponse(
  results: TavilyExtractResponse["results"],
  failedResults: TavilyExtractResponse["failedResults"],
): TavilyExtractResponse {
  return { results, failedResults, responseTime: 100, requestId: "req-2" };
}

const QUERY = "gold price today";
const REASON = "The answer needs current data";

describe("createWebSearchTools", () => {
  it("returns web_search and web_fetch in order", () => {
    const { client } = fakeClient();
    const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
  });

  describe("approval policy", () => {
    it("requires approval when the web-search toggle is disabled", () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(approval.when({ args: { reason: REASON } })).toBe(true);
    });

    it("does not require approval when the toggle is enabled", () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(approval.when({ args: { reason: REASON } })).toBe(false);
    });

    it("uses the model-supplied reason dynamically", () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
      const approval = tools[0]!.approval as ApprovalPolicy;
      expect(approval.reason({ args: { reason: REASON } })).toBe(REASON);
    });
  });

  describe("web_search", () => {
    it("normalizes search results and truncates content", async () => {
      const { client, search } = fakeClient();
      search.mockResolvedValue(
        searchResponse(
          [
            result("Result One", "https://example.com/1", "x".repeat(200)),
            result("Result Two", "https://example.com/2", "y".repeat(200)),
            result("Result Three", "https://example.com/3", "z".repeat(200)),
          ],
          "Gold is trading at record highs",
        ),
      );
      const tools = createWebSearchTools({
        tavilyClient: client,
        enabled: true,
        contentLimitChars: 50,
      });

      const output = (await tools[0]!.call({
        query: QUERY,
        reason: REASON,
        timeRange: "week",
        maxResults: 3,
      })) as SearchOutput;

      expect(search).toHaveBeenCalledWith(
        QUERY,
        expect.objectContaining({
          searchDepth: "basic",
          includeAnswer: "basic",
          maxResults: 3,
          timeRange: "week",
        }),
      );
      expect(output.query).toBe(QUERY);
      expect(output.answer).toBe("Gold is trading at record highs");
      expect(output.results).toHaveLength(3);
      for (const item of output.results) {
        expect(item.title).toMatch(/^Result /);
        expect(item.url).toMatch(/^https:\/\/example\.com\//);
        expect(item.content.endsWith("…")).toBe(true);
        expect(item.content.length).toBe(51);
      }
      expect(output.results[0]!.content).toBe(`${"x".repeat(50)}…`);
      expect(output.results[0]!.url).toBe("https://example.com/1");
    });

    it("bounds results to MAX_RESULTS (5)", async () => {
      const { client, search } = fakeClient();
      search.mockResolvedValue(
        searchResponse(
          Array.from({ length: 10 }, (_, index) =>
            result(`Result ${index}`, `https://example.com/${index}`, `content ${index}`),
          ),
        ),
      );
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      const output = (await tools[0]!.call({
        query: QUERY,
        reason: REASON,
      })) as SearchOutput;

      expect(search).toHaveBeenCalledWith(
        QUERY,
        expect.objectContaining({ maxResults: 5 }),
      );
      expect(output.results).toHaveLength(5);
    });

    it("maps a rate-limit failure to a bounded error message", async () => {
      const { client, search } = fakeClient();
      search.mockRejectedValue({ status: 429 });
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      const output = (await tools[0]!.call({
        query: QUERY,
        reason: REASON,
      })) as SearchOutput;

      expect(output.error).toMatch(/rate limit/i);
      expect(output.answer).toBeNull();
      expect(output.results).toEqual([]);
    });

    it("maps generic failures to a temporarily unavailable message", async () => {
      const { client, search } = fakeClient();
      search.mockRejectedValue(new Error("boom"));
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      const output = (await tools[0]!.call({
        query: QUERY,
        reason: REASON,
      })) as SearchOutput;

      expect(output.error).toBe("Web access temporarily unavailable");
    });
  });

  describe("web_fetch", () => {
    it("returns extracted page content", async () => {
      const { client, extract } = fakeClient();
      extract.mockResolvedValue(
        extractResponse(
          [
            {
              url: "https://example.com/article",
              title: "Example Article",
              rawContent: "Full page content here",
            },
          ],
          [],
        ),
      );
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      const output = (await tools[1]!.call({
        url: "https://example.com/article",
        reason: REASON,
      })) as FetchOutput;

      expect(extract).toHaveBeenCalledWith(
        ["https://example.com/article"],
        expect.objectContaining({ format: "markdown" }),
      );
      expect(output.url).toBe("https://example.com/article");
      expect(output.title).toBe("Example Article");
      expect(output.content).toBe("Full page content here");
    });

    it("reports failed extractions", async () => {
      const { client, extract } = fakeClient();
      extract.mockResolvedValue(
        extractResponse(
          [],
          [{ url: "https://blocked.example/page", error: "blocked" }],
        ),
      );
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      const output = (await tools[1]!.call({
        url: "https://blocked.example/page",
        reason: REASON,
      })) as FetchOutput;

      expect(output.title).toBeNull();
      expect(output.content).toMatch(/blocked/);
    });
  });
});

describe("mapTavilyError", () => {
  it("maps auth failures to a configuration message", () => {
    expect(mapTavilyError({ status: 401 })).toBe(
      "Web search is not configured (invalid API key)",
    );
    expect(mapTavilyError({ status: 403 })).toBe(
      "Web search is not configured (invalid API key)",
    );
  });

  it("maps bad requests to a query message", () => {
    expect(mapTavilyError({ status: 400 })).toBe(
      "Web search rejected the request; try a different query",
    );
  });

  it("falls back for non-object errors", () => {
    expect(mapTavilyError(null)).toBe("Web access temporarily unavailable");
    expect(mapTavilyError("boom")).toBe("Web access temporarily unavailable");
    expect(mapTavilyError(new Error("boom"))).toBe(
      "Web access temporarily unavailable",
    );
  });
});
