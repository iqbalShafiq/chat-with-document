/**
 * Shared action button styles for DialogShell footers and ConfirmDialog.
 * Keep visual language identical to chat send / library confirm.
 */

export const DIALOG_PRIMARY_BUTTON_CLASS =
  "inline-flex min-h-9 cursor-pointer items-center rounded-xl bg-accent px-3.5 text-sm font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40";

export const DIALOG_SECONDARY_BUTTON_CLASS =
  "inline-flex min-h-9 cursor-pointer items-center rounded-xl px-3.5 text-sm font-medium text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/8 hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40";
