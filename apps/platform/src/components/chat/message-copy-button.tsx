import { useMessage } from "@anvia/react-ui";
import { Check, Copy } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { AutoDismissPopover } from "#/components/ui/auto-dismiss-popover";
import { stripCitationsForCopy } from "#/lib/chat/citations";
import { getMessageRawText } from "#/lib/chat/message-text";

const ACTION_ICON_CLASS =
  "inline-flex cursor-pointer p-0 text-text-faint transition hover:text-text active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";

type CopyState = "idle" | "copied" | "error";

export function MessageCopyButton() {
  const { message } = useMessage();
  const rawText = getMessageRawText(message);
  const text = useMemo(() => {
    if (message.role === "assistant") return stripCitationsForCopy(rawText);
    return rawText;
  }, [message.role, rawText]);
  const disabled = text.trim().length === 0;
  const [state, setState] = useState<CopyState>("idle");
  const resetRef = useRef<number | null>(null);

  const handleDismiss = useCallback(() => {
    setState("idle");
  }, []);

  const handleClick = useCallback(async () => {
    if (disabled) return;

    if (resetRef.current !== null) {
      window.clearTimeout(resetRef.current);
      resetRef.current = null;
    }

    const writeText = navigator.clipboard?.writeText;
    if (writeText === undefined) {
      setState("error");
      resetRef.current = window.setTimeout(() => setState("idle"), 1800);
      return;
    }

    try {
      await writeText.call(navigator.clipboard, text);
      setState("copied");
    } catch {
      setState("error");
      resetRef.current = window.setTimeout(() => setState("idle"), 1800);
    }
  }, [disabled, text]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        className={ACTION_ICON_CLASS}
        aria-label={state === "copied" ? "Copied" : "Copy message"}
        title={state === "copied" ? "Copied" : "Copy"}
        disabled={disabled}
        data-state={state}
        onClick={() => {
          void handleClick();
        }}
      >
        {state === "copied" ? (
          <Check className="size-4 text-success" strokeWidth={1.75} />
        ) : (
          <Copy className="size-4" strokeWidth={1.75} />
        )}
      </button>
      <AutoDismissPopover
        open={state === "copied"}
        onDismiss={handleDismiss}
        durationMs={1800}
      >
        Copied
      </AutoDismissPopover>
      <AutoDismissPopover
        open={state === "error"}
        onDismiss={handleDismiss}
        durationMs={1800}
      >
        Copy failed
      </AutoDismissPopover>
    </span>
  );
}
