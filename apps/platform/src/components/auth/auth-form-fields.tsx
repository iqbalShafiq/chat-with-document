import { Eye, EyeOff } from "lucide-react";
import { FIELD_CONTROL_CLASS } from "#/components/ui/form-field";
import { useId, useState, type InputHTMLAttributes } from "react";

const FIELD_CLASS = FIELD_CONTROL_CLASS;

export function AuthTextField({
  label,
  placeholder,
  error,
  helper,
  ...props
}: {
  label: string;
  /** Required for consistent empty-state guidance in auth forms. */
  placeholder: string;
  error?: string | null;
  helper?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "placeholder">) {
  const id = useId();
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  return (
    <label className="flex flex-col gap-1.5" htmlFor={id}>
      <span className="text-xs font-medium tracking-wide text-text-muted">
        {label}
      </span>
      <input
        id={id}
        className={FIELD_CLASS}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : helper ? helperId : undefined}
        {...props}
      />
      {helper && !error ? (
        <span id={helperId} className="text-[11px] text-text-faint">
          {helper}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="text-[11px] text-danger animate-fade-in">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function AuthPasswordField({
  label,
  placeholder,
  error,
  helper,
  ...props
}: {
  label: string;
  /** Required for consistent empty-state guidance in auth forms. */
  placeholder: string;
  error?: string | null;
  helper?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "placeholder">) {
  const id = useId();
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;
  const [visible, setVisible] = useState(false);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium tracking-wide text-text-muted">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          className={`${FIELD_CLASS} pr-11`}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : helper ? helperId : undefined}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-text-faint transition duration-160 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
          aria-label={visible ? "Hide password" : "Show password"}
        >
          {visible ? (
            <EyeOff className="size-4" strokeWidth={1.75} />
          ) : (
            <Eye className="size-4" strokeWidth={1.75} />
          )}
        </button>
      </div>
      {helper && !error ? (
        <span id={helperId} className="text-[11px] text-text-faint">
          {helper}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className="text-[11px] text-danger animate-fade-in">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export const AUTH_SUBMIT_CLASS =
  "inline-flex min-h-10 w-full cursor-pointer items-center justify-center rounded-xl bg-accent px-3.5 text-sm font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
