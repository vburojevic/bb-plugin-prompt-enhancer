// bb-plugin-prompt-enhancer — backend entry.
//
// Rewrites the composer's draft prompt into a clearer, more effective prompt
// using a HIDDEN bb child thread with the same provider as the current thread
// (or the project default on the new-thread composer). No external APIs — the
// hidden thread IS the AI. Completion arrives via thread lifecycle events, so
// no rpc or event handler ever blocks on an LLM turn. Child threads are
// single-use: they are stopped and deleted as soon as the enhancement
// resolves (done, error, cancel, or orphaned by a restart).
//
// The user can pin an explicit provider+model for the enhancement thread via
// the composer dropdown; without an override the scope thread's provider is
// inherited and the model stays at that provider's default.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { buildEnhancePrompt } from "./lib/enhance-prompt";
import { adaptiveTimeoutMs } from "./lib/adaptive-timeout";

const REALTIME_CHANNEL = "prompt-enhancer";
const OVERRIDE_KEY = "model-override";
const CATALOG_TTL_MS = 60_000;
/** Persisted catalog survives plugin reloads so handlers never cold-fetch. */
const CATALOG_CACHE_KEY = "model-catalog-cache";
/** Hard ceiling on any single provider RPC inside a catalog refresh. */
const PROVIDER_CALL_TIMEOUT_MS = 5_000;

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const enhancementSchema = z.object({
  id: z.string(),
  scopeThreadId: z.string().nullable(),
  originalText: z.string(),
  childThreadId: z.string().nullable(),
  status: z.enum(["pending", "done", "error", "cancelled"]),
  enhanced: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
});
type Enhancement = z.infer<typeof enhancementSchema>;

const modelOverrideSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
type ModelOverride = z.infer<typeof modelOverrideSchema>;

/** How often the child thread's partial output is polled while pending. */
const PROGRESS_POLL_MS = 400;
/** Progress polling stops unconditionally after this long (outlives the
 * largest adaptive timeout so a slow run keeps painting to the end). */
const PROGRESS_MAX_MS = 190_000;

/** Tail of the scope thread's last output shown to the rewriter as context. */
const CONTEXT_OUTPUT_CAP = 1500;

const modelCatalogSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      models: z.array(
        z.object({
          model: z.string(),
          displayName: z.string(),
          isDefault: z.boolean(),
        }),
      ),
    }),
  ),
});
type ModelCatalog = z.infer<typeof modelCatalogSchema>;

export const rpcContract = defineRpcContract({
  startEnhance: {
    input: z
      .object({
        text: z.string().min(1).max(100_000),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
        attachmentCount: z.number().int().min(0),
      })
      .strict(),
    output: z.object({ id: z.string(), timeoutMs: z.number() }),
  },
  getEnhancement: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ enhancement: enhancementSchema.nullable() }),
  },
  cancelEnhance: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({}),
  },
  listModels: {
    input: z.null(),
    output: modelCatalogSchema,
  },
  getModelOverride: {
    input: z.null(),
    output: z.object({ override: modelOverrideSchema.nullable() }),
  },
  setModelOverride: {
    input: z.object({ override: modelOverrideSchema.nullable() }).strict(),
    output: z.object({}),
  },
  getPrefs: {
    input: z.null(),
    output: z.object({ previewBeforeApply: z.boolean() }),
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
  model_key: string | null;
  duration_ms: number | null;
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


export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    previewBeforeApply: {
      type: "boolean",
      label: "Review before applying",
      description:
        "Show the rewrite in an Apply/Discard preview instead of replacing the draft immediately.",
      default: false,
    },
    customInstructions: {
      type: "string",
      label: "Custom rewrite instructions",
      description:
        "Extra instruction appended to every rewrite, e.g. \"keep prompts under 100 words\".",
    },
  });
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
    `ALTER TABLE enhancements ADD COLUMN model_key TEXT`,
    `ALTER TABLE enhancements ADD COLUMN duration_ms INTEGER`,
  ]);

  const insertPending = db.prepare(
    `INSERT INTO enhancements (id, scope_thread_id, original_text, status, model_key, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  );
  const recentDurations = db.prepare(
    `SELECT duration_ms FROM enhancements
     WHERE model_key = ? AND duration_ms IS NOT NULL
     ORDER BY created_at DESC LIMIT 12`,
  );
  // History is diagnostic, not archival — keep the table bounded.
  db.prepare(`DELETE FROM enhancements WHERE created_at < ?`).run(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  );
  // Rows still pending at load lost their completion event to a restart or
  // plugin reload; nobody will ever resolve them, so fail them now and reap
  // any child threads they left running.
  const orphans = db
    .prepare(`SELECT * FROM enhancements WHERE status = 'pending'`)
    .all() as EnhancementRow[];
  const setChildThread = db.prepare(
    `UPDATE enhancements SET child_thread_id = ? WHERE id = ?`,
  );
  const pendingByChild = db.prepare(
    `SELECT * FROM enhancements WHERE child_thread_id = ? AND status = 'pending'`,
  );
  const markDone = db.prepare(
    `UPDATE enhancements SET status = 'done', enhanced = ?, duration_ms = ? WHERE id = ? AND status = 'pending'`,
  );
  const markError = db.prepare(
    `UPDATE enhancements SET status = 'error', error = ? WHERE id = ? AND status = 'pending'`,
  );
  const markCancelled = db.prepare(
    `UPDATE enhancements SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
  );
  const byId = db.prepare(`SELECT * FROM enhancements WHERE id = ?`);

  /**
   * Hidden enhancement threads are single-use scratch space: once the row has
   * its result (or is dead), the thread has no residual value and would only
   * accumulate. Stop-then-delete, both best-effort — cleanup must never turn
   * into a user-visible failure.
   */
  function cleanupChildThread(threadId: string | null): void {
    if (threadId === null) return;
    void (async () => {
      try {
        await bb.sdk.threads.stop({ threadId }).catch(() => {});
        await bb.sdk.threads.delete({ threadId, childThreadsConfirmed: true });
      } catch {
        // Already gone, or the host is mid-reload — either way, done trying.
      }
    })();
  }

  for (const orphan of orphans) {
    markError.run("Interrupted by a restart", orphan.id);
    cleanupChildThread(orphan.child_thread_id);
  }

  function publish(id: string, status: "done" | "error") {
    bb.realtime.publish(REALTIME_CHANNEL, { id, status });
  }

  function fail(id: string, message: string) {
    markError.run(message, id);
    publish(id, "error");
  }

  // ---------------------------------------------------------------------
  // Live progress: no delta events exist in the plugin SDK, so while an
  // enhancement is pending we poll the child thread's partial output and
  // relay growth to the composer. Chunky (~0.6s) but genuine tokens.
  // ---------------------------------------------------------------------
  const progressTimers = new Map<string, ReturnType<typeof setInterval>>();

  function stopProgress(id: string): void {
    const timer = progressTimers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      progressTimers.delete(id);
    }
  }

  /** Polls of unchanged non-empty output before it counts as the result. */
  const PROGRESS_STABLE_POLLS = 3;

  function startProgress(id: string, childThreadId: string): void {
    const startedAt = Date.now();
    let lastSeen = "";
    let stablePolls = 0;

    function finalize(row: EnhancementRow, text: string): void {
      stopProgress(id);
      const enhanced = text.trim();
      if (enhanced.length === 0) {
        fail(id, "The enhancement thread returned an empty response");
      } else {
        markDone.run(enhanced, Date.now() - row.created_at, id);
        publish(id, "done");
      }
      cleanupChildThread(childThreadId);
    }

    const timer = setInterval(() => {
      void (async () => {
        try {
          const row = byId.get(id) as EnhancementRow | undefined;
          if (
            row === undefined ||
            row.status !== "pending" ||
            Date.now() - startedAt > PROGRESS_MAX_MS
          ) {
            stopProgress(id);
            return;
          }
          const { output } = await bb.sdk.threads.output({
            threadId: childThreadId,
          });
          const text = output ?? "";
          if (text.length > lastSeen.length) {
            // Monotonic: only growth is relayed, so the composer never sees
            // the text shrink or flicker between event-assembly states.
            bb.realtime.publish(REALTIME_CHANNEL, {
              id,
              status: "progress",
              text,
            });
          }
          stablePolls = text.length > 0 && text === lastSeen ? stablePolls + 1 : 0;
          lastSeen = text;
          // Optimistic finish: output is assembled from COMPLETED messages
          // only, so non-empty text that stays unchanged across several
          // polls IS the rewrite — the thread just spends multiple further
          // seconds in provider teardown before thread.idle fires, which
          // previously left the composer locked and the pill spinning long
          // after the full text had painted. The idle check below and the
          // lifecycle events remain as fallbacks (all status-guarded).
          if (stablePolls >= PROGRESS_STABLE_POLLS) {
            finalize(row, text);
            return;
          }
          const child = await bb.sdk.threads.get({ threadId: childThreadId });
          if (child.status === "idle") {
            finalize(row, text);
          } else if (child.status === "error") {
            stopProgress(id);
            fail(id, "The enhancement thread failed");
            cleanupChildThread(childThreadId);
          }
        } catch {
          // Stale handle or the child is gone — either way stop polling;
          // the lifecycle events still resolve the enhancement.
          stopProgress(id);
        }
      })();
    }, PROGRESS_POLL_MS);
    progressTimers.set(id, timer);
  }

  // Provider/model catalog. Menu opens always answer from cache; a stale
  // cache is served immediately and refreshed in the background
  // (stale-while-revalidate), and concurrent loads share one fetch.
  let catalogCache: { at: number; catalog: ModelCatalog } | null = null;
  let catalogInflight: Promise<ModelCatalog> | null = null;

  function refreshCatalog(): Promise<ModelCatalog> {
    catalogInflight ??= (async () => {
      const available = (
        await withTimeout(
          bb.sdk.providers.list({}),
          PROVIDER_CALL_TIMEOUT_MS,
          "providers.list",
        )
      ).filter((provider) => provider.available);
      // allSettled + per-call timeout: one hung or broken provider must not
      // sink the whole catalog (or block a handler awaiting this fetch).
      const settled = await Promise.allSettled(
        available.map(async (provider) => {
          const result = await withTimeout(
            bb.sdk.providers.models({ providerId: provider.id }),
            PROVIDER_CALL_TIMEOUT_MS,
            `providers.models(${provider.id})`,
          );
          return {
            id: provider.id,
            displayName: provider.displayName,
            models: result.models.map((model) => ({
              model: model.model,
              displayName: model.displayName,
              isDefault: model.isDefault,
            })),
          };
        }),
      );
      const catalog: ModelCatalog = {
        providers: settled
          .filter(
            (result): result is PromiseFulfilledResult<ModelCatalog["providers"][number]> =>
              result.status === "fulfilled",
          )
          .map((result) => result.value)
          // Providers with an empty catalog (e.g. no curated models) would
          // render as a bare group heading in the dropdown.
          .filter((provider) => provider.models.length > 0),
      };
      catalogCache = { at: Date.now(), catalog };
      if (catalog.providers.length > 0) {
        // Persist so the next plugin load answers listModels from cache
        // instantly instead of re-running provider discovery in a handler.
        void bb.storage.kv
          .set(CATALOG_CACHE_KEY, catalogCache)
          .catch(() => {});
      }
      return catalog;
    })().finally(() => {
      catalogInflight = null;
    });
    return catalogInflight;
  }

  async function loadModelCatalog(): Promise<ModelCatalog> {
    if (catalogCache !== null) {
      if (Date.now() - catalogCache.at >= CATALOG_TTL_MS) {
        // Detached refresh; a failure only means the next open retries.
        void refreshCatalog().catch(() => {});
      }
      return catalogCache.catalog;
    }
    return refreshCatalog();
  }

  // Seed the in-memory cache from the persisted copy so handlers answer
  // instantly even right after a plugin reload (the fetch itself may take
  // seconds and previously ran inline in the first listModels call).
  try {
    const persisted = await bb.storage.kv.get<{
      at: number;
      catalog: unknown;
    }>(CATALOG_CACHE_KEY);
    if (persisted) {
      const parsed = modelCatalogSchema.safeParse(persisted.catalog);
      if (parsed.success) {
        catalogCache = { at: persisted.at, catalog: parsed.data };
      }
    }
  } catch {
    // A corrupt cache entry just means the pre-warm below rebuilds it.
  }

  // Pre-warm the catalog so the first dropdown open doesn't wait on provider
  // discovery. Detached: must never reject into the host.
  void refreshCatalog().catch(() => {});

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
    attachmentCount: number,
  ): Promise<void> {
    try {
      let resolvedProjectId = projectId;
      let providerId: string | undefined;
      let threadTitle: string | null = null;
      let lastOutput: string | null = null;
      if (threadId !== null) {
        const parent = await bb.sdk.threads.get({ threadId });
        resolvedProjectId = parent.projectId;
        providerId = parent.providerId;
        threadTitle = parent.title ?? null;
        // Context is best-effort: a rewrite without it is still correct, so
        // an output fetch failure must never sink the enhancement.
        try {
          const { output } = await withTimeout(
            bb.sdk.threads.output({ threadId }),
            PROVIDER_CALL_TIMEOUT_MS,
            "threads.output",
          );
          if (output !== null && output.trim().length > 0) {
            lastOutput = output.trim().slice(-CONTEXT_OUTPUT_CAP);
          }
        } catch {
          // Proceed without conversation context.
        }
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
      const [override, settingsValues] = await Promise.all([
        bb.storage.kv.get<ModelOverride>(OVERRIDE_KEY).then((v) => v ?? null),
        settings.get(),
      ]);
      const customRaw = (settingsValues.customInstructions ?? "").trim();
      // The builder caps the length itself; only presence matters here.
      const customInstructions = customRaw.length > 0 ? customRaw : null;
      const child = await bb.sdk.threads.spawn({
        projectId: resolvedProjectId,
        environment: { type: "project-default" },
        // An explicit override wins. Otherwise inherit the scope thread's
        // provider (model stays at that provider's default); on the
        // new-thread composer omit both so spawn uses the project default.
        ...(override
          ? { providerId: override.providerId, model: override.model }
          : providerId
            ? { providerId }
            : {}),
        // Deliberately NOT parented to the scope thread: a hidden child
        // reports its completion to its parent, which would inject the
        // rewritten prompt into that thread's conversation. The rewrite
        // belongs in the composer draft, never the timeline.
        visibility: "hidden",
        title: "Enhance prompt",
        prompt: buildEnhancePrompt(text, {
          kind: threadId === null ? "new-task" : "follow-up",
          attachmentCount,
          threadTitle,
          lastOutput,
          customInstructions,
        }),
      });
      setChildThread.run(child.id, id);
      // The user may have cancelled while spawn was in flight; the child is
      // already running, so reap it here instead of leaking it.
      const row = byId.get(id) as EnhancementRow | undefined;
      if (row === undefined || row.status !== "pending") {
        cleanupChildThread(child.id);
      } else {
        startProgress(id, child.id);
      }
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
    async startEnhance({ text, threadId, projectId, attachmentCount }) {
      const id = crypto.randomUUID();
      // Model key drives the adaptive timeout: history for THIS model is the
      // only meaningful predictor. All lookups are local and best-effort.
      let modelKey = "inherit:default";
      try {
        const override =
          (await bb.storage.kv.get<ModelOverride>(OVERRIDE_KEY)) ?? null;
        if (override !== null) {
          modelKey = `${override.providerId}:${override.model}`;
        } else if (threadId !== null) {
          const parent = await bb.sdk.threads.get({ threadId });
          if (parent.providerId) modelKey = `inherit:${parent.providerId}`;
        }
      } catch {
        // Fall back to the default key; the timeout just adapts less finely.
      }
      const durations = (recentDurations.all(modelKey) as {
        duration_ms: number;
      }[]).map((row) => row.duration_ms);
      const timeoutMs = adaptiveTimeoutMs(durations);
      insertPending.run(id, threadId, text, modelKey, Date.now());
      // NON-BLOCKING: completion arrives via thread.idle / thread.failed below.
      void runEnhance(id, text, threadId, projectId, attachmentCount);
      return { id, timeoutMs };
    },
    getEnhancement({ id }) {
      const row = byId.get(id) as EnhancementRow | undefined;
      return { enhancement: row ? toEnhancement(row) : null };
    },
    cancelEnhance({ id }) {
      const row = byId.get(id) as EnhancementRow | undefined;
      if (row === undefined || row.status !== "pending") return {};
      markCancelled.run(id);
      stopProgress(id);
      cleanupChildThread(row.child_thread_id);
      return {};
    },
    async listModels() {
      return loadModelCatalog();
    },
    async getModelOverride() {
      const override =
        (await bb.storage.kv.get<ModelOverride>(OVERRIDE_KEY)) ?? null;
      return { override };
    },
    async setModelOverride({ override }) {
      if (override === null) {
        await bb.storage.kv.delete(OVERRIDE_KEY);
        return {};
      }
      // Validate against the cached catalog only — never await provider
      // discovery inside this handler. With no cache yet, skip validation;
      // an invalid pair surfaces later as a clear enhancement error from
      // spawn. Kick a background refresh so the cache exists next time.
      const catalog: ModelCatalog | null = catalogCache?.catalog ?? null;
      if (catalog === null) {
        void refreshCatalog().catch(() => {});
      }
      if (catalog !== null) {
        const known = catalog.providers.some(
          (provider) =>
            provider.id === override.providerId &&
            provider.models.some((model) => model.model === override.model),
        );
        if (!known) {
          throw new Error(
            `Model ${override.model} is not available for provider ${override.providerId}`,
          );
        }
      }
      await bb.storage.kv.set(OVERRIDE_KEY, override);
      return {};
    },
    async getPrefs() {
      const settingsValues = await settings.get();
      return { previewBeforeApply: settingsValues.previewBeforeApply };
    },
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const row = pendingByChild.get(thread.id) as EnhancementRow | undefined;
    if (!row) return;
    stopProgress(row.id);
    const enhanced = (lastAssistantText ?? "").trim();
    if (enhanced.length === 0) {
      fail(row.id, "The enhancement thread returned an empty response");
    } else {
      markDone.run(enhanced, Date.now() - row.created_at, row.id);
      publish(row.id, "done");
    }
    cleanupChildThread(thread.id);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    const row = pendingByChild.get(thread.id) as EnhancementRow | undefined;
    if (!row) return;
    stopProgress(row.id);
    fail(row.id, error ?? "The enhancement thread failed");
    cleanupChildThread(thread.id);
  });
}
