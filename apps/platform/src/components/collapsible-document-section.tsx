import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

export function CollapsibleDocumentSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className="flex flex-col px-0.5">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-7 w-fit max-w-full cursor-pointer items-center gap-1 rounded-md px-1 text-left text-[11px] font-medium leading-none text-text-faint transition hover:bg-surface hover:text-text-muted active:scale-[0.99]"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
        <span>{title}</span>
      </button>

      <div
        id={panelId}
        className={`doc-collapse-panel grid min-w-0 transition-[grid-template-rows,opacity,margin] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
          open
            ? "mt-1.5 grid-rows-[1fr] opacity-100"
            : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
        }`}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={`min-w-0 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
              open ? "translate-y-0" : "-translate-y-1"
            }`}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
