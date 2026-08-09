// bb-plugin-prompt-enhancer — backend entry.
//
// Rewrites the composer's draft prompt into a clearer, more effective prompt
// using a HIDDEN bb child thread with the same provider as the current thread
// (or the project default on the new-thread composer). No external APIs — the
// hidden thread IS the AI. Completion arrives via thread lifecycle events, so
// no rpc or event handler ever blocks on an LLM turn.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

/** Draft text is embedded in the child thread's prompt capped at this size. */
const PROMPT_TEXT_CAP = 8000;
const REALTIME_CHANNEL = "prompt-enhancer";

const enhancementSchema = z.object({
  id: z.string(),
  scopeThreadId: z.string().nullable(),
  originalText: z.string(),
  childThreadId: z.string().nullable(),
  status: z.enum(["pending", "done", "error"]),
  enhanced: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
type Enhancement = z.infer<typeof enhancementSchema>;

export const rpcContract = defineRpcContract({
  startEnhance: {
    input: z
      .object({
        text: z.string().min(1),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({ id: z.string() }),
  },
  getEnhancement: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ enhancement: enhancementSchema.nullable() }),
  },
});

interface EnhancementRow {
  id: string;
  scope_thread_id: string | null;
  original_text: string;
  child_thread_id: string | null;
  status: string;
  enhanced: string | null;
  error: string | null;
  created_at: number;
}

function toEnhancement(row: EnhancementRow): Enhancement {
  return {
    id: row.id,
    scopeThreadId: row.scope_thread_id,
    originalText: row.original_text,
    childThreadId: row.child_thread_id,
    status: row.status as Enhancement["status"],
    enhanced: row.enhanced,
    error: row.error,
    createdAt: row.created_at,
  };
}

function buildEnhancePrompt(draft: string): string {
  const capped =
    draft.length > PROMPT_TEXT_CAP
      ? `${draft.slice(0, PROMPT_TEXT_CAP)}\n[…truncated]`
      : draft;
  return [
    "You rewrite rough draft prompts into clear, effective prompts for a coding agent.",
    "",
    "Rules:",
    "- Preserve the draft's intent and meaning exactly; do not invent new requirements.",
    "- Keep the same language the draft is written in.",
    "- Make it specific, well-structured, and actionable for a coding agent: what to do, the constraints already implied by the draft, and what a good result looks like.",
    "- Return ONLY the rewritten prompt: no preamble, no explanation, no quotes, no markdown fences.",
    "",
    "Draft prompt:",
    '"""',
    capped,
    '"""',
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS enhancements (
      id TEXT PRIMARY KEY,
      scope_thread_id TEXT,
      original_text TEXT NOT NULL,
      child_thread_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      enhanced TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    )`,
  ]);

  const insertPending = db.prepare(
    `INSERT INTO enhancements (id, scope_thread_id, original_text, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`,
  );
  const setChildThread = db.prepare(
    `UPDATE enhancements SET child_thread_id = ? WHERE id = ?`,
  );
  const pendingByChild = db.prepare(
    `SELECT * FROM enhancements WHERE child_thread_id = ? AND status = 'pending'`,
  );
  const markDone = db.prepare(
    `UPDATE enhancements SET status = 'done', enhanced = ? WHERE id = ? AND status = 'pending'`,
  );
  const markError = db.prepare(
    `UPDATE enhancements SET status = 'error', error = ? WHERE id = ? AND status = 'pending'`,
  );
  const byId = db.prepare(`SELECT * FROM enhancements WHERE id = ?`);

  function publish(id: string, status: "done" | "error") {
    bb.realtime.publish(REALTIME_CHANNEL, { id, status });
  }

  function fail(id: string, message: string) {
    markError.run(message, id);
    publish(id, "error");
  }

  /**
   * Detached kickoff. It MUST swallow every error itself: a stale bb handle or
   * a closed db after a plugin reload must never become an unhandled
   * rejection (PluginContextStaleError can crash the whole bb server).
   */
  async function runEnhance(
    id: string,
    text: string,
    threadId: string | null,
    projectId: string | null,
  ): Promise<void> {
    try {
      let resolvedProjectId = projectId;
      let providerId: string | undefined;
      if (threadId !== null) {
        const parent = await bb.sdk.threads.get({ threadId });
        resolvedProjectId = parent.projectId;
        providerId = parent.providerId;
      }
      if (resolvedProjectId === null) {
        // New-thread composer with an unresolved project: fall back to the
        // first ordinary project so spawn still has a home.
        const projects = await bb.sdk.projects.list();
        resolvedProjectId = projects[0]?.id ?? null;
      }
      if (resolvedProjectId === null) {
        throw new Error("No project available to run the enhancement in");
      }
      const child = await bb.sdk.threads.spawn({
        projectId: resolvedProjectId,
        environment: { type: "project-default" },
        // Inherit the scope thread's provider when enhancing inside a thread;
        // otherwise omit it so spawn uses the project's remembered default.
        ...(providerId ? { providerId } : {}),
        // Deliberately NOT parented to the scope thread: a hidden child
        // reports its completion to its parent, which would inject the
        // rewritten prompt into that thread's conversation. The rewrite
        // belongs in the composer draft, never the timeline.
        visibility: "hidden",
        title: "Enhance prompt",
        prompt: buildEnhancePrompt(text),
      });
      setChildThread.run(child.id, id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        bb.log.warn(`enhancement ${id} failed to start: ${message}`);
        fail(id, message);
      } catch {
        // Stale handle mid-reload — nothing safe left to do.
      }
    }
  }

  bb.rpc.register(rpcContract, {
    startEnhance({ text, threadId, projectId }) {
      const id = crypto.randomUUID();
      insertPending.run(id, threadId, text, Date.now());
      // NON-BLOCKING: completion arrives via thread.idle / thread.failed below.
      void runEnhance(id, text, threadId, projectId);
      return { id };
    },
    getEnhancement({ id }) {
      const row = byId.get(id) as EnhancementRow | undefined;
      return { enhancement: row ? toEnhancement(row) : null };
    },
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const row = pendingByChild.get(thread.id) as EnhancementRow | undefined;
    if (!row) return;
    const enhanced = (lastAssistantText ?? "").trim();
    if (enhanced.length === 0) {
      fail(row.id, "The enhancement thread returned an empty response");
      return;
    }
    markDone.run(enhanced, row.id);
    publish(row.id, "done");
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const row = pendingByChild.get(thread.id) as EnhancementRow | undefined;
    if (!row) return;
    fail(row.id, error ?? "The enhancement thread failed");
  });
}
