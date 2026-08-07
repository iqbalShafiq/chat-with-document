import { describe, expect, it } from "vitest";
import type { UIMessage, UIMessagePart } from "@anvia/react";
import { collectWebSources } from "./web-sources";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function toolPart(
  toolName: string,
  output: unknown,
  state: ToolPart["state"] = "output-available",
): ToolPart {
  return {
    id: `part-${toolName}-${Math.random()}`,
    type: "tool",
    toolName,
    toolCallId: `call-${toolName}-${Math.random()}`,
    state,
    output: output as ToolPart["output"],
  };
}

function message(parts: UIMessagePart[]): UIMessage {
  return { id: `msg-${Math.random()}`, role: "assistant", parts };
}

describe("collectWebSources", () => {
  it("maps web_search results entries with source web_search", () => {
    const messages = [
      message([
        toolPart("web_search", {
          query: "tavily pricing",
          results: [
            { title: "Tavily", url: "https://tavily.com/pricing", content: "Plans" },
            { title: "Docs", url: "https://docs.tavily.com", content: "API docs" },
          ],
        }),
      ]),
    ];

    expect(collectWebSources(messages)).toEqual([
      {
        url: "https://tavily.com/pricing",
        title: "Tavily",
        content: "Plans",
        source: "web_search",
      },
      {
        url: "https://docs.tavily.com",
        title: "Docs",
        content: "API docs",
        source: "web_search",
      },
    ]);
  });

  it("synthesizes a web_fetch entry from url/title/content", () => {
    const messages = [
      message([
        toolPart("web_fetch", {
          url: "https://example.com/article",
          title: "Example article",
          content: "Full page content…",
        }),
      ]),
    ];

    expect(collectWebSources(messages)).toEqual([
      {
        url: "https://example.com/article",
        title: "Example article",
        content: "Full page content…",
        source: "web_fetch",
      },
    ]);
  });

  it("dedupes by URL with first appearance winning", () => {
    const messages = [
      message([
        toolPart("web_search", {
          results: [
            { title: "First", url: "https://example.com/x", content: "one" },
          ],
        }),
        toolPart("web_fetch", {
          url: "https://example.com/x",
          title: "Fetched",
          content: "two",
        }),
      ]),
      message([
        toolPart("web_search", {
          results: [
            { title: "Third", url: "https://example.com/x", content: "three" },
          ],
        }),
      ]),
    ];

    expect(collectWebSources(messages)).toEqual([
      {
        url: "https://example.com/x",
        title: "First",
        content: "one",
        source: "web_search",
      },
    ]);
  });

  it("ignores parts without output-available state", () => {
    const messages = [
      message([
        toolPart("web_search", { query: "q" }, "input-streaming"),
        toolPart("web_search", { query: "q" }, "input-available"),
        toolPart("web_search", { query: "q" }, "error"),
      ]),
    ];

    expect(collectWebSources(messages)).toEqual([]);
  });
});
