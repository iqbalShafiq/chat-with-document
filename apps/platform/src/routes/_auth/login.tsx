import {
  createFileRoute,
  Link,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import {
  AUTH_SUBMIT_CLASS,
  AuthPasswordField,
  AuthTextField,
} from "#/components/auth/auth-form-fields";
import { AuthFormPanel } from "#/components/auth/auth-shell";
import { authClient } from "#/lib/auth-client";
import {
  clearStoredSessionId,
  createSessionId,
  persistSessionId,
} from "#/lib/session-storage";

export const Route = createFileRoute("/_auth/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) => ({
    redirect:
      typeof search.redirect === "string" && search.redirect.startsWith("/")
        ? search.redirect
        : undefined,
  }),
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data?.user) {
      throw redirect({ to: "/", viewTransition: true });
    }
  },
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const nextEmail = email.trim();
    let valid = true;
    if (!nextEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setEmailError("Enter a valid email address");
      valid = false;
    } else {
      setEmailError(null);
    }
    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters");
      valid = false;
    } else {
      setPasswordError(null);
    }
    if (!valid) return;

    setBusy(true);
    try {
      const result = await authClient.signIn.email({
        email: nextEmail,
        password,
      });
      if (result.error) {
        setFormError(
          result.error.message || "Invalid email or password",
        );
        return;
      }

      clearStoredSessionId();
      persistSessionId(createSessionId());
      // View transition: shared sidebar/topbar morph into the chat shell.
      await navigate({ to: redirect ?? "/", viewTransition: true });
    } catch {
      setFormError("Could not sign in. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFormPanel
      title="Sign in"
      subtitle="Use the email and password for your DocChat workspace."
      footer={
        <>
          New here?{" "}
          <Link
            to="/register"
            className="font-medium text-accent transition hover:text-accent-hover"
          >
            Create an account
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <AuthTextField
          label="Email"
          type="email"
          placeholder="you@company.com"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
          disabled={busy}
          required
        />
        <AuthPasswordField
          label="Password"
          placeholder="Your password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={passwordError}
          disabled={busy}
          required
        />

        {formError ? (
          <div
            role="alert"
            className="rounded-2xl bg-danger-soft px-3.5 py-2.5 text-sm text-danger animate-fade-in"
          >
            {formError}
          </div>
        ) : null}

        <button
          type="submit"
          className={`${AUTH_SUBMIT_CLASS} mt-1`}
          disabled={busy}
        >
          {busy ? "Signing in…" : "Continue"}
        </button>
      </form>
    </AuthFormPanel>
  );
}
