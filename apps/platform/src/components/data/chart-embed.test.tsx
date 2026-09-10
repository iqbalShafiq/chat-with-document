import { describe, expect, it } from "vitest";
import { chartEmbedIndex } from "#/lib/data-analysis";
import { collectMessageChartSpecs, collectThreadChartSpecs, collectTurnChartSpecs } from "./chart-registry-context";
import { chartAltToIndex } from "./chart-embed";

describe("chart embed references", () => {
  it("parses chart:N alt text to a 1-based index", () => {
    expect(chartEmbedIndex("chart:1")).toBe(1);
    expect(chartEmbedIndex("chart:12")).toBe(12);
    expect(chartEmbedIndex("chart:0")).toBeNull();
    expect(chartEmbedIndex("chart:x")).toBeNull();
    expect(chartEmbedIndex("a photo")).toBeNull();
    expect(chartEmbedIndex(null)).toBeNull();
  });

  it("exposes the same parser through the embed component helper", () => {
    expect(chartAltToIndex("chart:3")).toBe(3);
    expect(chartAltToIndex("other")).toBeNull();
  });

  it("collects chart specs across messages in thread order", () => {
    const bar = { kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] };
    const pie = { kind: "pie", labels: ["a"], values: [1] };
    const specs = collectThreadChartSpecs([
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: pie }) }] },
      { parts: [{ type: "text", text: "hello" }] },
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: bar }) }] },
      { parts: [{ type: "tool", state: "input-streaming", output: JSON.stringify({ chart: bar }) }] },
    ] as never);
    expect(specs).toEqual([pie, bar]);
  });

  it("numbers charts per message, not across the thread", () => {
    const first = { kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] };
    const second = { kind: "pie", labels: ["a"], values: [1] };
    const messages = [
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: first }) }] },
      { parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: second }) }] },
    ] as never;
    expect(collectMessageChartSpecs(messages[1]!)).toEqual([second]);
  });

  it("collects charts across split assistant messages in one turn", () => {
    const bar = { kind: "bar", labels: ["a"], series: [{ name: "s", values: [1] }] };
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "chart it" }] },
      { id: "a1", role: "assistant", parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: bar }) }] },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "![chart:1]()" }] },
      { id: "u2", role: "user", parts: [{ type: "text", text: "again" }] },
      { id: "a3", role: "assistant", parts: [{ type: "tool", state: "output-available", output: JSON.stringify({ chart: { kind: "pie", labels: ["x"], values: [1] } }) }] },
    ] as never;
    expect(collectTurnChartSpecs(messages, "a2")).toEqual([bar]);
    expect(collectTurnChartSpecs(messages, "a3")).toHaveLength(1);
    expect(collectTurnChartSpecs(messages, "a3")[0]).toMatchObject({ kind: "pie" });
  });

  it("hoists dataset-chart fences from a deep_research string output", () => {
    const chart = { kind: "bar", labels: ["east"], series: [{ name: "revenue", values: [100] }] };
    const specs = collectThreadChartSpecs([
      {
        parts: [
          {
            type: "tool",
            state: "output-available",
            output: `report\n\`\`\`dataset-chart\n${JSON.stringify({ documentId: "d", chart })}\n\`\`\``,
          },
        ],
      },
    ] as never);
    expect(specs).toEqual([chart]);
  });
});
