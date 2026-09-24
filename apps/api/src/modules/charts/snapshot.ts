export type ChartSpecInput =
  | { kind: "bar"; labels: string[]; series: Array<{ name: string; values: number[] }>; title?: string }
  | { kind: "line"; labels: string[]; series: Array<{ name: string; values: number[] }>; title?: string }
  | { kind: "pie"; labels: string[]; values: number[]; name?: string; title?: string }
  | { kind: "scatter"; points: Array<{ x: number; y: number }>; xLabel?: string; yLabel?: string; title?: string }
  | { kind: "histogram"; bins: number[]; label?: string; title?: string };

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const W = 640;
const H = 360;
const PAD = 44;

export function chartSpecToSvg(spec: ChartSpecInput): string {
  const title = spec.kind === "pie"
    ? (spec.title ?? spec.name ?? "")
    : "title" in spec
      ? (spec.title ?? "")
      : "";
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" role="img">` +
    (title ? `<title>${esc(title)}</title>` : "");
  if (spec.kind === "pie") return head + pieBody(spec) + "</svg>";
  if (spec.kind === "scatter") return head + scatterBody(spec) + "</svg>";
  if (spec.kind === "histogram") return head + histogramBody(spec) + "</svg>";
  return head + seriesBody(spec) + "</svg>";
}

function seriesBody(spec: Extract<ChartSpecInput, { kind: "bar" | "line" }>): string {
  const all = spec.series.flatMap((s) => s.values);
  const max = Math.max(1, ...all);
  const n = Math.max(1, spec.labels.length);
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  const colors = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa"];
  let body = `<rect x="${PAD}" y="16" width="${plotW}" height="${plotH}" fill="none" stroke="#e5e7eb"/>`;
  if (spec.kind === "bar") {
    const groupW = plotW / n;
    const barW = Math.max(4, groupW / (spec.series.length + 1));
    spec.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const h = (v / max) * plotH;
        const x = PAD + i * groupW + si * barW + 2;
        const y = 16 + plotH - h;
        body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[si % colors.length]}"><title>${esc(s.name)}: ${v}</title></rect>`;
      });
    });
  } else {
    spec.series.forEach((s, si) => {
      const pts = s.values.map((v, i) => {
        const x = PAD + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
        const y = 16 + plotH - (v / max) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
      body += `<polyline points="${pts.join(" ")}" fill="none" stroke="${colors[si % colors.length]}" stroke-width="2"/>`;
    });
  }
  spec.labels.forEach((label, i) => {
    const x = PAD + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    body += `<text x="${x.toFixed(1)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#6b7280">${esc(label)}</text>`;
  });
  return body;
}

function pieBody(spec: Extract<ChartSpecInput, { kind: "pie" }>): string {
  const total = spec.values.reduce((a, b) => a + b, 0) || 1;
  const cx = W / 2;
  const cy = H / 2 + 8;
  const r = 120;
  const colors = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa"];
  let angle = -Math.PI / 2;
  let body = "";
  spec.values.forEach((v, i) => {
    const frac = v / total;
    const a2 = angle + frac * Math.PI * 2;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    const large = frac > 0.5 ? 1 : 0;
    body += `<path d="M${cx},${cy} L${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${large},1 ${x2.toFixed(1)},${y2.toFixed(1)} Z" fill="${colors[i % colors.length]}"><title>${esc(spec.labels[i] ?? "")}: ${v}</title></path>`;
    angle = a2;
  });
  return body;
}

function scatterBody(spec: Extract<ChartSpecInput, { kind: "scatter" }>): string {
  const xs = spec.points.map((p) => p.x);
  const ys = spec.points.map((p) => p.y);
  const maxX = Math.max(1, ...xs);
  const maxY = Math.max(1, ...ys);
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  let body = `<rect x="${PAD}" y="16" width="${plotW}" height="${plotH}" fill="none" stroke="#e5e7eb"/>`;
  for (const p of spec.points.slice(0, 500)) {
    const x = PAD + (p.x / maxX) * plotW;
    const y = 16 + plotH - (p.y / maxY) * plotH;
    body += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#4f8cff"/>`;
  }
  return body;
}

function histogramBody(spec: Extract<ChartSpecInput, { kind: "histogram" }>): string {
  const max = Math.max(1, ...spec.bins);
  const plotW = W - PAD * 2;
  const plotH = H - PAD * 2;
  const bw = plotW / Math.max(1, spec.bins.length);
  let body = "";
  spec.bins.forEach((v, i) => {
    const h = (v / max) * plotH;
    body += `<rect x="${(PAD + i * bw + 1).toFixed(1)}" y="${(16 + plotH - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" fill="#4f8cff"/>`;
  });
  return body;
}
