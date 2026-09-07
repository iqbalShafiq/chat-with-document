import { describe, expect, it, vi } from "vitest";
import type { ToolApprovalContext, ToolApprovalRequirement } from "@anvia/core";
import { normalizeToolResultOutput } from "@anvia/core/tool";
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

type WebApproval = (
  args: { reason: string },
  context: ToolApprovalContext<{ reason: string }>,
) =>
  | boolean
  | ToolApprovalRequirement
  | Promise<boolean | ToolApprovalRequirement>;

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

function approvalContext(args: { reason: string }): ToolApprovalContext<typeof args> {
  return {
    toolName: "web_search",
    args,
    rawArgs: JSON.stringify(args),
    toolCallId: "tool-call-1",
    internalCallId: "internal-call-1",
    run: { agentId: "agent-1", runId: "run-1", sessionId: "session-1" },
  };
}

describe("createWebSearchTools", () => {
  it("returns web_search and web_fetch in order", () => {
    const { client } = fakeClient();
    const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
    expect(tools.map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
  });

  describe("approval policy", () => {
    it("requires approval when the web-search toggle is disabled", async () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
      const requiresApproval = tools[0]!.requiresApproval as WebApproval;
      const input = { reason: REASON };
      expect(await requiresApproval(input, approvalContext(input))).toEqual({
        reason: REASON,
      });
    });

    it("does not require approval when the toggle is enabled", async () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
      const requiresApproval = tools[0]!.requiresApproval as WebApproval;
      const input = { reason: REASON };
      expect(await requiresApproval(input, approvalContext(input))).toBe(false);
    });

    it("uses the model-supplied reason dynamically", async () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({ tavilyClient: client, enabled: false });
      const requiresApproval = tools[0]!.requiresApproval as WebApproval;
      const input = { reason: REASON };
      expect(await requiresApproval(input, approvalContext(input))).toEqual({
        reason: REASON,
      });
    });

    it("skips approval when a session grant already exists", async () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({
        tavilyClient: client,
        enabled: false,
        hasGrant: (toolName) => toolName === "web_search",
      });
      const requiresApproval = tools[0]!.requiresApproval as WebApproval;
      const input = { reason: REASON };

      expect(await requiresApproval(input, approvalContext(input))).toBe(false);
    });

    it("fails closed when the session grant lookup fails", async () => {
      const { client } = fakeClient();
      const tools = createWebSearchTools({
        tavilyClient: client,
        enabled: false,
        hasGrant: async () => {
          throw new Error("grant registry unavailable");
        },
      });
      const requiresApproval = tools[0]!.requiresApproval as WebApproval;
      const input = { reason: REASON };

      expect(await requiresApproval(input, approvalContext(input))).toEqual({
        reason: REASON,
      });
    });
  });

  describe("web_search", () => {
    it("does not start Tavily after cancellation", async () => {
      const { client, search } = fakeClient();
      const controller = new AbortController();
      controller.abort(new DOMException("Stopped", "AbortError"));
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });

      await expect(
        tools[0]!.call(
          { query: QUERY, reason: REASON },
          { abortSignal: controller.signal },
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(search).not.toHaveBeenCalled();
    });

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

    it("requests and returns search images with descriptions", async () => {
      const { client, search } = fakeClient();
      search.mockResolvedValue({
        query: QUERY,
        responseTime: 100,
        images: [
          { url: "https://example.com/a.jpg", description: "A logo" },
          { url: "https://example.com/b.jpg" },
        ],
        results: [result("R", "https://example.com/1", "content")],
        requestId: "req-1",
      });
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
      const output = await tools[0]!.call({ query: QUERY, reason: REASON }) as any;
      expect(search).toHaveBeenCalledWith(QUERY, expect.objectContaining({ includeImages: true, includeImageDescriptions: true }));
      expect(output.images).toEqual([
        { url: "https://example.com/a.jpg", description: "A logo" },
        { url: "https://example.com/b.jpg" },
      ]);
      expect(normalizeToolResultOutput(output).type).toBe("json");
    });

    it("caps images to 5 and truncates descriptions to 300 chars", async () => {
      const { client, search } = fakeClient();
      search.mockResolvedValue({
        query: QUERY, responseTime: 100,
        images: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}.jpg`, description: "x".repeat(500) })),
        results: [], requestId: "req-1",
      });
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
      const output = await tools[0]!.call({ query: QUERY, reason: REASON }) as any;
      expect(output.images).toHaveLength(5);
      expect(output.images[0].description.length).toBeLessThanOrEqual(301); // 300 + ellipsis
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

    it("returns fetch images from extract", async () => {
      const { client, extract } = fakeClient();
      extract.mockResolvedValue({
        results: [{ url: "https://example.com/article", title: "T", rawContent: "content", images: ["https://example.com/img1.jpg", "https://example.com/img2.png"] }],
        failedResults: [], responseTime: 100, requestId: "req-2",
      });
      const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
      const output = await tools[1]!.call({ url: "https://example.com/article", reason: REASON }) as any;
      expect(extract).toHaveBeenCalledWith(["https://example.com/article"], expect.objectContaining({ includeImages: true }));
      expect(output.images).toEqual(["https://example.com/img1.jpg", "https://example.com/img2.png"]);
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
