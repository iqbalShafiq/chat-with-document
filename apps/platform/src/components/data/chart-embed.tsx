import { useMemo } from "react";
import { useMessage } from "@anvia/react-ui";
import { DataChart } from "#/components/data/data-chart";
import { chartEmbedIndex, parseChartSpec } from "#/lib/data-analysis";
import { parseToolValue } from "#/components/tool-io-format";

function toolOutputOf(part: unknown): unknown {
  if (typeof part !== "object" || part === null) return undefined;
  const output = (part as { output?: unknown }).output;
  return output;
}

export function useMessageChartSpecs(): unknown[] {
  const { message } = useMessage();
  return useMemo(() => {
    const specs: unknown[] = [];
    for (const part of message.parts) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as { type?: unknown; state?: unknown };
      if (p.type !== "tool" || p.state !== "output-available") continue;
      const parsed = parseToolValue(toolOutputOf(part));
      if (typeof parsed !== "object" || parsed === null) continue;
      const chart = (parsed as Record<string, unknown>).chart;
      if (chart === undefined) continue;
      const spec = parseChartSpec(chart);
      if (spec) specs.push(chart);
    }
    return specs;
  }, [message.parts]);
}

export function ChartEmbed({ index }: { index: number }) {
  const specs = useMessageChartSpecs();
  const chart = specs[index - 1];
  const spec = chart === undefined ? null : parseChartSpec(chart);
  if (!spec) {
    return (
      <span className="text-text-faint" role="note">
        Chart {index} is not available.
      </span>
    );
  }
  return <DataChart spec={spec} />;
}

export function chartAltToIndex(alt: string | null | undefined): number | null {
  return chartEmbedIndex(alt);
}
