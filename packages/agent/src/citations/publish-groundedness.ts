import type { LangfuseTracing } from "@anvia/langfuse";
import {
  evaluateCitationGroundedness,
  type CitationGroundedness,
} from "./parse-citations.js";

export type PublishGroundednessResult = {
  groundedness: CitationGroundedness;
  published: boolean;
};

/**
 * Publish a numeric `citation_groundedness` score (0–1) to Langfuse when
 * the answer contains citation signals. No-ops when there is nothing to score
 * or when Langfuse credentials are unavailable.
 */
export async function publishCitationGroundedness(opts: {
  tracing: LangfuseTracing;
  rawAssistantText: string;
  sessionId?: string;
}): Promise<PublishGroundednessResult> {
  const groundedness = evaluateCitationGroundedness(opts.rawAssistantText);

  if (!groundedness.hasAnySignal || groundedness.score === null) {
    return { groundedness, published: false };
  }

  const trace = opts.tracing.getCurrentTrace?.();
  const metadata = {
    markerCount: groundedness.markerCount,
    trailerCount: groundedness.trailerCount,
    matchedCount: groundedness.matchedIds.length,
    orphanMarkerCount: groundedness.orphanMarkerIds.length,
    orphanTrailerCount: groundedness.orphanTrailerIds.length,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };

  try {
    await opts.tracing.score({
      ...(trace?.traceId ? { traceId: trace.traceId } : {}),
      name: "citation_groundedness",
      value: groundedness.score,
      dataType: "NUMERIC",
      comment:
        groundedness.orphanMarkerIds.length === 0 &&
        groundedness.orphanTrailerIds.length === 0
          ? "Markers and trailer fully aligned"
          : "Partial citation alignment",
      metadata,
    });

    trace?.addEvent?.("citations.scored", {
      score: groundedness.score,
      ...metadata,
    });

    return { groundedness, published: true };
  } catch (error) {
    console.warn("[citations] failed to publish groundedness score", error);
    return { groundedness, published: false };
  }
}
