import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { FormTextField } from "#/components/ui/form-field";
import { ManagementRow } from "#/components/ui/management-row";
import { InsetScrollbar } from "#/components/chat/inset-scrollbar";
import { Select } from "#/components/ui/select";
import { useUserMcpServers } from "#/hooks/use-user-mcp-servers";
import type {
  McpHeaderInput,
  McpServerInput,
  McpTestResult,
  McpTestTool,
  UserMcpServer,
} from "#/lib/api";
import { issuesFromError, issuesToFieldErrors, type FieldErrors } from "#/components/skills/skill-issues";
import { shouldReturnToList } from "#/components/skills/modal-navigation";

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
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const editorSaveRef = useRef<() => void>(() => {});
  const [editorBusy, setEditorBusy] = useState(false);

  const handleChanged = () => {
    setEditingId(undefined);
    onChanged();
  };

  return (
    <DialogShell
      open={open}
      onClose={() => {
        if (shouldReturnToList(editingId)) {
          setEditingId(undefined);
        } else {
          onClose();
        }
      }}
      title="MCP servers"
      description="Connect external tools over Streamable HTTP. Test before saving."
      size="lg"
      heightMode="viewport"
      footer={
        editingId !== undefined ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditingId(undefined)}
              disabled={editorBusy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => editorSaveRef.current()}
              disabled={editorBusy}
            >
              {editorBusy ? "Saving…" : editingId ? "Save" : "Add server"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={contentScrollRef}
          className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-4"
        >
          <div className="flex flex-col gap-3">
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
                saveRef={editorSaveRef}
                onBusyChange={setEditorBusy}
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
                    <ManagementRow
                      key={server.id}
                      title={server.name}
                      subtitle={
                        server.status === "error" && server.lastError
                          ? server.lastError
                          : `${server.allowedTools.length} tools · ${server.isEnabled ? "enabled" : "disabled"}`
                      }
                      leading={
                        <span
                          aria-hidden
                          className={`size-2 shrink-0 rounded-full ${server.status === "ok" ? "bg-emerald-400/80" : server.status === "error" ? "bg-danger" : "bg-white/30"}`}
                        />
                      }
                      enabled={server.isEnabled}
                      onToggle={() => {
                        void servers.toggle(server.id, !server.isEnabled).then(onChanged);
                      }}
                      toggleLabel={`Enable ${server.name}`}
                      toggleTitle={server.isEnabled ? "Enabled" : "Disabled"}
                      onEdit={() => setEditingId(server.id)}
                      editLabel={`Edit ${server.name}`}
                      onDelete={() => setDeleteId(server.id)}
                      deleteLabel={`Delete ${server.name}`}
                    />
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
        </div>
        <InsetScrollbar
          scrollRef={contentScrollRef}
          top="0.75rem"
          bottom="0.75rem"
        />
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
  saveRef,
  onBusyChange,
  onSave,
}: {
  initial: UserMcpServer | null;
  saving: boolean;
  testing: boolean;
  onTest: (input: McpServerInput) => Promise<McpTestResult>;
  saveRef: { current: () => void };
  onBusyChange: (busy: boolean) => void;
  onSave: (
    input: McpServerInput,
    review: { checked: string[]; tools: McpTestTool[] } | null,
  ) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "https://");
  const [authType, setAuthType] = useState<"none" | "bearer">(initial?.authType ?? "none");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<McpHeaderInput[]>([]);
  const [headersTouched, setHeadersTouched] = useState(false);
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
        ...(headers.length > 0 ? { headers } : {}),
        ...(initial ? { serverId: initial.id } : {}),
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
          ...(headersTouched ? { headers } : {}),
        },
        freshReview ? { checked: freshReview.checked, tools: freshReview.tools } : null,
      );
    } catch (error) {
      setErrors(issuesToFieldErrors(issuesFromError(error)));
    }
  };

  const addHeader = () => {
    setHeaders((current) => [...current, { name: "", value: "" }]);
    setHeadersTouched(true);
  };

  const updateHeader = (index: number, patch: Partial<McpHeaderInput>) => {
    setHeaders((current) =>
      current.map((header, i) => (i === index ? { ...header, ...patch } : header)),
    );
    setHeadersTouched(true);
  };

  const removeHeader = (index: number) => {
    setHeaders((current) => current.filter((_, i) => i !== index));
    setHeadersTouched(true);
  };

  saveRef.current = () => void submit();
  useEffect(() => {
    onBusyChange(saving || testing);
  }, [saving, testing, onBusyChange]);

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
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
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
          <Button
            variant="primary"
            size="sm"
            onClick={() => void runTest()}
            disabled={saving || testing}
            className="shrink-0"
          >
            {testing ? "Testing…" : review && !dirty ? "Re-test" : "Test connection"}
          </Button>
        </div>
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
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="px-1 text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Custom headers
          </span>
          <Button variant="ghost" size="sm" onClick={addHeader} disabled={saving || testing}>
            Add header
          </Button>
        </div>
        {initial?.hasHeaders && !headersTouched ? (
          <p className="text-[11px] text-text-faint">
            Stored headers are kept. Add, edit, or remove a row to replace them.
          </p>
        ) : null}
        {headers.map((header, index) => (
          <div key={index} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              <FormTextField
                label={`Header ${index + 1} name`}
                value={header.name}
                onChange={(event) => updateHeader(index, { name: event.target.value })}
                placeholder="X-Api-Key"
                disabled={saving || testing}
              />
            </div>
            <div className="min-w-0 flex-1">
              <FormTextField
                label={`Header ${index + 1} value`}
                type="password"
                value={header.value}
                onChange={(event) => updateHeader(index, { value: event.target.value })}
                placeholder="value"
                disabled={saving || testing}
              />
            </div>
            <button
              type="button"
              aria-label={`Remove header ${index + 1}`}
              title="Remove header"
              onClick={() => removeHeader(index)}
              disabled={saving || testing}
              className="mt-6 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-danger-soft hover:text-danger active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
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
    </div>
  );
}
