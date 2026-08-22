import type { TableDto } from "#/lib/data-analysis";

const TYPE_BADGES: Record<string, string> = {
  number: "num",
  string: "str",
  boolean: "bool",
};

export function DataTable({
  columns,
  rows,
  rowCount,
  truncated,
}: TableDto & { rowCount?: number; truncated?: boolean }) {
  const shown = rowCount ?? rows.length;
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-white/[0.06]">
      <table className="w-full border-collapse text-[12px]" aria-label="Data table">
        <thead className="sticky top-0 bg-canvas-elevated">
          <tr>
            {columns.map((col) => (
              <th
                key={col.name}
                className="whitespace-nowrap border-b border-white/[0.06] px-2 py-1.5 text-left font-medium text-text"
              >
                {col.name}
                <span className="ml-1 text-[9px] uppercase text-text-faint">
                  {TYPE_BADGES[col.type] ?? col.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="odd:bg-white/[0.015]">
              {columns.map((col, ci) => (
                <td key={col.name} className="border-b border-white/[0.04] px-2 py-1 text-text-muted">
                  {row[ci] === null ? "—" : String(row[ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p className="border-t border-white/[0.06] px-2 py-1 text-[10px] text-text-faint">
          Showing {rows.length} of {shown} rows
        </p>
      ) : null}
    </div>
  );
}