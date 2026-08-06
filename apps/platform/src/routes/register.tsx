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
import { AuthShell } from "#/components/auth/auth-shell";
import { authClient } from "#/lib/auth-client";
import {
  clearStoredSessionId,
  createSessionId,
  persistSessionId,
} from "#/lib/session-storage";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
  beforeLoad: async () => {
    const session = await authClient.getSession();
    if (session.data?.user) {
      throw redirect({ to: "/" });
    }
  },
});

function RegisterPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);

    const nextName = name.trim();
    const nextEmail = email.trim();
    let valid = true;

    if (nextName.length < 1) {
      setNameError("Name is required");
      valid = false;
    } else {
      setNameError(null);
    }
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
    if (confirm !== password) {
      setConfirmError("Passwords do not match");
      valid = false;
    } else {
      setConfirmError(null);
    }
    if (!valid) return;

    setBusy(true);
    try {
      const result = await authClient.signUp.email({
        name: nextName,
        email: nextEmail,
        password,
      });
      if (result.error) {
        setFormError(
          result.error.message || "Could not create account. Try another email.",
        );
        return;
      }

      clearStoredSessionId();
      persistSessionId(createSessionId());
      await navigate({ to: "/" });
    } catch {
      setFormError("Could not register. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Register with email and password. Documents and chats stay on your account only."
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            search={{ redirect: undefined }}
            className="font-medium text-accent transition hover:text-accent-hover"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <AuthTextField
          label="Name"
          type="text"
          placeholder="Your name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          disabled={busy}
          required
        />
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
          placeholder="At least 8 characters"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={passwordError}
          helper="At least 8 characters"
          disabled={busy}
          required
        />
        <AuthPasswordField
          label="Confirm password"
          placeholder="Re-enter your password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirmError}
          disabled={busy}
          required
        />

        {formError ? (
          <div
            role="alert"
            className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger animate-fade-in"
          >
            {formError}
          </div>
        ) : null}

        <button type="submit" className={AUTH_SUBMIT_CLASS} disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthShell>
  );
}
