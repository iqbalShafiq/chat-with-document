import { createContext, useContext } from "react";

import type { ImagePreviewContextActions } from "#/components/images/image-preview";

/**
 * Shell-owned session actions shared with chat routes (quiet refresh after
 * a stream settles). The list itself stays in the shell — routes only ask
 * for a refresh so there is exactly one loader/poller.
 */
export const WorkspaceSessionsContext = createContext<{
  refreshQuiet: () => Promise<void>;
  onImageContextActions: (actions: ImagePreviewContextActions | null) => void;
  applySessionTitle: (sessionId: string, title: string) => void;
}>({
  refreshQuiet: async () => {},
  onImageContextActions: () => {},
  applySessionTitle: () => {},
});

export function useWorkspaceSessionsContext(): {
  refreshQuiet: () => Promise<void>;
  onImageContextActions: (actions: ImagePreviewContextActions | null) => void;
  applySessionTitle: (sessionId: string, title: string) => void;
} {
  return useContext(WorkspaceSessionsContext);
}
