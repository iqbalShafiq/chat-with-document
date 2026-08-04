# Shared Select + SelectOptionList — Design Spec

Date: 2026-08-04
Status: Approved by user (design presented 2026-08-04)

## Goal

1. Replace the native `<select>` project filter in the Documents library with a styled, reusable `Select` component (cursor-pointer trigger, custom option rendering matching app style).
2. Refactor the model/reasoning switcher menus so their listbox panel comes from a shared component — with ZERO visual or behavioral change to the switcher.

## Current State (verified 2026-08-04)

- `documents-browser.tsx:225` uses a native `<select>` with Tailwind classes; options render via browser default styling (`[&>option]:bg-[#101010]`); no `cursor-pointer` on hover. Uses a `__all_projects__` sentinel value and a leading `FolderKanban` icon + `ChevronDown`.
- `components/ui/popover-menu.tsx` — generic action menu (`role="menu"`), opens upward (`bottom-full`); not a selection dropdown.
- `model-reasoning-switcher.tsx` — private `SwitcherMenu` (`role="listbox"`): `MenuOption { value, label, hint?, icon? }`, selected highlight, portaled panel positioned above the composer. Not exported.
- No shared select/listbox component exists. App animation vocabulary: `animate-fade-in`, `--ease-out-premium`, `--duration-med`; panels use `rounded-xl border border-white/[0.08] bg-canvas-elevated shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)]`.

## Design

### 1. New `apps/platform/src/components/ui/select-list.tsx`

- `export type SelectOption = { value: string; label: string; hint?: string; icon?: ReactNode; disabled?: boolean }` — supersedes `MenuOption`.
- `export function SelectOptionList({ ref?, id, ariaLabel, value, options, onSelect, style?, className? })` — **presentational** listbox:
  - `<ul role="listbox">` with EXACTLY the SwitcherMenu classes: `overflow-hidden rounded-xl border border-white/[0.08] bg-canvas-elevated text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in` (plus passed `style`/`className`).
  - `<li role="option" aria-selected>` + `<button>` rows with EXACTLY the current option classes: `flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition duration-150 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:bg-white/[0.08]`, selected adds `bg-white/[0.05]`, label `text-xs font-medium` (`text-text` selected / `text-text-muted`), hint `text-[10px] text-text-faint`, icon wrapper `mt-0.5 text-text-muted`.
  - No keyboard navigation, no outside-click handling — purely presentational, so embedding into the switcher changes nothing.

### 2. New `apps/platform/src/components/ui/select.tsx`

- `export function Select({ value, onChange, options, leadingIcon?, ariaLabel?, className?, disabled? })`.
- Trigger: styled `<button>` matching the current filter input look (`rounded-xl bg-white/[0.04] py-2.5 pl-10/pl-3 pr-9 ring-1 ring-white/[0.08] text-sm text-text`), `cursor-pointer`, hover/focus states, chevron `ChevronDown` rotating 180° when open, optional `leadingIcon` absolutely positioned (current `FolderKanban` position).
- Panel: `SelectOptionList` in an absolutely positioned container (`absolute top-full mt-1.5 left-0 right-0 z-30`, `max-h-[16rem] overflow-y-auto`), `animate-fade-in`. Opens downward (toolbar sits at the top of the page). Width always equals the trigger width.
- Behavior (state lives in Select):
  - `open` state; toggle on trigger click; `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls`.
  - Outside click closes (document pointerdown, excluding trigger + panel, deferred 0ms so the opening click doesn't immediately close).
  - Keyboard on trigger: ArrowDown/ArrowUp opens and focuses the selected (or first) option.
  - Keyboard on panel: ArrowUp/ArrowDown/Home/End move focus (scroll into view), Enter/Space selects + closes, Escape closes; on close, focus returns to the trigger.
  - Selecting calls `onChange(option.value)` and closes.
- No portal needed (toolbar is not clipped by an overflow ancestor; verify visually).

### 3. Refactor `model-reasoning-switcher.tsx` (behavior-preserving)

- Delete local `MenuOption`; use `SelectOption` from `select-list.tsx`.
- `SwitcherMenu` becomes a thin wrapper rendering `SelectOptionList` with the same `ref`, `id`, `ariaLabel`, `value`, `options`, `onSelect`, `style`. Option mapping stays identical.
- Shell, joined triggers, portal, positioning logic, outside-click/Escape handlers in the parent: unchanged.

### 4. `documents-browser.tsx`

- Replace the native `<select>` + chevron with `Select`:
  - `options`: `[{ value: ALL_PROJECTS, label: "All groups" }, ...projects.map(p => ({ value: p.id, label: p.name }))]`
  - `value={selectedProjectId}`, `onChange={setSelectedProjectId}`, `leadingIcon={<FolderKanban .../>}`, `aria-label="Filter documents by project"`, wrapper keeps `relative shrink-0 sm:w-56`.
- Remove the now-unused `ChevronDown` import if nothing else uses it (check first).

## Out of Scope

- PopoverMenu remains as-is (action menus open upward — different pattern).
- No typeahead, no multi-select, no portal-based placement variants, no mobile special-casing (YAGNI).
- Backend unchanged.

## Verification

- `pnpm --filter platform exec tsc --noEmit` — 0 errors/warnings.
- `pnpm --filter platform build` — succeeds (only pre-existing chunk-size advisory).
- Manual smoke: filter opens downward with cursor-pointer trigger, options styled like the app, select filters the list, keyboard nav works, outside click/Escape close and restore focus; model/reasoning switcher renders and behaves EXACTLY as before (spot-check both menus, hover/selected/hint states).
