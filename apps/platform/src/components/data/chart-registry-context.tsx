import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { UIMessage } from "@anvia/client";
import { useMessage } from "@anvia/react-ui";
import { extractDatasetChartBlocks, parseChartSpec } from "#/lib/data-analysis";
import { parseToolValue } from "#/components/tool-io-format";

function chartsInPart(part: unknown, specs: unknown[]): void {
  if (typeof part !== "object" || part === null) return;
  const p = part as { type?: unknown; state?: unknown; output?: unknown };
  if (p.type !== "tool" || p.state !== "output-available") return;
  const parsed = parseToolValue(p.output);
  if (typeof parsed === "string") {
    for (const chart of extractDatasetChartBlocks(parsed)) specs.push(chart);
    return;
  }
  if (typeof parsed !== "object" || parsed === null) return;
  const chart = (parsed as Record<string, unknown>).chart;
  if (chart !== undefined && parseChartSpec(chart)) specs.push(chart);
  for (const nested of extractDatasetChartBlocks((parsed as Record<string, unknown>).report)
    .concat(extractDatasetChartBlocks((parsed as Record<string, unknown>).text))) {
    specs.push(nested);
  }
}

/** Charts for one assistant message: tool `.chart` fields, then dataset-chart fences. */
export function collectMessageChartSpecs(message: UIMessage): unknown[] {
  const specs: unknown[] = [];
  for (const part of message.parts) chartsInPart(part, specs);
  return specs;
}

export function collectThreadChartSpecs(messages: readonly UIMessage[]): unknown[] {
  const specs: unknown[] = [];
  for (const message of messages) specs.push(...collectMessageChartSpecs(message));
  return specs;
}

/**
 * Charts in the current agent turn: after the latest user message, through
 * `currentId`. A turn often splits tools and answer text across UIMessages.
 */
export function collectTurnChartSpecs(
  messages: readonly UIMessage[],
  currentId: string | undefined,
): unknown[] {
  if (!currentId) return [];
  const currentIndex = messages.findIndex((message) => message.id === currentId);
  if (currentIndex < 0) return [];
  let start = currentIndex;
  while (start > 0 && messages[start]!.role !== "user") {
    if (messages[start - 1]!.role === "user") break;
    start -= 1;
  }
  if (messages[start]?.role === "user") start += 1;
  const specs: unknown[] = [];
  for (let i = start; i <= currentIndex; i += 1) {
    specs.push(...collectMessageChartSpecs(messages[i]!));
  }
  return specs;
}

const ChartRegistryContext = createContext<readonly UIMessage[]>([]);

export function ChartRegistryProvider({
  messages,
  children,
}: {
  messages: readonly UIMessage[];
  children: ReactNode;
}) {
  return (
    <ChartRegistryContext.Provider value={messages}>
      {children}
    </ChartRegistryContext.Provider>
  );
}

export function useThreadChartSpecs(): readonly unknown[] {
  const messages = useContext(ChartRegistryContext);
  const { message } = useMessage();
  return useMemo(
    () => collectTurnChartSpecs(messages, message?.id),
    [messages, message?.id],
  );
}

export function useThreadChartSpec(index: number): unknown | null {
  const specs = useThreadChartSpecs();
  return specs[index - 1] ?? null;
}
