import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { FormTextField } from "#/components/ui/form-field";
import { Select } from "#/components/ui/select";
import { useUserMcpServers } from "#/hooks/use-user-mcp-servers";
import type { McpServerInput, McpTestResult, McpTestTool, UserMcpServer } from "#/lib/api";
import { issuesFromError, issuesToFieldErrors, type FieldErrors } from "#/components/skills/skill-issues";

type ReviewState = {
  tools: McpTestTool[];
  checked: string[];
  testedUrl: string;
} | null;

export function McpModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const servers = useUserMcpServers(open);
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleChanged = () => {
    setEditingId(undefined);
    onChanged();
  };

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="MCP servers"
      description="Connect external tools over Streamable HTTP. Test before saving."
      size="lg"
      heightMode="viewport"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {servers.loading ? (
          <div className="flex flex-col gap-3">
            <div className="skeleton-shimmer h-16 w-full rounded-xl" />
            <div className="skeleton-shimmer h-16 w-full rounded-xl" />
          </div>
        ) : servers.error && !servers.data ? (
          <p className="text-sm text-danger" role="alert">
            {servers.error}
          </p>
        ) : editingId !== undefined ? (
          <McpEditor
            key={editingId ?? "new"}
            initial={
              editingId
                ? (servers.data ?? []).find((server) => server.id === editingId) ?? null
                : null
            }
            saving={servers.saving}
            testing={servers.testing}
            onTest={(input) => servers.test(input)}
            onCancel={() => setEditingId(undefined)}
            onSave={async (input, review) => {
              await servers.save(editingId ?? null, {
                ...input,
                ...(review
                  ? {
                      allowedTools: review.checked,
                      tools: review.tools
                        .filter((tool) => review.checked.includes(tool.name))
                        .map((tool) => ({
                          name: tool.name,
                          description: tool.description,
                          parameters: tool.parameters ?? {},
                        })),
                    }
                  : {}),
              });
              handleChanged();
            }}
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-text-muted">
                {(servers.data ?? []).length === 0
                  ? "No servers yet — paste a URL to connect the first one."
                  : "Only https hosts. Tools are reviewed per server."}
              </p>
              <Button variant="primary" size="sm" onClick={() => setEditingId(null)}>
                <Plus className="size-4" strokeWidth={2} />
                New server
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {(servers.data ?? []).map((server) => (
                <li
                  key={server.id}
                  className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                >
                  <span
                    aria-hidden
                    className={`size-2 shrink-0 rounded-full ${server.status === "ok" ? "bg-emerald-400/80" : server.status === "error" ? "bg-danger" : "bg-white/30"}`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{server.name}</p>
                    <p className="truncate text-[11px] text-text-faint">
                      {server.status === "error" && server.lastError
                        ? server.lastError
                        : `${server.allowedTools.length} tools · ${server.isEnabled ? "enabled" : "disabled"}`}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.isEnabled}
                    aria-label={`Enable ${server.name}`}
                    title={server.isEnabled ? "Enabled" : "Disabled"}
                    onClick={() => {
                      void servers.toggle(server.id, !server.isEnabled).then(onChanged);
                    }}
                    className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${server.isEnabled ? "bg-accent/80" : "bg-white/12"}`}
                  >
                    <span
                      aria-hidden
                      className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${server.isEnabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${server.name}`}
                    title="Edit"
                    onClick={() => setEditingId(server.id)}
                    className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
                  >
                    <Pencil className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${server.name}`}
                    title="Delete"
                    onClick={() => setDeleteId(server.id)}
                    className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-danger-soft hover:text-danger active:scale-[0.96]"
                  >
                    <Trash2 className="size-4" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
            {servers.error ? (
              <p className="text-[11px] text-danger" role="alert">
                {servers.error}
              </p>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={deleteId !== null}
        title="Delete MCP server?"
        description="The agent will no longer see this server's tools. This cannot be undone."
        confirmLabel="Delete"
        busy={deleting}
        onCancel={() => {
          if (!deleting) setDeleteId(null);
        }}
        onConfirm={() => {
          if (!deleteId) return;
          setDeleting(true);
          void servers
            .remove(deleteId)
            .then(() => {
              setDeleteId(null);
              onChanged();
            })
            .catch(() => undefined)
            .finally(() => setDeleting(false));
        }}
      />
    </DialogShell>
  );
}

function McpEditor({
  initial,
  saving,
  testing,
  onTest,
  onCancel,
  onSave,
}: {
  initial: UserMcpServer | null;
  saving: boolean;
  testing: boolean;
  onTest: (input: McpServerInput) => Promise<McpTestResult>;
  onCancel: () => void;
  onSave: (
    input: McpServerInput,
    review: { checked: string[]; tools: McpTestTool[] } | null,
  ) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "https://");
  const [authType, setAuthType] = useState<"none" | "bearer">(initial?.authType ?? "none");
  const [token, setToken] = useState("");
  const [review, setReview] = useState<ReviewState>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const dirty = review !== null && review.testedUrl !== url.trim();
  const canKeepReview =
    initial !== null &&
    initial.status === "ok" &&
    initial.url === url.trim() &&
    initial.authType === authType &&
    token.trim().length === 0;

  const runTest = async () => {
    setTestError(null);
    setErrors({});
    try {
      const result = await onTest({
        name: name.trim() || "server",
        url: url.trim(),
        authType,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      if (result.ok) {
        setReview({ tools: result.tools, checked: result.tools.map((tool) => tool.name), testedUrl: url.trim() });
      } else {
        setReview(null);
        setTestError(result.error);
      }
    } catch (error) {
      setReview(null);
      setTestError(error instanceof Error ? error.message : "Connection failed");
    }
  };

  const toggleTool = (toolName: string) => {
    setReview((current) => {
      if (!current) return current;
      const checked = current.checked.includes(toolName)
        ? current.checked.filter((name) => name !== toolName)
        : [...current.checked, toolName];
      return { ...current, checked };
    });
  };

  const submit = async () => {
    setErrors({});
    const freshReview = review !== null && !dirty ? review : null;
    if (!freshReview && !canKeepReview) {
      setTestError("Test the connection first — saving needs a fresh tool review.");
      return;
    }
    if (freshReview && freshReview.checked.length === 0) {
      setTestError("Allow at least one tool.");
      return;
    }
    try {
      await onSave(
        {
          name: name.trim(),
          url: url.trim(),
          authType,
          ...(token.trim() ? { token: token.trim() } : {}),
        },
        freshReview ? { checked: freshReview.checked, tools: freshReview.tools } : null,
      );
    } catch (error) {
      setErrors(issuesToFieldErrors(issuesFromError(error)));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium text-text">
        {initial ? "Edit MCP server" : "New MCP server"}
      </h3>
      <FormTextField
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="docs"
        helper="Short label used for tool prefixes."
        error={errors.name ?? null}
        disabled={saving || testing}
      />
      <FormTextField
        label="Server URL"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder="https://mcp.example.com/mcp"
        helper="Public https Streamable HTTP endpoint. Private hosts are blocked."
        error={errors.form?.includes("URL") ? errors.form : null}
        disabled={saving || testing}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium tracking-wide text-text-muted">Auth</span>
        <Select
          value={authType}
          onChange={(value) => setAuthType(value === "bearer" ? "bearer" : "none")}
          options={[
            { value: "none", label: "None" },
            { value: "bearer", label: "Bearer token" },
          ]}
          ariaLabel="Authentication type"
          disabled={saving || testing}
        />
      </div>
      {authType === "bearer" ? (
        <FormTextField
          label="Token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={initial ? "Leave empty to keep the stored token" : "Bearer token"}
          helper="Stored server-side only, never shown again."
          optional
          disabled={saving || testing}
        />
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={saving || testing}>
          {testing ? "Testing…" : review && !dirty ? "Re-test" : "Test connection"}
        </Button>
        {dirty ? (
          <span className="text-[11px] text-text-faint">URL changed — re-test before saving.</span>
        ) : null}
      </div>
      {testError ? (
        <p className="text-[11px] text-danger" role="alert">
          {testError}
        </p>
      ) : null}
      {review && !dirty ? (
        <fieldset className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] p-3">
          <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Tools ({review.checked.length}/{review.tools.length} allowed)
          </legend>
          {review.tools.length === 0 ? (
            <p className="text-[11px] text-text-faint">This server exposes no tools.</p>
          ) : (
            review.tools.map((tool) => (
              <label
                key={tool.name}
                className="flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1 text-xs text-text transition hover:bg-white/[0.04]"
              >
                <input
                  type="checkbox"
                  checked={review.checked.includes(tool.name)}
                  onChange={() => toggleTool(tool.name)}
                  className="mt-0.5 accent-[var(--color-accent)]"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{tool.name}</span>
                  {tool.description ? (
                    <span className="block truncate text-text-faint">{tool.description}</span>
                  ) : null}
                </span>
              </label>
            ))
          )}
        </fieldset>
      ) : null}
      {errors.form && !errors.form.includes("URL") ? (
        <p className="text-[11px] text-danger" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving || testing}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving || testing}>
          {saving ? "Saving…" : initial ? "Save" : "Add server"}
        </Button>
      </div>
    </div>
  );
}
