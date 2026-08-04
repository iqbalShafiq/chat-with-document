import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

export const BUTTON_BASE_CLASS =
  "inline-flex cursor-pointer items-center justify-center rounded-xl font-medium transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40";

export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-accent-hover",
  secondary: "text-text-muted hover:bg-white/8 hover:text-text",
  ghost: "text-text-faint hover:bg-white/[0.06] hover:text-text",
  danger: "text-text-faint hover:bg-danger-soft hover:text-danger",
};

export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "min-h-8 gap-1.5 px-2.5 text-xs",
  md: "min-h-9 gap-1.5 px-3.5 text-sm",
  icon: "size-9 rounded-lg",
};

/**
 * Shared button for dialogs, cards, and icon-only actions.
 * Use size="icon" with aria-label for icon-only buttons.
 */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <button
      type={type}
      className={[
        BUTTON_BASE_CLASS,
        BUTTON_VARIANT_CLASSES[variant],
        BUTTON_SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
