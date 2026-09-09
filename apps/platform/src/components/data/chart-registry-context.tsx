import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { UIMessage } from "@anvia/client";
import { parseChartSpec } from "#/lib/data-analysis";
import { parseToolValue } from "#/components/tool-io-format";

function chartsInPart(part: unknown, specs: unknown[]): void {
  if (typeof part !== "object" || part === null) return;
  const p = part as { type?: unknown; state?: unknown; output?: unknown };
  if (p.type !== "tool" || p.state !== "output-available") return;
  const parsed = parseToolValue(p.output);
  if (typeof parsed !== "object" || parsed === null) return;
  const chart = (parsed as Record<string, unknown>).chart;
  if (chart === undefined) return;
  if (parseChartSpec(chart)) specs.push(chart);
}

export function collectThreadChartSpecs(messages: readonly UIMessage[]): unknown[] {
  const specs: unknown[] = [];
  for (const message of messages) {
    for (const part of message.parts) chartsInPart(part, specs);
  }
  return specs;
}

const ChartRegistryContext = createContext<readonly unknown[]>([]);

export function ChartRegistryProvider({
  messages,
  children,
}: {
  messages: readonly UIMessage[];
  children: ReactNode;
}) {
  const specs = useMemo(() => collectThreadChartSpecs(messages), [messages]);
  return (
    <ChartRegistryContext.Provider value={specs}>
      {children}
    </ChartRegistryContext.Provider>
  );
}

export function useThreadChartSpecs(): readonly unknown[] {
  return useContext(ChartRegistryContext);
}

export function useThreadChartSpec(index: number): unknown | null {
  const specs = useContext(ChartRegistryContext);
  return specs[index - 1] ?? null;
}
