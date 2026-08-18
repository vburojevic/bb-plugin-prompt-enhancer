// The identity a run is owned by. A run outlives the component that started
// it — rewrites take tens of seconds, and the composer action unmounts the
// moment you leave the thread — so this key, not a React instance, is what
// links a running enhancement to the draft it belongs to. It is the frontend
// map key AND the server's `scope_key` column, so the two must never drift.
// Pure so it can be unit tested; app.tsx supplies the host's scope object.

/** Structural mirror of the host's `PluginComposerScope`. */
export type Scope =
  | { kind: "thread"; threadId: string }
  | { kind: "queued-message"; threadId: string; queuedMessageId: string }
  | {
      kind: "side-chat";
      projectId: string;
      parentThreadId: string;
      tabId: string;
      childThreadId: string | null;
    }
  | { kind: "new-thread"; projectId: string | null }
  | { kind: string };

export function scopeKey(scope: Scope): string {
  switch (scope.kind) {
    case "thread":
      return `thread/${(scope as { threadId: string }).threadId}`;
    // Distinct from the thread it belongs to: a thread's main composer and the
    // inline editor for one of its queued messages are two drafts that can be
    // on screen at once, and a shared key had them adopt each other's run.
    case "queued-message": {
      const queued = scope as { threadId: string; queuedMessageId: string };
      return `queued-message/${queued.threadId}/${queued.queuedMessageId}`;
    }
    // Deliberately without `childThreadId`, which flips from null to an id the
    // first time the side chat is sent to. It is the same draft across that
    // transition, and a key that changed mid-run would strand the run.
    case "side-chat": {
      const side = scope as {
        projectId: string;
        parentThreadId: string;
        tabId: string;
      };
      return `side-chat/${side.projectId}/${side.parentThreadId}/${side.tabId}`;
    }
    case "new-thread":
      return `new-thread/${(scope as { projectId: string | null }).projectId ?? "unresolved"}`;
    // Exhaustive today; a future scope kind falls back to its kind tag rather
    // than colliding with an existing key.
    default:
      return scope.kind;
  }
}
