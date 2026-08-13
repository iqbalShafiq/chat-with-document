import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchContextSnippet,
  removeContextSnippet,
  upsertContextSnippet,
  type ContextSnippet,
} from "#/lib/api";
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";

export function useContextSnippet(sessionId: string) {
  const [snippet, setSnippetState] = useState<ContextSnippet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snippetRef = useRef<ContextSnippet | null>(null);
  // Single version counter guarding every mutation and refresh: a slow
  // response only applies state when no newer mutation happened after it
  // started (remove-during-upsert, two rapid pins, refresh-during-remove).
  const mutationRef = useRef(0);

  // Keep the ref in sync with state so stable callbacks always read the
  // latest chip without re-creating themselves on every snippet change.
  const syncSnippet = (next: ContextSnippet | null) => {
    snippetRef.current = next;
    setSnippetState(next);
  };

  const refresh = useCallback(async () => {
    const version = ++mutationRef.current;
    if (!sessionId) {
      syncSnippet(null);
      return;
    }
    setLoading(true);
    try {
      const current = await fetchContextSnippet(sessionId);
      if (version !== mutationRef.current) return;
      syncSnippet(current);
      setError(null);
    } catch {
      if (version !== mutationRef.current) return;
      setError("Could not load context snippet");
    } finally {
      if (version === mutationRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    syncSnippet(null);
    void refresh();
  }, [refresh]);

  const setSnippet = useCallback(
    async (
      text: string,
      sourceRole: ContextSnippetSourceRole,
    ): Promise<boolean> => {
      if (!sessionId) return false;
      const version = ++mutationRef.current;
      const previous = snippetRef.current;
      const optimistic: ContextSnippet = {
        id: `pending-${Date.now()}`,
        text,
        sourceRole,
        createdAt: new Date().toISOString(),
      };
      syncSnippet(optimistic);
      setError(null);
      try {
        const saved = await upsertContextSnippet({ sessionId, text, sourceRole });
        // A newer mutation already happened — drop the stale response.
        if (version !== mutationRef.current) return true;
        syncSnippet(saved);
        return true;
      } catch (err) {
        if (version !== mutationRef.current) return false;
        syncSnippet(previous);
        setError(
          err instanceof Error ? err.message : "Could not add context snippet",
        );
        return false;
      }
    },
    [sessionId],
  );

  const remove = useCallback(async () => {
    const current = snippetRef.current;
    if (!current || !sessionId) return;
    const version = ++mutationRef.current;
    syncSnippet(null);
    setError(null);
    try {
      await removeContextSnippet({ sessionId, snippetId: current.id });
    } catch (err) {
      if (version !== mutationRef.current) return;
      syncSnippet(current);
      setError(
        err instanceof Error ? err.message : "Could not remove context snippet",
      );
    }
  }, [sessionId]);

  /** Local clear as soon as send is dispatched — the server clears its own row. */
  const reset = useCallback(() => {
    mutationRef.current += 1;
    syncSnippet(null);
    setError(null);
    // The version bump discards any in-flight refresh, so its finally can no
    // longer clear the spinner — clear it here to keep loading accurate.
    setLoading(false);
  }, []);

  /**
   * Local-only display of a snippet snapshot (queued-item edit hydration):
   * does not upsert or delete server state.
   */
  const setLocal = useCallback((snippet: ContextSnippet | null) => {
    mutationRef.current += 1;
    syncSnippet(snippet);
    setError(null);
    setLoading(false);
  }, []);

  return { snippet, loading, error, refresh, setSnippet, remove, reset, setLocal };
}
