import { describe, expect, it } from "vitest";
import {
  assertMcpEntryReviewed,
  selectReviewedTools,
  unprefixToolName,
} from "./build-run-input.js";

describe("unprefixToolName", () => {
  it("strips the server prefix for allow-list comparison", () => {
    expect(unprefixToolName("e2e_docs_search", "e2e_docs_")).toBe("search");
    expect(unprefixToolName("search", "e2e_docs_")).toBe("search");
  });
});

describe("selectReviewedTools", () => {
  it("matches prefixed live tools against unprefixed allow-lists", () => {
    const live = [{ name: "e2e_docs_search" }, { name: "e2e_docs_other" }];
    expect(selectReviewedTools(live, new Set(["search"]), "e2e_docs_")).toEqual([
      { name: "e2e_docs_search" },
    ]);
  });

  it("keeps everything when the allow-list is empty", () => {
    const live = [{ name: "e2e_docs_search" }];
    expect(selectReviewedTools(live, new Set<string>(), "e2e_docs_")).toEqual(live);
  });
});

describe("assertMcpEntryReviewed", () => {
  it("fails closed on an empty frozen review", () => {
    expect(() => assertMcpEntryReviewed({ name: "docs", toolDefinitions: [] })).toThrow(
      'MCP server "docs" has no reviewed tools',
    );
  });
});
