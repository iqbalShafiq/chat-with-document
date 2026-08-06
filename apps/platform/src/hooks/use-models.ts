import { useCallback, useEffect, useState } from "react";
import {
  listModels,
  type ModelInfo,
  type ReasoningEffortInfo,
} from "#/lib/api";

export function useModels(): {
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  status: "loading" | "success" | "error";
  error: string | null;
  retry: () => void;
} {
  const [state, setState] = useState<{
    status: "loading" | "success" | "error";
    models: ModelInfo[];
    reasoningEfforts: ReasoningEffortInfo[];
    error: string | null;
  }>({
    status: "loading",
    models: [],
    reasoningEfforts: [],
    error: null,
  });

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    listModels()
      .then((data) =>
        setState({
          status: "success",
          models: data.models,
          reasoningEfforts: data.reasoningEfforts,
          error: null,
        }),
      )
      .catch((error) =>
        setState((current) => ({
          ...current,
          status: "error",
          error:
            error instanceof Error ? error.message : "Failed to load models",
        })),
      );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, retry: load };
}
