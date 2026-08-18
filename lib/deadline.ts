// What to do when a run's local deadline expires. The deadline is a PACING
// HINT, not the truth: the run lives on the server, and it may well have
// finished while no composer for its scope was mounted (thread switched away)
// or while the completion signal was still in flight. Discarding — or worse,
// cancelling — a run purely because a local clock ran out threw away finished
// rewrites and killed healthy in-flight runs on return to the thread. The
// server row always gets the final word, and a run the server still reports as
// pending keeps running: the client goes back to waiting on it. Only the
// server ends a run. Pure so it can be unit tested.

export interface EnhancementSnapshot {
  status: "pending" | "done" | "error" | "cancelled";
  enhanced: string | null;
  error: string | null;
}

export type DeadlineVerdict =
  /** The rewrite is ready — deliver it, deadline notwithstanding. */
  | { kind: "deliver"; enhanced: string }
  /** The run failed server-side — surface its error and release. */
  | { kind: "error"; message: string }
  /** Cancelled elsewhere — release quietly. */
  | { kind: "release" }
  /** Alive and still working: keep the composer waiting, re-check later. */
  | { kind: "pending" }
  /** The server has no such run (pruned, or lost to a reload) — release. */
  | { kind: "unknown" };

export function deadlineVerdict(
  enhancement: EnhancementSnapshot | null,
): DeadlineVerdict {
  if (enhancement === null) return { kind: "unknown" };
  switch (enhancement.status) {
    case "done":
      // A done row with empty text is a server-side bug surfaced as done;
      // there is nothing deliverable, so it reads as a failure rather than
      // leaving the composer locked forever.
      return enhancement.enhanced
        ? { kind: "deliver", enhanced: enhancement.enhanced }
        : { kind: "error", message: "The enhancement returned no text" };
    case "error":
      return { kind: "error", message: enhancement.error ?? "Enhancement failed" };
    case "cancelled":
      return { kind: "release" };
    case "pending":
      return { kind: "pending" };
  }
}
