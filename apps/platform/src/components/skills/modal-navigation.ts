/**
 * Modal navigation rule shared by the Skills and MCP modals: dismissing
 * (X, backdrop, Escape) from an editor returns to the list first; only
 * dismissing from the list closes the modal. `undefined` means list,
 * `null` means a new item, a string means editing that item.
 */
export function shouldReturnToList(
  editingId: string | null | undefined,
): boolean {
  return editingId !== undefined;
}
