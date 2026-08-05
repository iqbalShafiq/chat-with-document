import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

/** Shared control chrome (auth + workspace forms). */
export const FIELD_CONTROL_CLASS =
  "glass-field w-full rounded-xl px-3.5 py-2.5 text-sm text-text outline-none placeholder:text-text-faint disabled:cursor-not-allowed disabled:opacity-50";

type FieldChromeProps = {
  label: string;
  optional?: boolean;
  error?: string | null;
  helper?: string;
};

/**
 * Accessible text field: label above, helper/error below (APG form pattern).
 */
export const FormTextField = forwardRef<
  HTMLInputElement,
  FieldChromeProps &
    Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & {
      className?: string;
    }
>(function FormTextField(
  {
    label,
    optional = false,
    error,
    helper,
    id: idProp,
    className = "",
    ...props
  },
  ref,
) {
  const genId = useId();
  const id = idProp ?? genId;
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="text-xs font-medium tracking-wide text-text-muted"
      >
        {label}
        {optional ? (
          <span className="font-normal text-text-faint"> (optional)</span>
        ) : null}
      </label>
      <input
        ref={ref}
        id={id}
        className={`${FIELD_CONTROL_CLASS} ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : helper ? helperId : undefined}
        {...props}
      />
      {helper && !error ? (
        <p id={helperId} className="text-[11px] text-text-faint">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
});

/**
 * Accessible textarea field — same chrome as FormTextField.
 */
export function FormTextAreaField({
  label,
  optional = false,
  error,
  helper,
  id: idProp,
  className = "",
  ...props
}: FieldChromeProps &
  Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & {
    className?: string;
  }) {
  const genId = useId();
  const id = idProp ?? genId;
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium tracking-wide text-text-muted">
        {label}
        {optional ? (
          <span className="font-normal text-text-faint"> (optional)</span>
        ) : null}
      </label>
      <textarea
        id={id}
        className={`${FIELD_CONTROL_CLASS} resize-none ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : helper ? helperId : undefined}
        {...props}
      />
      {helper && !error ? (
        <p id={helperId} className="text-[11px] text-text-faint">
          {helper}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[11px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
