import { useCallback, useEffect, useState } from "react";
import {
  createSkill,
  deleteSkill,
  listSkills,
  setSkillEnabled,
  updateSkill,
  type SkillInput,
  type UserSkill,
} from "#/lib/api";

/** Load the user's skills while `active`; expose CRUD that refreshes. */
export function useUserSkills(active: boolean) {
  const [data, setData] = useState<UserSkill[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const payload = await listSkills();
      setData(payload);
      setError(null);
    } catch {
      setError("Could not load skills");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await listSkills();
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError("Could not load skills");
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
    (id: string | null, input: SkillInput) =>
      mutate(
        () => (id ? updateSkill(id, input) : createSkill(input)),
        "Could not save skill",
      ),
    [mutate],
  );

  const remove = useCallback(
    (id: string) => mutate(() => deleteSkill(id), "Could not delete skill"),
    [mutate],
  );

  const toggle = useCallback(
    (id: string, isEnabled: boolean) =>
      mutate(() => setSkillEnabled(id, isEnabled), "Could not update skill"),
    [mutate],
  );

  return { data, loading, error, saving, reload, save, remove, toggle };
}
