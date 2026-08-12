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
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setSnippetState(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const current = await fetchContextSnippet(sessionId);
      if (requestId !== requestRef.current) return;
      setSnippetState(current);
      setError(null);
    } catch {
      if (requestId !== requestRef.current) return;
      setError("Could not load context snippet");
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setSnippetState(null);
    void refresh();
  }, [refresh]);

  const setSnippet = useCallback(
    async (
      text: string,
      sourceRole: ContextSnippetSourceRole,
    ): Promise<boolean> => {
      if (!sessionId) return false;
      const previous = snippet;
      const optimistic: ContextSnippet = {
        id: `pending-${Date.now()}`,
        text,
        sourceRole,
        createdAt: new Date().toISOString(),
      };
      setSnippetState(optimistic);
      setError(null);
      try {
        const saved = await upsertContextSnippet({ sessionId, text, sourceRole });
        setSnippetState(saved);
        return true;
      } catch (err) {
        setSnippetState(previous);
        setError(
          err instanceof Error ? err.message : "Could not add context snippet",
        );
        return false;
      }
    },
    [sessionId, snippet],
  );

  const remove = useCallback(async () => {
    const current = snippet;
    if (!current || !sessionId) return;
    setSnippetState(null);
    setError(null);
    try {
      await removeContextSnippet({ sessionId, snippetId: current.id });
    } catch (err) {
      setSnippetState(current);
      setError(
        err instanceof Error ? err.message : "Could not remove context snippet",
      );
    }
  }, [sessionId, snippet]);

  /** Local clear after a successful send — the server clears its own row. */
  const reset = useCallback(() => {
    setSnippetState(null);
    setError(null);
  }, []);

  return { snippet, loading, error, refresh, setSnippet, remove, reset };
}
