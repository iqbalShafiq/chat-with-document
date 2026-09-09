import { DataChart } from "#/components/data/data-chart";
import { chartEmbedIndex, parseChartSpec } from "#/lib/data-analysis";
import { useThreadChartSpec } from "#/components/data/chart-registry-context";

export function ChartEmbed({ index }: { index: number }) {
  const chart = useThreadChartSpec(index);
  const spec = chart === null ? null : parseChartSpec(chart);
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
