import { useCallback, useEffect, useState } from "react";
import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  setMcpServerEnabled,
  testMcpConnection,
  updateMcpServer,
  type McpServerInput,
  type McpTestResult,
  type UserMcpServer,
} from "#/lib/api";

/** Load the user's MCP servers while `active`; expose CRUD + test. */
export function useUserMcpServers(active: boolean) {
  const [data, setData] = useState<UserMcpServer[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const reload = useCallback(async () => {
    try {
      const payload = await listMcpServers();
      setData(payload);
      setError(null);
    } catch {
      setError("Could not load MCP servers");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await listMcpServers();
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError("Could not load MCP servers");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const mutate = useCallback(
    async (fn: () => Promise<unknown>, failure: string) => {
      setSaving(true);
      try {
        await fn();
        await reload();
      } catch (error) {
        setError(error instanceof Error ? error.message : failure);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [reload],
  );

  const save = useCallback(
    (id: string | null, input: McpServerInput) =>
      mutate(
        () => (id ? updateMcpServer(id, input) : createMcpServer(input)),
        "Could not save MCP server",
      ),
    [mutate],
  );

  const remove = useCallback(
    (id: string) => mutate(() => deleteMcpServer(id), "Could not delete MCP server"),
    [mutate],
  );

  const toggle = useCallback(
    (id: string, isEnabled: boolean) =>
      mutate(() => setMcpServerEnabled(id, isEnabled), "Could not update MCP server"),
    [mutate],
  );

  const test = useCallback(async (input: McpServerInput): Promise<McpTestResult> => {
    setTesting(true);
    try {
      return await testMcpConnection(input);
    } finally {
      setTesting(false);
    }
  }, []);

  return { data, loading, error, saving, testing, reload, save, remove, toggle, test };
}
