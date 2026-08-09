// bb-plugin-prompt-enhancer — frontend entry.
//
// Adds a unified "Enhance prompt" control to every composer: the spark half
// rewrites the draft via the backend (a hidden bb thread), the chevron half
// opens a searchable model picker (popover + command palette) to pin an
// explicit provider+model for the enhancement (default: inherit the current
// thread's provider, or the project default on the new-thread composer).
// While an enhancement runs, the control shimmers and the draft gets an
// animated text effect; the spark half doubles as a cancel button. The
// rewrite then streams into the composer, settles with a one-shot accent
// sweep, and offers Undo via the success toast. All motion collapses to
// instant replacement under prefers-reduced-motion.
//
// The catalog + selection live in a module store: one fetch per window,
// shared by every composer instance (a per-instance fetch would turn every
// composer mount into a round trip).
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  definePluginApp,
  useComposer,
  useComposerView,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const TIMEOUT_MS = 90_000;
const STREAM_TICK_MS = 24;
/** Reveal duration scales with rewrite length so short rewrites feel snappy. */
function streamDurationMs(length: number): number {
  return Math.min(1400, Math.max(350, length * 5));
}
const isMac = navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = isMac ? "⌘E" : "Ctrl+E";
/** How long the one-shot settle sweep plays before the draft returns to normal. */
const SETTLE_MS = 1100;

interface EnhanceSignal {
  id?: string;
  status?: "done" | "error" | "progress";
  /** Present on "progress": the child thread's partial output so far. */
  text?: string;
}
interface ModelOverride {
  providerId: string;
  model: string;
}
interface ModelCatalog {
  providers: {
    id: string;
    displayName: string;
    models: { model: string; displayName: string; isDefault: boolean }[];
  }[];
}
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

/**
 * Live references the rewriter is told to preserve verbatim: @mentions,
 * URLs, inline code spans, and anything path-shaped. Used to warn when a
 * rewrite drops one — the model promises, this verifies.
 */
function extractReferences(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.match(/https?:\/\/[^\s)"']+/g) ?? []) out.add(match);
  for (const match of text.match(/(?:^|\s)@[\w./-]{2,}/g) ?? [])
    out.add(match.trim());
  for (const match of text.match(/`[^`\n]+`/g) ?? [])
    out.add(match.slice(1, -1));
  for (const match of text.match(/[\w.-]+\/[\w./-]+/g) ?? []) out.add(match);
  return [...out].filter((token) => token.length > 2);
}

function missingReferences(original: string, enhanced: string): string[] {
  return extractReferences(original).filter(
    (token) => !enhanced.includes(token),
  );
}

function formatMissing(missing: string[]): string {
  const shown = missing.slice(0, 3).join(", ");
  return missing.length > 3 ? `${shown}, …` : shown;
}

// ---------------------------------------------------------------------------
// Shared catalog/selection store (per window)
// ---------------------------------------------------------------------------

interface PickerState {
  loaded: boolean;
  /** The last load attempt failed; the next picker open retries. */
  failed: boolean;
  catalog: ModelCatalog | null;
  override: ModelOverride | null;
}

let pickerState: PickerState = {
  loaded: false,
  failed: false,
  catalog: null,
  override: null,
};
let pickerInflight: Promise<void> | null = null;
const pickerListeners = new Set<() => void>();

function pickerSubscribe(listener: () => void): () => void {
  pickerListeners.add(listener);
  return () => pickerListeners.delete(listener);
}

function pickerNotify(): void {
  for (const listener of pickerListeners) listener();
}

/** Single shared fetch; safe to call from every composer instance. */
function ensurePickerLoaded(rpc: Rpc): void {
  if (pickerState.loaded || pickerInflight !== null) return;
  if (pickerState.failed) {
    // A retry is starting — show "Loading…" again instead of the stale error.
    pickerState = { ...pickerState, failed: false };
    pickerNotify();
  }
  pickerInflight = (async () => {
    try {
      const [modelsResult, overrideResult] = await Promise.all([
        rpc.call("listModels"),
        rpc.call("getModelOverride"),
      ]);
      pickerState = {
        loaded: true,
        failed: false,
        catalog: modelsResult,
        override: overrideResult.override,
      };
    } catch {
      // Leave unloaded but flag the failure so the picker can say so
      // instead of showing an eternal "Loading…"; the next open retries.
      pickerState = { ...pickerState, failed: true };
    } finally {
      pickerInflight = null;
      pickerNotify();
    }
  })();
}

function setSharedOverride(next: ModelOverride | null): void {
  pickerState = { ...pickerState, override: next };
  pickerNotify();
}

function usePickerState(): PickerState {
  return useSyncExternalStore(
    pickerSubscribe,
    () => pickerState,
    () => pickerState,
  );
}

// ---------------------------------------------------------------------------
// Animation styles — raw CSS because keyframes cannot come from the Tailwind
// pass. Injected by a content script (the sanctioned escape hatch), removed
// on dispose. Colors derive from host theme tokens only — never hardcoded.
// (Not currentColor for the draft: the gradient-text trick sets
// color: transparent, which would make currentColor transparent too.)
// ---------------------------------------------------------------------------

const SHIMMER_CSS = `
@keyframes prompt-enhancer-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.prompt-enhancer-pill-busy {
  background-image: linear-gradient(
    110deg,
    transparent 25%,
    color-mix(in oklab, currentColor 16%, transparent) 50%,
    transparent 75%
  );
  background-size: 250% 100%;
  animation: prompt-enhancer-sweep 1.4s linear infinite;
}
.prompt-enhancer-draft {
  /* 90deg on purpose: the gradient must vary along x only, so the bright
     band crosses every wrapped line at the same spot. A diagonal band hits
     each line at a different x and reads as blotches on multi-line drafts. */
  background-image: linear-gradient(
    90deg,
    color-mix(in oklab, var(--foreground) 55%, transparent) 30%,
    var(--foreground) 50%,
    color-mix(in oklab, var(--foreground) 55%, transparent) 70%
  );
  background-size: 220% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: prompt-enhancer-sweep 1.4s linear infinite;
}
.prompt-enhancer-settle {
  /* 90deg for the same multi-line reason as .prompt-enhancer-draft. */
  background-image: linear-gradient(
    90deg,
    var(--foreground) 32%,
    var(--primary) 50%,
    var(--foreground) 68%
  );
  background-size: 220% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: prompt-enhancer-sweep 1s ease-in-out 1;
}
@media (prefers-reduced-motion: reduce) {
  .prompt-enhancer-pill-busy,
  .prompt-enhancer-draft,
  .prompt-enhancer-settle {
    animation: none;
  }
  .prompt-enhancer-draft,
  .prompt-enhancer-settle {
    background-image: none;
    color: inherit;
  }
}
`;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---------------------------------------------------------------------------
// Composer control
// ---------------------------------------------------------------------------

/** One half of the split control — chrome comes from the group wrapper. */
function groupHalfClass(extra?: string): string {
  return cn(
    "flex h-7 items-center justify-center text-muted-foreground transition-colors",
    "hover:bg-state-hover hover:text-foreground",
    "disabled:pointer-events-none disabled:opacity-50",
    extra,
  );
}

function EnhanceButton() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [cancelHover, setCancelHover] = useState(false);
  const [preview, setPreview] = useState<{
    original: string;
    enhanced: string;
  } | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  const originalTextRef = useRef<string>("");
  /** Whether the pending enhancement should preview instead of auto-apply. */
  const previewGateRef = useRef(false);
  /** True once live progress text has painted into the composer. */
  const liveRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = usePickerState();

  // Eagerly warm the shared store so the tooltip and check marks reflect the
  // remembered selection without opening the picker first.
  useEffect(() => {
    ensurePickerLoaded(rpc);
  }, [rpc]);

  // While busy the spark half stays enabled — it becomes the cancel button.
  const startDisabled = busy || view.draft.isEmpty || view.run.isRunning;
  const disabled = !busy && (view.draft.isEmpty || view.run.isRunning);

  const overrideLabel = (() => {
    if (picker.override === null) return null;
    const provider = picker.catalog?.providers.find(
      (entry) => entry.id === picker.override?.providerId,
    );
    const model = provider?.models.find(
      (entry) => entry.model === picker.override?.model,
    );
    return model === undefined || provider === undefined
      ? picker.override.model
      : `${provider.displayName} · ${model.displayName}`;
  })();

  function stopTimers(): void {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (streamTimerRef.current !== null) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function clearPending(): void {
    stopTimers();
    pendingIdRef.current = null;
    setBusy(false);
    setCancelHover(false);
    composer.setInputLock(false);
    composer.setTextEffect(null);
  }

  /**
   * A cancelled/failed/timed-out run may have live-streamed partial output
   * into the composer; the draft must come back, not the half-rewrite.
   */
  function restoreOriginalIfLive(): void {
    if (!liveRef.current) return;
    liveRef.current = false;
    try {
      composer.setText(originalTextRef.current);
    } catch {
      // Composer gone; nothing to restore into.
    }
  }

  /** Success toast with a one-tap way back to the pre-rewrite draft. */
  function notifyEnhanced(enhanced: string): void {
    const original = originalTextRef.current;
    toast.success("Prompt enhanced", {
      action: {
        label: "Undo",
        onClick: () => {
          try {
            composer.setText(original);
          } catch {
            // Composer scope is gone; nothing to restore into.
          }
        },
      },
    });
    // The prompt tells the model to preserve live references; this verifies.
    const missing = missingReferences(original, enhanced);
    if (missing.length > 0) {
      toast.warning(
        `The rewrite may have dropped: ${formatMissing(missing)} — check before sending.`,
      );
    }
  }

  /** Final text is in hand: replace, sweep, notify — no fake streaming. */
  function finishInstantly(finalText: string): void {
    try {
      composer.setText(finalText);
      composer.focus();
    } catch {
      // Composer gone mid-flight; the host already released lock/effect.
      notifyEnhanced(finalText);
      clearPending();
      return;
    }
    notifyEnhanced(finalText);
    stopTimers();
    pendingIdRef.current = null;
    setBusy(false);
    setCancelHover(false);
    composer.setInputLock(false);
    composer.setTextEffect({ className: "prompt-enhancer-settle" });
    settleTimerRef.current = setTimeout(() => {
      try {
        composer.setTextEffect(null);
      } catch {
        // Composer gone; the host released the effect already.
      }
    }, SETTLE_MS);
  }

  // Input lock and text effect are plugin-scoped and auto-release on
  // unmount/scope change; the timers need explicit cleanup.
  useEffect(() => stopTimers, []);

  /**
   * Reveal the rewrite: stream it into the locked composer while the shimmer
   * keeps running, then play one accent sweep through the final text and
   * release everything. Any failure falls back to an instant setText — the
   * rewrite must never be lost to an animation.
   */
  function revealEnhanced(finalText: string): void {
    // The result is in hand: the request can no longer be cancelled or time
    // out. Null the pending id so a late timeout or a cancel click during
    // the reveal can't clobber the stream and lose the rewrite.
    pendingIdRef.current = null;
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (prefersReducedMotion()) {
      try {
        composer.setText(finalText);
        composer.focus();
      } catch {
        // Composer gone mid-flight; the host already released lock/effect.
      }
      notifyEnhanced(finalText);
      clearPending();
      return;
    }
    const step = Math.max(
      1,
      Math.ceil(
        finalText.length / (streamDurationMs(finalText.length) / STREAM_TICK_MS),
      ),
    );
    let shown = 0;
    streamTimerRef.current = setInterval(() => {
      try {
        shown = Math.min(finalText.length, shown + step);
        composer.setText(finalText.slice(0, shown));
        if (shown >= finalText.length) {
          if (streamTimerRef.current !== null) {
            clearInterval(streamTimerRef.current);
            streamTimerRef.current = null;
          }
          composer.setTextEffect({ className: "prompt-enhancer-settle" });
          notifyEnhanced(finalText);
          settleTimerRef.current = setTimeout(() => {
            clearPending();
            try {
              composer.focus();
            } catch {
              // Composer gone; focus is best-effort.
            }
          }, SETTLE_MS);
        }
      } catch {
        // The composer went away mid-stream (scope change/unmount) — nothing
        // safe left to animate; the host has already released lock/effect.
        try {
          composer.setText(finalText);
        } catch {
          // truly gone
        }
        clearPending();
      }
    }, STREAM_TICK_MS);
  }

  useRealtime("prompt-enhancer", (payload) => {
    const signal = payload as EnhanceSignal;
    const pendingId = pendingIdRef.current;
    if (pendingId === null || signal.id !== pendingId) return;
    if (signal.status === "progress") {
      // Genuine partial output from the child thread. Preview mode keeps the
      // draft untouched until the user applies, so live paint is skipped.
      if (previewGateRef.current || typeof signal.text !== "string") return;
      try {
        composer.setText(signal.text);
        liveRef.current = true;
      } catch {
        // Composer gone; the resolution path handles the rest.
      }
      return;
    }
    void (async () => {
      try {
        const { enhancement } = await rpc.call("getEnhancement", {
          id: pendingId,
        });
        if (enhancement?.status === "done" && enhancement.enhanced) {
          if (previewGateRef.current) {
            // Review mode: release the composer untouched and let the user
            // decide in the preview dialog.
            clearPending();
            setPreview({
              original: originalTextRef.current,
              enhanced: enhancement.enhanced,
            });
            return;
          }
          if (liveRef.current) {
            // Real tokens already streamed in; just land the final text.
            finishInstantly(enhancement.enhanced);
            return;
          }
          // Fast model beat the first progress poll — animate the reveal.
          // The stream now owns the lock; it clears pending when done.
          revealEnhanced(enhancement.enhanced);
          return;
        } else if (enhancement?.status === "error") {
          toast.error(enhancement.error ?? "Enhancement failed");
        } else {
          // Still pending — keep waiting for the next signal or the timeout.
          return;
        }
      } catch {
        toast.error("Failed to fetch the enhanced prompt");
      }
      restoreOriginalIfLive();
      clearPending();
    })();
  });

  async function enhance(): Promise<void> {
    const text = composer.text.trim();
    if (!text || startDisabled) return;
    // Every composer flavor that knows its thread hands it over so the
    // enhancement inherits that thread's provider; only the new-thread
    // composer falls back to the project default.
    const scope = view.scope;
    const scopeThreadId =
      scope.kind === "thread" || scope.kind === "queued-message"
        ? scope.threadId
        : scope.kind === "side-chat"
          ? (scope.childThreadId ?? scope.parentThreadId)
          : null;
    const scopeProjectId = scope.kind === "new-thread" ? scope.projectId : null;
    // Read the preview toggle fresh per run so a settings change applies to
    // the very next enhancement, not the next window load.
    previewGateRef.current = await rpc
      .call("getPrefs")
      .then((prefs) => prefs.previewBeforeApply)
      .catch(() => false);
    let id: string;
    try {
      ({ id } = await rpc.call("startEnhance", {
        text,
        threadId: scopeThreadId,
        projectId: scopeProjectId,
        attachmentCount: view.draft.attachmentCount,
      }));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start enhancement",
      );
      return;
    }
    pendingIdRef.current = id;
    originalTextRef.current = composer.text;
    liveRef.current = false;
    setBusy(true);
    composer.setInputLock(true);
    composer.setTextEffect({ className: "prompt-enhancer-draft" });
    timeoutRef.current = setTimeout(() => {
      if (pendingIdRef.current === id) {
        // Tell the backend too so the hidden thread is stopped and reaped,
        // not left running toward a result nobody will read.
        void rpc.call("cancelEnhance", { id }).catch(() => {});
        restoreOriginalIfLive();
        clearPending();
        toast.error("Enhancement timed out");
      }
    }, TIMEOUT_MS);
  }

  function cancel(): void {
    const id = pendingIdRef.current;
    if (id === null) return;
    void rpc.call("cancelEnhance", { id }).catch(() => {});
    restoreOriginalIfLive();
    clearPending();
    toast("Enhancement cancelled");
  }

  function applyPreview(): void {
    if (preview === null) return;
    const { enhanced } = preview;
    setPreview(null);
    try {
      composer.setText(enhanced);
      composer.setTextEffect({ className: "prompt-enhancer-settle" });
      composer.focus();
    } catch {
      // Composer gone; nothing to apply into.
      return;
    }
    notifyEnhanced(enhanced);
    settleTimerRef.current = setTimeout(() => {
      try {
        composer.setTextEffect(null);
      } catch {
        // Composer gone; the host released the effect already.
      }
    }, SETTLE_MS);
  }

  function discardPreview(): void {
    setPreview(null);
    toast("Rewrite discarded");
  }

  // Cmd/Ctrl+E enhances from the keyboard. Ownership: only the instance whose
  // composer contains the focused editor may react, so multiple mounted
  // composers (thread, side chat) never double-fire.
  const enhanceRef = useRef<() => void>(() => {});
  enhanceRef.current = () => void enhance();
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
        return;
      if (event.key.toLowerCase() !== "e") return;
      const container = rootRef.current?.closest("[data-promptbox-main]");
      const active = document.activeElement;
      if (!container || active === null || !container.contains(active)) return;
      event.preventDefault();
      event.stopPropagation();
      enhanceRef.current();
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  async function selectOverride(next: ModelOverride | null): Promise<void> {
    setPickerOpen(false);
    try {
      await rpc.call("setModelOverride", { override: next });
      setSharedOverride(next);
      toast.success(
        next === null
          ? "Enhancer uses the thread's provider default"
          : `Enhancer model: ${next.model}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save the model",
      );
    }
  }

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Prompt enhancer"
      aria-busy={busy}
      className={cn(
        "flex items-center overflow-hidden rounded-md border border-input",
        busy && "prompt-enhancer-pill-busy",
      )}
    >
      <button
        type="button"
        className={groupHalfClass("w-7")}
        disabled={disabled}
        onClick={() => (busy ? cancel() : void enhance())}
        onMouseEnter={() => setCancelHover(true)}
        onMouseLeave={() => setCancelHover(false)}
        aria-label={busy ? "Cancel enhancement" : "Enhance prompt"}
        title={
          busy
            ? "Cancel enhancement"
            : overrideLabel === null
              ? `Enhance prompt (${SHORTCUT_HINT})`
              : `Enhance prompt (${SHORTCUT_HINT}) — ${overrideLabel}`
        }
      >
        <Icon
          name={busy ? (cancelHover ? "X" : "Loading") : "AiContentGenerator01"}
          className={cn("size-4", busy && !cancelHover && "animate-spin")}
          aria-hidden
        />
      </button>
      <div className="h-4 w-px bg-border" aria-hidden />
      <Popover
        open={pickerOpen}
        onOpenChange={(open) => {
          setPickerOpen(open);
          if (open) ensurePickerLoaded(rpc);
        }}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={groupHalfClass("w-5")}
            aria-label={
              overrideLabel === null
                ? "Choose enhancer model"
                : `Choose enhancer model (currently ${overrideLabel})`
            }
            title={
              overrideLabel === null
                ? "Choose enhancer model"
                : `Enhancer model: ${overrideLabel}`
            }
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Search models…" />
            <CommandList className="max-h-72">
              <CommandEmpty>
                {picker.loaded
                  ? "No models match your search."
                  : picker.failed
                    ? "Couldn't load models. Close and reopen to retry."
                    : "Loading models…"}
              </CommandEmpty>
              <CommandGroup heading="General">
                <CommandItem
                  value="provider-default"
                  keywords={["inherit", "thread", "project", "default"]}
                  onSelect={() => void selectOverride(null)}
                >
                  <Icon
                    name="Check"
                    className={picker.override === null ? undefined : "invisible"}
                    aria-hidden
                  />
                  <span className="truncate">Provider default</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    inherit
                  </span>
                </CommandItem>
              </CommandGroup>
              {picker.catalog?.providers.map((provider) => (
                <CommandGroup key={provider.id} heading={provider.displayName}>
                  {provider.models.map((model) => {
                    const selected =
                      picker.override !== null &&
                      picker.override.providerId === provider.id &&
                      picker.override.model === model.model;
                    return (
                      <CommandItem
                        key={`${provider.id}:${model.model}`}
                        value={`${provider.id}:${model.model}`}
                        keywords={[
                          provider.displayName,
                          model.displayName,
                          model.model,
                        ]}
                        onSelect={() =>
                          void selectOverride({
                            providerId: provider.id,
                            model: model.model,
                          })
                        }
                      >
                        <Icon
                          name="Check"
                          className={selected ? undefined : "invisible"}
                          aria-hidden
                        />
                        <span className="truncate">{model.displayName}</span>
                        {model.isDefault ? (
                          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                            default
                          </span>
                        ) : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) discardPreview();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Review enhanced prompt</DialogTitle>
            <DialogDescription>
              Apply replaces your draft — Undo stays available in the toast.
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-col gap-3">
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Original
              </div>
              <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-md border border-input bg-muted/40 p-2 text-xs text-muted-foreground">
                {preview?.original}
              </div>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
                Enhanced
              </div>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-input p-2 text-sm">
                {preview?.enhanced}
              </div>
            </div>
            {preview !== null &&
              (() => {
                const missing = missingReferences(
                  preview.original,
                  preview.enhanced,
                );
                return missing.length > 0 ? (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    May have dropped: {formatMissing(missing)}
                  </p>
                ) : null;
              })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={discardPreview}>
              Discard
            </Button>
            <Button onClick={applyPreview}>Apply</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompt-enhancer",
    actions: [{ id: "enhance", component: EnhanceButton }],
  });
  // Keyframes for the busy shimmer and the settle sweep. The Tailwind pass
  // cannot emit raw keyframes, so a content script injects them and cleans
  // up on dispose.
  app.contentScripts.register({
    id: "shimmer-styles",
    mount() {
      const style = document.createElement("style");
      style.setAttribute("data-prompt-enhancer", "");
      style.textContent = SHIMMER_CSS;
      document.head.appendChild(style);
      return () => style.remove();
    },
  });
});
