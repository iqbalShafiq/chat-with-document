import {
  BUTTON_BASE_CLASS,
  BUTTON_SIZE_CLASSES,
  BUTTON_VARIANT_CLASSES,
} from "#/components/ui/button";

/**
 * Shared action button styles for DialogShell footers and ConfirmDialog.
 * Composed from the shared Button class map — visual language stays in
 * one place.
 */

export const DIALOG_PRIMARY_BUTTON_CLASS = [
  BUTTON_BASE_CLASS,
  BUTTON_VARIANT_CLASSES.primary,
  BUTTON_SIZE_CLASSES.md,
].join(" ");

export const DIALOG_SECONDARY_BUTTON_CLASS = [
  BUTTON_BASE_CLASS,
  BUTTON_VARIANT_CLASSES.secondary,
  BUTTON_SIZE_CLASSES.md,
].join(" ");
