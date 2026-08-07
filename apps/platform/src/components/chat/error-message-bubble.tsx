import { AlertCircle } from "lucide-react";

export function ErrorMessageBubble({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}
