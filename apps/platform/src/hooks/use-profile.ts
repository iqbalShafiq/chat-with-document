import { useCallback, useEffect, useState } from "react";
import {
  getProfiling,
  resetProjectProfile,
  resetUserProfile,
  type ProfilingPayload,
} from "#/lib/api";

/** Load profiling payload while `active`; expose reset actions. */
export function useProfilePersonalization(active: boolean) {
  const [data, setData] = useState<ProfilingPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const payload = await getProfiling();
      setData(payload);
      setError(null);
    } catch {
      setError("Could not load profiles");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await getProfiling();
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError("Could not load profiles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const resetUser = useCallback(async () => {
    setResetting("user");
    try {
      await resetUserProfile();
      await reload();
    } catch {
      setError("Could not reset profile");
    } finally {
      setResetting(null);
    }
  }, [reload]);

  const resetProject = useCallback(
    async (projectId: string) => {
      setResetting(`project:${projectId}`);
      try {
        await resetProjectProfile(projectId);
        await reload();
      } catch {
        setError("Could not reset project profile");
      } finally {
        setResetting(null);
      }
    },
    [reload],
  );

  return { data, loading, error, resetting, resetUser, resetProject };
}
