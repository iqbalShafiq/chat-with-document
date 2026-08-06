# Shared Select + SelectOptionList Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the library's native project-filter `<select>` with a reusable `Select` component, extracting the switcher's listbox panel into a shared `SelectOptionList` with zero behavior change to the model/reasoning switcher.

**Architecture:** Two new UI primitives in `components/ui/`: a presentational `SelectOptionList` (listbox panel, classes copied verbatim from `SwitcherMenu`) and a stateful `Select` (trigger + open/close + keyboard navigation) built on it. The switcher's private `SwitcherMenu`/`MenuOption` are deleted in favor of `SelectOptionList`/`SelectOption`; the library filter swaps from native `<select>` to `Select`.

**Tech Stack:** React 19 + Vite + Tailwind CSS v4, lucide-react icons, `#/*` path alias.

## Global Constraints

- No test framework in this repo; verification = `pnpm --filter platform exec tsc --noEmit` (0 errors/warnings) + `pnpm --filter platform build`.
- **The model/reasoning switcher must render and behave EXACTLY as before** — the extracted list classes must be verbatim copies of the current `SwitcherMenu` classes (listed in Task 1); no new behavior added to the switcher path.
- App animation vocabulary: `animate-fade-in`, `--ease-out-premium`; panels use `rounded-xl border border-white/[0.08] bg-canvas-elevated text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)]`.
- Do not touch `popover-menu.tsx`, the switcher's shell/portal/positioning logic, or anything backend.
- No comments in code unless the file already uses doc comments (shared UI components may carry a one-line JSDoc).

---

### Task 1: `SelectOptionList` presentational listbox

**Files:**
- Create: `apps/platform/src/components/ui/select-list.tsx`

**Interfaces:**
- Produces:
  - `export type SelectOption = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean }`
  - `export type SelectOptionListProps = { ref?: Ref<HTMLUListElement>; id: string; ariaLabel: string; value: string; options: SelectOption[]; onSelect: (value: string) => void; style?: CSSProperties; className?: string; onKeyDown?: KeyboardEventHandler }`
  - `export function SelectOptionList(props: SelectOptionListProps)` — renders the listbox; option buttons carry `data-option-value={opt.value}`.

- [ ] **Step 1: Create `select-list.tsx`**

```tsx
import type {
  CSSProperties,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export type SelectOptionListProps = {
  ref?: Ref<HTMLUListElement>;
  id: string;
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
  style?: CSSProperties;
  className?: string;
  onKeyDown?: KeyboardEventHandler;
};

/**
 * Presentational listbox panel shared by Select and the model/reasoning
 * switcher. Open/close and keyboard logic live in the caller.
 */
export function SelectOptionList({
  ref,
  id,
  ariaLabel,
  value,
  options,
  onSelect,
  style,
  className = "",
  onKeyDown,
}: SelectOptionListProps) {
  return (
    <ul
      ref={ref}
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={onKeyDown}
      className={`overflow-hidden rounded-xl border border-white/[0.08] bg-canvas-elevated text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in ${className}`}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        return (
          <li key={opt.value} role="option" aria-selected={isSelected}>
            <button
              type="button"
              disabled={opt.disabled}
              data-option-value={opt.value}
              className={`flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition duration-150 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 ${
                isSelected ? "bg-white/[0.05]" : ""
              }`}
              onClick={() => {
                if (opt.disabled) return;
                onSelect(opt.value);
              }}
            >
              {opt.icon ? (
                <span className="mt-0.5 text-text-muted">{opt.icon}</span>
              ) : null}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={`text-xs font-medium ${isSelected ? "text-text" : "text-text-muted"}`}
                >
                  {opt.label}
                </span>
                {opt.hint ? (
                  <span className="text-[10px] text-text-faint">
                    {opt.hint}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
```

The classes on the `ul` and option buttons are VERBATIM copies of `SwitcherMenu` in `model-reasoning-switcher.tsx:316-342` (verify against the current file — line numbers may drift). The only additions are `data-option-value` (for focus lookup, inert for the switcher) and `disabled` support (inert when unused).

- [ ] **Step 2: Verify with typecheck**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/ui/select-list.tsx
git commit -m "feat: add shared SelectOptionList listbox panel"
```

---

### Task 2: `Select` component

**Files:**
- Create: `apps/platform/src/components/ui/select.tsx`

**Interfaces:**
- Consumes: `SelectOptionList`, `SelectOption` from `#/components/ui/select-list` (Task 1).
- Produces:
  - `export type SelectProps = { value: string; onChange: (value: string) => void; options: SelectOption[]; leadingIcon?: ReactNode; ariaLabel: string; className?: string; disabled?: boolean }`
  - `export function Select(props: SelectProps)`

- [ ] **Step 1: Create `select.tsx`**

```tsx
import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  SelectOptionList,
  type SelectOption,
} from "#/components/ui/select-list";

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  leadingIcon?: ReactNode;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
};

export function Select({
  value,
  onChange,
  options,
  leadingIcon,
  ariaLabel,
  className = "",
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const wasOpenRef = useRef(false);

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    // Defer so the opening click does not immediately close.
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const selectedButton = list.querySelector<HTMLButtonElement>(
      'li[aria-selected="true"] button',
    );
    const firstButton = list.querySelector<HTMLButtonElement>(
      "button[data-option-value]",
    );
    (selectedButton ?? firstButton)?.focus();
  }, [open]);

  const moveFocus = (index: number, direction: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const buttons = Array.from(
      list.querySelectorAll<HTMLButtonElement>("button[data-option-value]"),
    );
    if (buttons.length === 0) return;
    let i = index;
    for (let step = 0; step < buttons.length; step += 1) {
      const button = buttons[i];
      if (button && !button.disabled) {
        button.focus();
        return;
      }
      i = (i + direction + buttons.length) % buttons.length;
    }
  };

  const handleListKeyDown = (event: KeyboardEvent) => {
    const list = listRef.current;
    if (!list) return;
    const buttons = Array.from(
      list.querySelectorAll<HTMLButtonElement>("button[data-option-value]"),
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(currentIndex + 1, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(currentIndex - 1, -1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0, 1);
        break;
      case "End":
        event.preventDefault();
        moveFocus(buttons.length - 1, -1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        (document.activeElement as HTMLButtonElement | null)?.click();
        break;
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {leadingIcon ? (
        <span className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-text-faint">
          {leadingIcon}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`w-full cursor-pointer rounded-xl bg-white/[0.04] py-2.5 text-left text-sm text-text outline-none ring-1 ring-white/[0.08] transition focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-40 ${
          leadingIcon ? "pl-10" : "pl-3"
        } pr-9`}
      >
        {selected?.label ?? "Select…"}
      </button>
      <ChevronDown
        className={`pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-faint transition-transform duration-200 ${
          open ? "rotate-180" : ""
        }`}
        strokeWidth={1.75}
      />
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5">
          <SelectOptionList
            ref={listRef}
            id={listId}
            ariaLabel={ariaLabel}
            value={value}
            options={options}
            onSelect={(optionValue) => {
              onChange(optionValue);
              setOpen(false);
            }}
            onKeyDown={handleListKeyDown}
            className="max-h-[16rem] overflow-y-auto"
          />
        </div>
      ) : null}
    </div>
  );
}
```

Note: the `handleListKeyDown` parameter type `KeyboardEvent` comes from the type-only react import in the imports block above.

- [ ] **Step 2: Verify with typecheck**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings. (If `React.KeyboardEvent` is unresolved without the React namespace import, use the type-only import as noted.)

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/ui/select.tsx
git commit -m "feat: add reusable Select component with listbox behavior"
```

---

### Task 3: Refactor model/reasoning switcher to use `SelectOptionList`

**Files:**
- Modify: `apps/platform/src/components/composer/model-reasoning-switcher.tsx`

**Interfaces:**
- Consumes: `SelectOptionList`, `SelectOption` from `#/components/ui/select-list` (Task 1).
- Produces: nothing new — behavior of the switcher must be identical.

- [ ] **Step 1: Swap imports and delete the private pieces**

1. Add to imports:
```tsx
import {
  SelectOptionList,
  type SelectOption,
} from "#/components/ui/select-list";
```
2. Delete the local `type MenuOption` block (currently lines 285-290).
3. Delete the entire local `SwitcherMenu` function (currently lines 292-348).
4. The `menu` variable's mapping (currently lines 138-155) types its options as `MenuOption[]`-shaped `{ value, label, hint, icon }` objects — they already conform to `SelectOption`; no mapping change needed.
5. Replace the `<SwitcherMenu ... />` call (currently lines 124-167) with:
```tsx
<SelectOptionList
  ref={menuRef}
  id={openMenu === "model" ? modelListId : reasoningListId}
  ariaLabel={openMenu === "model" ? "Model" : "Reasoning effort"}
  value={openMenu === "model" ? model : reasoningEffort}
  style={{
    position: "fixed",
    top: menuPos.top,
    left: menuPos.left,
    minWidth: menuPos.minWidth,
    transform: "translateY(-100%)",
    zIndex: 80,
  }}
  options={openMenu === "model" ? modelOptions : reasoningOptions}
  onSelect={(selectedValue) => {
    if (openMenu === "model") {
      onModelChange(selectedValue as CompletionModelId);
    } else {
      onReasoningChange(selectedValue as ReasoningEffort);
    }
    setOpenMenu(null);
  }}
/>
```
(Refactor the inline option mappings into `modelOptions` / `reasoningOptions` consts above `menu` if it keeps the file readable — pure extraction, same values.)

6. Import cleanup: remove `CSSProperties` from the react type imports — it is used only by the deleted `SwitcherMenu` (the inline `style` object and the `menuPos` state type don't reference it). `ReactNode` stays (option `icon` fields). `Ref` was only used by `SwitcherMenu`'s `menuRef` param — remove it from the react type imports if unused elsewhere in the file (check; `menuRef` itself still exists as a `useRef` and is passed to `SelectOptionList`, which types it via its own `ref` prop).

- [ ] **Step 2: Verify identical behavior + typecheck**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings.

Behavior-preservation checklist (manual, if dev servers are up): model menu and reasoning menu open above the composer with the same size/position, same hover/selected/hint styling, Escape and outside-click close identically. If servers are not running, note this as pending visual smoke for the final gate.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/composer/model-reasoning-switcher.tsx
git commit -m "refactor: reuse shared SelectOptionList in model/reasoning switcher"
```

---

### Task 4: Swap library project filter to `Select`

**Files:**
- Modify: `apps/platform/src/components/documents/documents-browser.tsx`

**Interfaces:**
- Consumes: `Select` from `#/components/ui/select` (Task 2).
- Produces: none (terminal task).

- [ ] **Step 1: Import and replace**

1. Add to imports:
```tsx
import { Select } from "#/components/ui/select";
```
2. Replace the entire `<label className="relative shrink-0 sm:w-56">…</label>` block containing the native `<select>` and its chevron (currently around lines 228-249) with:
```tsx
<Select
  ariaLabel="Filter documents by project"
  value={selectedProjectId}
  onChange={setSelectedProjectId}
  leadingIcon={<FolderKanban className="size-4" strokeWidth={1.75} />}
  className="shrink-0 sm:w-56"
  options={[
    { value: ALL_PROJECTS, label: "All groups" },
    ...projects.map((project) => ({
      value: project.id,
      label: project.name,
    })),
  ]}
/>
```
3. Remove `ChevronDown` from the lucide-react import line if nothing else in the file uses it (grep the file first; the only usage is the removed select chevron).

- [ ] **Step 2: Verify with typecheck + build**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings.
Run: `pnpm --filter platform build`
Expected: build succeeds (only pre-existing chunk-size advisory).

- [ ] **Step 3: Manual smoke (dev servers; user may be running them)**

1. Filter dropdown opens DOWNWARD below the trigger; trigger shows cursor-pointer and hover/focus states.
2. Options render with app styling; "All groups" + project names; selecting a project filters the list (and the group headings); re-selecting "All groups" restores.
3. Keyboard: ArrowDown on trigger opens and focuses the selected option; ArrowUp/Down/Home/End move focus; Enter/Space selects and closes; Escape closes and returns focus to the trigger; outside click closes.
4. Model/reasoning switcher in the composer: identical look and behavior to before.
5. Reduced motion: no panel animation when enabled.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/documents/documents-browser.tsx
git commit -m "feat: use shared Select for library project filter"
```
