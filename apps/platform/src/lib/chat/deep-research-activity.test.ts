import { describe, expect, it } from "vitest";
import {
  deepResearchActivityStatusLabel,
  deepResearchPhaseLabel,
  initialDeepResearchActivityState,
  reduceDeepResearchProgress,
  resetDeepResearchActivity,
} from "./deep-research-activity";

describe("deep research activity state", () => {
  it("maps internal phases and statuses to user-facing labels", () => {
    expect(deepResearchPhaseLabel("planning")).toBe("Planning research");
    expect(deepResearchPhaseLabel("researching")).toBe("Researching sources");
    expect(deepResearchPhaseLabel("synthesizing")).toBe("Preparing the report");
    expect(deepResearchPhaseLabel("completed")).toBe("Research complete");
    expect(deepResearchPhaseLabel("failed")).toBe("Research stopped");
    expect(deepResearchActivityStatusLabel("active")).toBe("In progress");
    expect(deepResearchActivityStatusLabel("done")).toBe("Done");
    expect(deepResearchActivityStatusLabel("failed")).toBe("Could not complete");
  });

  it("starts with no visible activity", () => {
    expect(initialDeepResearchActivityState).toEqual({
      phase: "idle",
      message: "",
      activities: [],
      retrievalCalls: 0,
      retrievalLimit: 0,
    });
  });

  it("resets activity when a new planning run begins", () => {
    const previous = reduceDeepResearchProgress(
      {
        phase: "researching",
        message: "Searching the web…",
        activities: [
          {
            id: "old",
            kind: "retrieval",
            label: "Searching the web",
            status: "done",
          },
        ],
        retrievalCalls: 1,
        retrievalLimit: 8,
      },
      {
        phase: "planning",
        message: "Planning the research",
        activities: [
          {
            id: "planning",
            kind: "planning",
            label: "Planning the research",
            status: "active",
          },
        ],
      },
    );

    expect(previous.activities).toHaveLength(1);
    expect(previous.activities[0]?.id).toBe("planning");
    expect(previous.retrievalCalls).toBe(0);
  });

  it("updates an activity by id and preserves safe counters", () => {
    const started = reduceDeepResearchProgress(
      initialDeepResearchActivityState,
      {
        phase: "researching",
        message: "Searching the web…",
        activities: [
          {
            id: "search-1",
            kind: "retrieval",
            label: "Searching the web",
            status: "active",
          },
        ],
        stats: { retrievalCalls: 1, retrievalLimit: 4 },
      },
    );
    const completed = reduceDeepResearchProgress(started, {
      phase: "researching",
      message: "Searching the web complete",
      activities: [
        {
          id: "search-1",
          kind: "retrieval",
          label: "Searching the web",
          status: "done",
        },
      ],
      stats: { retrievalCalls: 1, retrievalLimit: 4 },
    });

    expect(completed.activities).toEqual([
      {
        id: "search-1",
        kind: "retrieval",
        label: "Searching the web",
        status: "done",
      },
    ]);
    expect(completed.retrievalCalls).toBe(1);
    expect(completed.retrievalLimit).toBe(4);
  });

  it("keeps only the twelve most recent activity records", () => {
    let state = initialDeepResearchActivityState;
    for (let index = 0; index < 14; index += 1) {
      state = reduceDeepResearchProgress(state, {
        phase: "researching",
        message: `Activity ${index}`,
        activities: [
          {
            id: `activity-${index}`,
            kind: "analysis",
            label: "Analyzing the dataset",
            status: "done",
          },
        ],
      });
    }

    expect(state.activities).toHaveLength(12);
    expect(state.activities[0]?.id).toBe("activity-2");
    expect(state.activities.at(-1)?.id).toBe("activity-13");
  });

  it("ignores malformed stream records and can reset cleanly", () => {
    const unchanged = reduceDeepResearchProgress(
      initialDeepResearchActivityState,
      { phase: "unknown", message: "not valid" },
    );

    expect(unchanged).toEqual(initialDeepResearchActivityState);
    expect(resetDeepResearchActivity()).toEqual(
      initialDeepResearchActivityState,
    );
  });

  it("ignores untrusted labels and messages", () => {
    const state = reduceDeepResearchProgress(
      initialDeepResearchActivityState,
      {
        phase: "researching",
        message: "raw prompt or tool arguments",
        activities: [
          {
            id: "activity-1",
            kind: "retrieval",
            label: "https://secret.example/search?q=private",
            status: "active",
          },
          {
            id: "activity-2",
            kind: "retrieval",
            label: "Searching the web",
            status: "active",
          },
        ],
        stats: { retrievalCalls: 1, retrievalLimit: 4 },
      },
    );

    expect(state.message).toBe("Searching the web…");
    expect(state.activities).toEqual([
      {
        id: "activity-2",
        kind: "retrieval",
        label: "Searching the web",
        status: "active",
      },
    ]);
  });

  it("keeps retrieval counters monotonic and within the limit", () => {
    const started = reduceDeepResearchProgress(
      initialDeepResearchActivityState,
      {
        phase: "researching",
        message: "Searching the web",
        stats: { retrievalCalls: 3, retrievalLimit: 4 },
      },
    );
    const malformed = reduceDeepResearchProgress(started, {
      phase: "researching",
      message: "malformed",
      stats: { retrievalCalls: 1, retrievalLimit: 2 },
    });

    expect(malformed.retrievalCalls).toBe(3);
    expect(malformed.retrievalLimit).toBe(4);
  });
});
