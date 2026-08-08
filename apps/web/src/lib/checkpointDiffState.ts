import {
  type CheckpointDiffState,
  type CheckpointDiffTarget,
} from "@loop/runtime/state/threads";

import { useCheckpointDiff as useCheckpointDiffQuery } from "../state/queries";

/**
 * `refresh` rides along because a checkpoint diff can go stale while it is on
 * screen: the agent writing a file changes what git would answer, and nothing
 * about the query can know that happened. `CheckpointDiffState` is the shared
 * shape and stays as it is; the extra field is this app's.
 */
export function useCheckpointDiff(
  target: CheckpointDiffTarget,
  options?: { readonly enabled?: boolean },
): CheckpointDiffState & { readonly refresh: () => void } {
  const state = useCheckpointDiffQuery(target, options);
  return {
    data: state.data,
    error: state.error,
    isPending: state.isPending,
    refresh: state.refresh,
  };
}
