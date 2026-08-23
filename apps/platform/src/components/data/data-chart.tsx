import type { ChartSpec } from "#/lib/data-analysis";

const CHART_W = 320;
const CHART_H = 160;
const PAD = { top: 12, right: 12, bottom: 22, left: 36 };

export function DataChart({ spec }: { spec: ChartSpec }) {
  return (
    <div role="img" aria-label={describeSpec(spec)} className="w-full overflow-hidden rounded-lg border border-white/[0.06] p-2">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-auto w-full"
        aria-hidden="true"
      >
        {renderSpec(spec)}
      </svg>
    </div>
  );
}

function describeSpec(spec: ChartSpec): string {
  switch (spec.kind) {
    case "bar":
    case "line":
      return `${spec.kind} chart: ${spec.series.map((s) => `${s.name} (${s.values.join(", ")})`).join("; ")}`;
    case "scatter":
      return `scatter chart: ${spec.points.length} points`;
    case "histogram":
      return `histogram: ${spec.bins.map((b) => `${b.count}`).join(", ")}`;
  }
}

function renderSpec(spec: ChartSpec) {
  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom;
  switch (spec.kind) {
    case "bar": {
      const groupWidth = plotW / Math.max(1, spec.labels.length);
      const barWidth = Math.max(2, (groupWidth / spec.series.length) * 0.7);
      const seriesMax = Math.max(1, ...spec.series.flatMap((s) => s.values));
      return (
        <>
          {axes(spec.yLabel)}
          {spec.series.map((series) =>
            series.values.map((value, i) => {
              const h = (value / seriesMax) * plotH;
              const x = PAD.left + i * groupWidth + (spec.series.indexOf(series) + 0.15) * (groupWidth / spec.series.length);
              return <rect key={`${series.name}-${i}`} x={x} y={CHART_H - PAD.bottom - h} width={barWidth} height={h} rx={1} className="fill-accent/80" />;
            }),
          )}
          {spec.labels.map((label, i) => (
            <text key={`l-${i}`} x={PAD.left + i * groupWidth + groupWidth / 2} y={CHART_H - 8} textAnchor="middle" className="fill-text-faint" fontSize={8}>
              {short(label)}
            </text>
          ))}
        </>
      );
    }
    case "line": {
      const xMax = Math.max(1, spec.labels.length - 1);
      const seriesMax = Math.max(1, ...spec.series.flatMap((s) => s.values));
      return (
        <>
          {axes(spec.yLabel)}
          {spec.series.map((series) => {
            const points = series.values.map((value, i) => ({
              x: PAD.left + (i / xMax) * plotW,
              y: CHART_H - PAD.bottom - (value / seriesMax) * plotH,
            }));
            return (
              <polyline
                key={series.name}
                points={points.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none"
                strokeWidth={1.5}
                className="stroke-accent"
              />
            );
          })}
        </>
      );
    }
    case "scatter": {
      const xs = spec.points.map((p) => p.x);
      const ys = spec.points.map((p) => p.y);
      const xMax = Math.max(1, ...xs);
      const yMax = Math.max(1, ...ys);
      return (
        <>
          {axes(`${spec.yLabel ?? ""}`)}
          {spec.points.map((p, i) => (
            <circle
              key={i}
              cx={PAD.left + (p.x / xMax) * plotW}
              cy={CHART_H - PAD.bottom - (p.y / yMax) * plotH}
              r={2.5}
              className="fill-accent"
            />
          ))}
        </>
      );
    }
    case "histogram": {
      const maxCount = Math.max(1, ...spec.bins.map((b) => b.count));
      const binW = plotW / Math.max(1, spec.bins.length);
      return (
        <>
          {axes(spec.label)}
          {spec.bins.map((b, i) => {
            const h = (b.count / maxCount) * plotH;
            return (
              <rect
                key={i}
                x={PAD.left + i * binW + 1}
                y={CHART_H - PAD.bottom - h}
                width={Math.max(2, binW - 2)}
                height={h}
                rx={1}
                className="fill-accent/80"
              />
            );
          })}
        </>
      );
    }
  }
}

function axes(yLabel?: string) {
  return (
    <>
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={CHART_H - PAD.bottom} className="stroke-white/10" strokeWidth={1} />
      <line x1={PAD.left} y1={CHART_H - PAD.bottom} x2={CHART_W - PAD.right} y2={CHART_H - PAD.bottom} className="stroke-white/10" strokeWidth={1} />
      {yLabel ? (
        <text x={8} y={CHART_H / 2} textAnchor="middle" transform={`rotate(-90 8 ${CHART_H / 2})`} className="fill-text-faint" fontSize={8}>
          {yLabel}
        </text>
      ) : null}
    </>
  );
}

function short(value: string): string {
  return value.length > 10 ? `${value.slice(0, 9)}…` : value;
}