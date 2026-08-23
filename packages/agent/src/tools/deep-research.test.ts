import { describe, expect, it, vi } from "vitest";
import type { AnyTool } from "@anvia/core";
import {
  boundDeepResearchTools,
  buildDeepResearchPrompt,
  createDeepResearchTools,
  DEEP_RESEARCH_INSTRUCTION,
  type DeepResearchProgress,
} from "./deep-research.js";

type Researcher = {
  asTool(options: {
    name: string;
    description: string;
    maxTurns: number;
    stream: boolean;
  }): AnyTool;
};

function makeResearcher(output = "[[cite:1]] Grounded findings") {
  const call = vi.fn(async () => output);
  const researcherTool = {
    name: "deep_research_researcher",
    definition: vi.fn(),
    call,
  } as unknown as AnyTool;
  const asTool = vi.fn(() => researcherTool);
  return {
    researcher: { asTool } as unknown as Researcher,
    asTool,
    call,
  };
}

const args = {
  prompt: "Compare the attached quarterly report with current market data.",
  reason: "This needs multi-source research and source citations.",
};

describe("createDeepResearchTools", () => {
  it("exposes one approval-gated deep_research tool", () => {
    const { researcher } = makeResearcher();
    const tools = createDeepResearchTools({
      enabled: false,
      researcher,
      maxTurns: 8,
      maxSearches: 6,
    });

    expect(tools.map((tool) => tool.name)).toEqual(["deep_research"]);
    expect(tools[0]!.approval).toBeDefined();
  });

  it("requires approval when the toggle is off and no session grant exists", async () => {
    const { researcher } = makeResearcher();
    const tools = createDeepResearchTools({
      enabled: false,
      hasGrant: () => false,
      researcher,
    });
    const approval = tools[0]!.approval as {
      when(ctx: { args: typeof args }): boolean | Promise<boolean>;
      reason(ctx: { args: typeof args }): string;
    };

    expect(await approval.when({ args })).toBe(true);
    expect(approval.reason({ args })).toContain(args.reason);
  });

  it("includes bounded cost and latency guidance in the approval reason", () => {
    const { researcher } = makeResearcher();
    const tool = createDeepResearchTools({
      enabled: false,
      researcher,
      maxTurns: 7,
      maxSearches: 5,
    })[0]!;
    const approval = tool.approval as {
      reason(ctx: { args: typeof args }): string;
    };

    expect(approval.reason({ args })).toContain(args.reason);
    expect(approval.reason({ args })).toMatch(/estimated cost\/latency/i);
    expect(approval.reason({ args })).toMatch(/7 agent turns/i);
    expect(approval.reason({ args })).toMatch(/5 retrieval calls/i);
  });

  it("stops the parent from starting another retrieval flow after rejection", () => {
    const { researcher } = makeResearcher();
    const tool = createDeepResearchTools({
      enabled: false,
      researcher,
    })[0]!;
    const approval = tool.approval as { rejectMessage?: string };

    expect(approval.rejectMessage).toMatch(/do not call.*(?:web_search|retrieval)/i);
  });

  it("bypasses approval when enabled or granted for the session", async () => {
    const { researcher } = makeResearcher();
    const enabledTool = createDeepResearchTools({
      enabled: true,
      researcher,
    })[0]!;
    const grantedTool = createDeepResearchTools({
      enabled: false,
      hasGrant: (toolName) => toolName === "deep_research",
      researcher,
    })[0]!;

    const enabledApproval = enabledTool.approval as { when(ctx: { args: typeof args }): Promise<boolean> };
    const grantedApproval = grantedTool.approval as { when(ctx: { args: typeof args }): Promise<boolean> };
    expect(await enabledApproval.when({ args })).toBe(false);
    expect(await grantedApproval.when({ args })).toBe(false);
  });

  it("delegates with streaming and configured bounds without exposing another delegate tool", async () => {
    const { researcher, asTool, call } = makeResearcher("report");
    const progress: DeepResearchProgress[] = [];
    const tools = createDeepResearchTools({
      enabled: true,
      researcher,
      maxTurns: 7,
      maxSearches: 5,
      onProgress: (event) => {
        progress.push(event);
      },
    });

    const output = await tools[0]!.call(args);

    expect(output).toBe("report");
    expect(asTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "deep_research_researcher",
        maxTurns: 7,
        stream: true,
      }),
    );
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Do not make more than 5 search or fetch calls"),
      }),
      expect.anything(),
    );
    expect(progress.map((event) => event.phase)).toEqual([
      "planning",
      "researching",
      "synthesizing",
      "completed",
    ]);
  });

  it("reports a failed lifecycle event and rethrows researcher failures", async () => {
    const { researcher, call } = makeResearcher();
    call.mockRejectedValueOnce(new Error("researcher failed"));
    const progress: DeepResearchProgress[] = [];
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
      onProgress: (event) => {
        progress.push(event);
      },
    })[0]!;

    await expect(tool.call(args)).rejects.toThrow("researcher failed");
    expect(progress.at(-1)).toMatchObject({ phase: "failed" });
  });
});

describe("buildDeepResearchPrompt", () => {
  it("requires a bounded, source-grounded report", () => {
    const prompt = buildDeepResearchPrompt(args.prompt, 4);
    expect(prompt).toContain(args.prompt);
    expect(prompt).toContain("Plan -> search documents/web -> analyze -> synthesize -> verify");
    expect(prompt).toContain("First, produce a numbered research plan");
    expect(prompt).toContain("Do not retrieve evidence before the plan");
    expect(prompt).toContain("Before finalizing, verify each material claim");
    expect(prompt).toContain("Do not make more than 4 search or fetch calls");
    expect(prompt).toContain("[[cite:N]]");
  });

  it("requires the parent to delegate first and preserve the citation contract", () => {
    expect(DEEP_RESEARCH_INSTRUCTION).toContain("before ordinary retrieval");
    expect(DEEP_RESEARCH_INSTRUCTION).toContain("preserve any [[cite:N]] markers");
    expect(DEEP_RESEARCH_INSTRUCTION).toContain("citations JSON trailer");
  });
});

describe("boundDeepResearchTools", () => {
  it("hard-stops retrieval calls after the shared search budget", async () => {
    const originalCall = vi.fn(async () => ({ results: ["evidence"] }));
    const wrapped = boundDeepResearchTools(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          call: originalCall,
        } as unknown as AnyTool,
      ],
      1,
    )[0]!;

    await wrapped.call({ query: "one" });
    const exhausted = await wrapped.call({ query: "two" });

    expect(originalCall).toHaveBeenCalledTimes(1);
    expect(exhausted).toMatchObject({ error: expect.stringContaining("budget exhausted") });
  });
});
