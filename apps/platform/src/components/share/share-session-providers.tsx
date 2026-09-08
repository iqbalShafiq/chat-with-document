import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ImagePreviewProvider, type ImagePreviewContextActions } from "#/components/images/image-preview";
import { WorkspaceSessionsContext } from "#/components/workspace/workspace-sessions-context";

function noopRefreshQuiet(): Promise<void> {
  return Promise.resolve();
}

/**
 * Minimal provider shell for surfaces outside the authenticated workspace
 * (public share page). ChatSession only needs the quiet-refresh callback
 * and the image-preview action bridge — both no-op here so the same thread,
 * composer, and right-rail components render without the sidebar shell.
 */
export function ShareSessionProviders({ children }: { children: ReactNode }) {
  const [imageContextActions, setImageContextActions] =
    useState<ImagePreviewContextActions | null>(null);
  const onImageContextActions = useCallback(
    (actions: ImagePreviewContextActions | null) => {
      setImageContextActions(actions);
    },
    [],
  );
  const value = useMemo(
    () => ({
      refreshQuiet: noopRefreshQuiet,
      onImageContextActions,
    }),
    [onImageContextActions],
  );

  return (
    <WorkspaceSessionsContext.Provider value={value}>
      <ImagePreviewProvider actions={imageContextActions}>
        {children}
      </ImagePreviewProvider>
    </WorkspaceSessionsContext.Provider>
  );
}
