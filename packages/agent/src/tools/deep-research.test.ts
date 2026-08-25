import { describe, expect, it, vi } from "vitest";
import type {
  AnyTool,
  Tool,
  ToolApprovalContext,
  ToolApprovalRequirement,
} from "@anvia/core";
import {
  boundDeepResearchTools,
  buildDeepResearchPrompt,
  createDeepResearchCompletionGuard,
  createDeepResearchTools,
  DEEP_RESEARCH_INSTRUCTION,
  DEEP_RESEARCH_PARENT_SEAL_MESSAGE,
  sealRetrievalAfterDeepResearch,
  type DeepResearchProgress,
  type DeepResearchResearcher,
} from "./deep-research.js";

type Researcher = DeepResearchResearcher;

type DeepResearchApproval = (
  input: typeof args,
  context: ToolApprovalContext<typeof args>,
) =>
  | boolean
  | ToolApprovalRequirement
  | Promise<boolean | ToolApprovalRequirement>;

function makeResearcher(output = "[[cite:1]] Grounded findings") {
  const call = vi.fn(async () => output);
  const researcherTool = {
    name: "deep_research_researcher",
    definition: vi.fn(),
    call,
  } as unknown as Tool<{ prompt: string }, string>;
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

function approvalContext(): ToolApprovalContext<typeof args> {
  return {
    toolName: "deep_research",
    args,
    rawArgs: JSON.stringify(args),
    toolCallId: "tool-call-1",
    internalCallId: "internal-call-1",
    run: { agentId: "agent-1", runId: "run-1", sessionId: "session-1" },
  };
}

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
    expect(tools[0]!.requiresApproval).toBeTypeOf("function");
  });

  it("requires approval when the toggle is off and no session grant exists", async () => {
    const { researcher } = makeResearcher();
    const tools = createDeepResearchTools({
      enabled: false,
      hasGrant: () => false,
      researcher,
    });
    const requiresApproval = tools[0]!.requiresApproval as DeepResearchApproval;

    expect(await requiresApproval(args, approvalContext())).toMatchObject({
      reason: expect.stringContaining(args.reason),
    });
  });

  it("includes bounded cost and latency guidance in the approval reason", async () => {
    const { researcher } = makeResearcher();
    const tool = createDeepResearchTools({
      enabled: false,
      researcher,
      maxTurns: 7,
      maxSearches: 5,
    })[0]!;
    const requiresApproval = tool.requiresApproval as DeepResearchApproval;
    const requirement = await requiresApproval(args, approvalContext());

    expect(requirement).toMatchObject({
      reason: expect.stringContaining(args.reason),
    });
    expect((requirement as ToolApprovalRequirement).reason).toMatch(/estimated cost\/latency/i);
    expect((requirement as ToolApprovalRequirement).reason).toMatch(/7 agent turns/i);
    expect((requirement as ToolApprovalRequirement).reason).toMatch(/5 retrieval calls/i);
  });

  it("stops the parent from starting another retrieval flow after rejection", () => {
    expect(DEEP_RESEARCH_INSTRUCTION).toMatch(
      /denied.*do not call.*(?:web_search|retrieval)/i,
    );
  });

  it("stops the parent from starting another retrieval flow after deep_research returns", () => {
    expect(DEEP_RESEARCH_INSTRUCTION).toMatch(
      /After deep_research returns[\s\S]*do not call[\s\S]*web_search/i,
    );
    expect(DEEP_RESEARCH_INSTRUCTION).toMatch(
      /do not call deep_research again/i,
    );
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

    const enabledApproval = enabledTool.requiresApproval as DeepResearchApproval;
    const grantedApproval = grantedTool.requiresApproval as DeepResearchApproval;
    expect(await enabledApproval(args, approvalContext())).toBe(false);
    expect(await grantedApproval(args, approvalContext())).toBe(false);
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
        suspension: "reject",
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
    expect(progress.every((event) => !("prompt" in event))).toBe(true);
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

  it("returns a bounded seal instead of starting a second research run", async () => {
    const { researcher, call } = makeResearcher("report");
    const completionGuard = createDeepResearchCompletionGuard();
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
      completionGuard,
    })[0]!;

    await expect(tool.call(args)).resolves.toBe("report");
    await expect(tool.call(args)).resolves.toBe(DEEP_RESEARCH_PARENT_SEAL_MESSAGE);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("seals parent retrieval after a hung researcher times out", async () => {
    const { researcher, call } = makeResearcher();
    call.mockImplementationOnce(
      async (_input, context: { abortSignal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const signal = context.abortSignal;
          expect(signal).toBeDefined();
          signal!.addEventListener(
            "abort",
            () => reject(signal!.reason),
            { once: true },
          );
        }),
    );
    const completionGuard = createDeepResearchCompletionGuard();
    const originalSearch = vi.fn(async () => ({ results: ["should not run"] }));
    const [webSearch] = sealRetrievalAfterDeepResearch(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          requiresApproval: vi.fn(async () => ({ reason: "needs approval" })),
          call: originalSearch,
        } as unknown as AnyTool,
      ],
      completionGuard,
    );
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
      maxDurationMs: 20,
      completionGuard,
    })[0]!;

    await expect(tool.call(args)).rejects.toThrow(
      "Deep Research exceeded its wall-clock budget",
    );
    expect(await webSearch!.requiresApproval?.(args, approvalContext())).toBe(
      false,
    );
    await expect(webSearch!.call({ query: "independent check" })).resolves.toEqual({
      error: DEEP_RESEARCH_PARENT_SEAL_MESSAGE,
    });
    expect(originalSearch).not.toHaveBeenCalled();
  });

  it("aborts a hung nested researcher at the wall-clock budget", async () => {
    const { researcher, call } = makeResearcher();
    call.mockImplementationOnce(
      async (_input, context: { abortSignal?: AbortSignal }) =>
        await new Promise<string>((_resolve, reject) => {
          const signal = context.abortSignal;
          expect(signal).toBeDefined();
          signal!.addEventListener(
            "abort",
            () => reject(signal!.reason),
            { once: true },
          );
        }),
    );
    const progress: DeepResearchProgress[] = [];
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
      maxDurationMs: 20,
      onProgress: (event) => progress.push(event),
    })[0]!;

    await expect(tool.call(args)).rejects.toThrow(
      "Deep Research exceeded its wall-clock budget",
    );
    expect(progress.at(-1)).toMatchObject({ phase: "failed" });
  });

  it("rejects a leaked child interaction through the outer output schema", async () => {
    const { researcher, call } = makeResearcher();
    call.mockResolvedValueOnce({
      type: "interaction",
      continuation: { privateRuntimeState: true },
    } as never);
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
    })[0]!;

    await expect(tool.call(args)).rejects.toThrow();
  });

  it("turns a child suspension into a bounded tool failure without returning a continuation", async () => {
    const suspension = new Error("Nested agent interaction was rejected");
    suspension.name = "AgentToolSuspensionError";
    const { researcher, call } = makeResearcher();
    call.mockRejectedValueOnce(suspension);
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
    })[0]!;

    await expect(tool.call(args)).rejects.toMatchObject({
      name: "AgentToolSuspensionError",
      message: "Nested agent interaction was rejected",
    });
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

describe("sealRetrievalAfterDeepResearch", () => {
  it("leaves parent retrieval unchanged until Deep Research starts", async () => {
    const guard = createDeepResearchCompletionGuard();
    const originalCall = vi.fn(async () => ({ results: ["live"] }));
    const requiresApproval = vi.fn(async () => ({ reason: "needs approval" }));
    const [webSearch] = sealRetrievalAfterDeepResearch(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          requiresApproval,
          call: originalCall,
        } as unknown as AnyTool,
      ],
      guard,
    );

    expect(await webSearch!.requiresApproval?.(args, approvalContext())).toEqual({
      reason: "needs approval",
    });
    await expect(webSearch!.call({ query: "live" })).resolves.toEqual({
      results: ["live"],
    });
    expect(originalCall).toHaveBeenCalledTimes(1);
  });

  it("skips parent approval and refuses retrieval after Deep Research starts", async () => {
    const { researcher } = makeResearcher("report");
    const guard = createDeepResearchCompletionGuard();
    const originalCall = vi.fn(async () => ({ results: ["should not run"] }));
    const requiresApproval = vi.fn(async () => ({ reason: "needs approval" }));
    const [webSearch] = sealRetrievalAfterDeepResearch(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          requiresApproval,
          call: originalCall,
        } as unknown as AnyTool,
      ],
      guard,
    );
    const tool = createDeepResearchTools({
      enabled: true,
      researcher,
      completionGuard: guard,
    })[0]!;

    await tool.call(args);

    expect(await webSearch!.requiresApproval?.(args, approvalContext())).toBe(
      false,
    );
    expect(requiresApproval).not.toHaveBeenCalled();
    await expect(webSearch!.call({ query: "independent check" })).resolves.toEqual({
      error: DEEP_RESEARCH_PARENT_SEAL_MESSAGE,
    });
    expect(originalCall).not.toHaveBeenCalled();
  });

  it("does not seal nested researcher tool instances", async () => {
    const guard = createDeepResearchCompletionGuard();
    const nestedCall = vi.fn(async () => ({ results: ["nested"] }));
    const parentCall = vi.fn(async () => ({ results: ["parent"] }));
    const nested = {
      name: "web_search",
      definition: vi.fn(),
      call: nestedCall,
    } as unknown as AnyTool;
    const [parent] = sealRetrievalAfterDeepResearch(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          call: parentCall,
        } as unknown as AnyTool,
      ],
      guard,
    );

    guard.markCompleted();
    await expect(nested.call({ query: "nested" })).resolves.toEqual({
      results: ["nested"],
    });
    await expect(parent!.call({ query: "parent" })).resolves.toEqual({
      error: DEEP_RESEARCH_PARENT_SEAL_MESSAGE,
    });
    expect(parentCall).not.toHaveBeenCalled();
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

  it.each(["find_documents", "get_document_page_images"])(
    "counts %s against the same retrieval budget",
    async (toolName) => {
      const originalCall = vi.fn(async () => ({ results: ["evidence"] }));
      const wrapped = boundDeepResearchTools(
        [
          {
            name: toolName,
            definition: vi.fn(),
            call: originalCall,
          } as unknown as AnyTool,
        ],
        1,
      )[0]!;

      await wrapped.call({});
      const exhausted = await wrapped.call({});

      expect(originalCall).toHaveBeenCalledTimes(1);
      expect(exhausted).toMatchObject({
        error: expect.stringContaining("budget exhausted"),
      });
    },
  );

  it("reports safe retrieval activity without exposing tool arguments", async () => {
    const progress: DeepResearchProgress[] = [];
    const wrapped = boundDeepResearchTools(
      [
        {
          name: "web_search",
          definition: vi.fn(),
          call: vi.fn(async () => ({ results: ["evidence"] })),
        } as unknown as AnyTool,
      ],
      3,
      (event) => {
        progress.push(event);
      },
    )[0]!;

    await wrapped.call({ query: "private query should never be streamed" });

    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({
      phase: "researching",
      activities: [
        {
          kind: "retrieval",
          label: "Searching the web",
          status: "active",
        },
      ],
      stats: { retrievalCalls: 1, retrievalLimit: 3 },
    });
    expect(progress[1]).toMatchObject({
      activities: [{ status: "done", label: "Searching the web" }],
    });
    expect(JSON.stringify(progress)).not.toContain("private query");
  });

  it("reports failed safe activity without changing the tool error", async () => {
    const progress: DeepResearchProgress[] = [];
    const wrapped = boundDeepResearchTools(
      [
        {
          name: "descriptive_stats",
          definition: vi.fn(),
          call: vi.fn(async () => {
            throw new Error("analysis failed");
          }),
        } as unknown as AnyTool,
      ],
      3,
      (event) => {
        progress.push(event);
      },
    )[0]!;

    await expect(wrapped.call({ dataset: "private.csv" })).rejects.toThrow(
      "analysis failed",
    );

    expect(progress.at(-1)).toMatchObject({
      phase: "researching",
      activities: [{ kind: "analysis", status: "failed" }],
    });
    expect(JSON.stringify(progress)).not.toContain("private.csv");
  });
});
