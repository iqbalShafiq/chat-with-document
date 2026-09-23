import { useEffect, useRef, useState } from "react";
import { Pencil, Plus, Trash2, Upload } from "lucide-react";
import { DialogShell } from "#/components/ui/dialog-shell";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { FormTextAreaField, FormTextField } from "#/components/ui/form-field";
import { useUserSkills } from "#/hooks/use-user-skills";
import type { SkillInput, UserSkill } from "#/lib/api";
import { issuesFromError, issuesToFieldErrors, type FieldErrors } from "./skill-issues";

const SKILL_TEMPLATE = `---
name: my-skill
description: When to use this skill.
---

# My skill

Steps the agent should follow.
`;

function prefillFromMarkdown(text: string): SkillInput {
  const lines = text.split("\n");
  let name = "";
  let description = "";
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end > 0) {
      const frontmatter = lines.slice(1, end).join("\n");
      name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "";
      description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    }
  }
  return { name, description, bodyMd: text };
}

export function SkillsModal({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const skills = useUserSkills(open);
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const closeEditor = () => {
    setEditingId(undefined);
  };

  const handleChanged = () => {
    setEditingId(undefined);
    onChanged();
  };

  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Skills"
      description="Reusable procedures your agent loads when the task fits."
      size="lg"
      heightMode="viewport"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        {skills.loading ? (
          <div className="flex flex-col gap-3">
            <div className="skeleton-shimmer h-16 w-full rounded-xl" />
            <div className="skeleton-shimmer h-16 w-full rounded-xl" />
          </div>
        ) : skills.error && !skills.data ? (
          <p className="text-sm text-danger" role="alert">
            {skills.error}
          </p>
        ) : editingId !== undefined ? (
          <SkillEditor
            key={editingId ?? "new"}
            initial={
              editingId
                ? (skills.data ?? []).find((skill) => skill.id === editingId) ?? null
                : null
            }
            saving={skills.saving}
            onCancel={closeEditor}
            onSave={async (input) => {
              await skills.save(editingId ?? null, input);
              handleChanged();
            }}
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-text-muted">
                {(skills.data ?? []).length === 0
                  ? "No skills yet — write the first one."
                  : "Enabled skills load automatically when the task fits."}
              </p>
              <Button variant="primary" size="sm" onClick={() => setEditingId(null)}>
                <Plus className="size-4" strokeWidth={2} />
                New skill
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {(skills.data ?? []).map((skill) => (
                <li
                  key={skill.id}
                  className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{skill.name}</p>
                    <p className="truncate text-[11px] text-text-faint">
                      {skill.status === "active" ? skill.description : "Invalid — edit to fix"}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={skill.isEnabled}
                    aria-label={`Enable ${skill.name}`}
                    title={skill.isEnabled ? "Enabled" : "Disabled"}
                    onClick={() => {
                      void skills.toggle(skill.id, !skill.isEnabled).then(onChanged);
                    }}
                    className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring ${skill.isEnabled ? "bg-accent/80" : "bg-white/12"}`}
                  >
                    <span
                      aria-hidden
                      className={`absolute top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ${skill.isEnabled ? "translate-x-3.5" : "translate-x-0.5"}`}
                    />
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${skill.name}`}
                    title="Edit"
                    onClick={() => setEditingId(skill.id)}
                    className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
                  >
                    <Pencil className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${skill.name}`}
                    title="Delete"
                    onClick={() => setDeleteId(skill.id)}
                    className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-danger-soft hover:text-danger active:scale-[0.96]"
                  >
                    <Trash2 className="size-4" strokeWidth={1.75} />
                  </button>
                </li>
              ))}
            </ul>
            {skills.error ? (
              <p className="text-[11px] text-danger" role="alert">
                {skills.error}
              </p>
            ) : null}
          </>
        )}
      </div>
      <ConfirmDialog
        open={deleteId !== null}
        title="Delete skill?"
        description="The agent will no longer see this skill. This cannot be undone."
        confirmLabel="Delete"
        busy={deleting}
        onCancel={() => {
          if (!deleting) setDeleteId(null);
        }}
        onConfirm={() => {
          if (!deleteId) return;
          setDeleting(true);
          void skills
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

function SkillEditor({
  initial,
  saving,
  onCancel,
  onSave,
}: {
  initial: UserSkill | null;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: SkillInput) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [bodyMd, setBodyMd] = useState(initial?.bodyMd ?? SKILL_TEMPLATE);
  const [errors, setErrors] = useState<FieldErrors>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setErrors({});
  }, [name, description, bodyMd]);

  const pickFile = () => fileRef.current?.click();

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const prefill = prefillFromMarkdown(text);
    if (prefill.name) setName(prefill.name);
    if (prefill.description) setDescription(prefill.description);
    setBodyMd(text);
  };

  const submit = async () => {
    setErrors({});
    try {
      await onSave({ name: name.trim(), description: description.trim(), bodyMd: bodyMd.trim() });
    } catch (error) {
      setErrors(issuesToFieldErrors(issuesFromError(error)));
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          void onFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-text">
          {initial ? "Edit skill" : "New skill"}
        </h3>
        <Button variant="ghost" size="sm" onClick={pickFile}>
          <Upload className="size-4" strokeWidth={1.75} />
          Upload .md
        </Button>
      </div>
      <FormTextField
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="release-notes"
        helper="Lowercase letters, numbers, hyphens. Must match frontmatter name:."
        error={errors.name ?? null}
        disabled={saving}
      />
      <FormTextField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="When to use this skill."
        helper="One line the agent uses to decide when this skill fits."
        error={errors.description ?? null}
        disabled={saving}
      />
      <FormTextAreaField
        label="SKILL.md"
        value={bodyMd}
        onChange={(event) => setBodyMd(event.target.value)}
        rows={12}
        className="font-mono text-xs leading-relaxed"
        helper="Starts with --- frontmatter (name:, description:) matching the fields above."
        error={errors.bodyMd ?? null}
        disabled={saving}
      />
      {errors.form ? (
        <p className="text-[11px] text-danger" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? "Saving…" : initial ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
