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
  Fragment,
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
import {
  formatMissing,
  missingReferences,
} from "@/lib/references";
import { nextShown, REVEAL_TICK_MS } from "@/lib/reveal";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = isMac ? "⌘E" : "Ctrl+E";
/** One-shot settle sweep duration; keep in sync with the CSS animation. */
const SETTLE_MS = 950;
/** Timeout used if startEnhance somehow returns without one. */
const FALLBACK_TIMEOUT_MS = 90_000;

interface EnhanceSignal {
  id?: string;
  status?: "done" | "error" | "progress";
  /** Present on "progress": the child thread's partial output so far. */
  text?: string;
}
type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max"
  | "ultra";
interface ModelOverride {
  providerId: string;
  model: string;
  reasoningLevel?: ReasoningLevel | null;
}
interface CatalogModel {
  model: string;
  displayName: string;
  isDefault: boolean;
  reasoningLevels: ReasoningLevel[];
  defaultReasoningLevel: ReasoningLevel | null;
}
interface ModelCatalog {
  providers: {
    id: string;
    displayName: string;
    models: CatalogModel[];
  }[];
}
/** Title-case a reasoning level for display ("xhigh" → "XHigh"). */
function levelLabel(level: ReasoningLevel): string {
  if (level === "xhigh") return "XHigh";
  return level.charAt(0).toUpperCase() + level.slice(1);
}
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type ComposerScope = ReturnType<typeof useComposerView>["scope"];

/** One key per composer draft, shared by every state map below. */
function scopeKey(scope: ComposerScope): string {
  if (scope.kind === "thread" || scope.kind === "queued-message")
    return scope.threadId;
  if (scope.kind === "side-chat")
    return scope.childThreadId ?? scope.parentThreadId;
  if (scope.kind === "new-thread") return `new:${scope.projectId ?? ""}`;
  // Exhaustive today; future scope kinds fall back to their kind tag.
  return (scope as { kind: string }).kind;
}

// ---------------------------------------------------------------------------
// Module state that must survive unmounts and scope switches (per window)
// ---------------------------------------------------------------------------

/**
 * In-flight enhancement per composer scope. Lives at module level so
 * switching threads mid-run doesn't lose the enhancement: the server keeps
 * working, and when a composer for this scope mounts again it resumes from
 * here (re-locks, re-arms the deadline, and picks up the finished result).
 */
interface PendingRun {
  id: string;
  originalText: string;
  previewGate: boolean;
  /** Absolute time after which this run counts as timed out. */
  deadline: number;
  /** Structured @-mention labels captured from the draft at start. */
  mentionLabels: readonly string[];
}
const pendingRuns = new Map<string, PendingRun>();

/**
 * Latest structured @-mention labels per scope, from the composer's
 * richText observer — ground truth for the dropped-reference guard.
 */
const mentionLabelsByScope = new Map<string, readonly string[]>();

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
  background-repeat: no-repeat;
  animation: prompt-enhancer-sweep 1.4s linear infinite;
}
/* Text effects use TWO gradient layers clipped to the glyphs: a moving
   non-repeating band on top of a solid base. The solid underlay means text
   outside the band always renders at exactly the base color — no repeated
   ghost bands drifting through, and (for the settle) an end state identical
   to normal text, so removing the class is invisible.
   90deg on purpose: the band must vary along x only, so it crosses every
   wrapped line at the same spot; a diagonal band reads as blotches. */
.prompt-enhancer-draft {
  background-image:
    linear-gradient(
      90deg,
      transparent 38%,
      var(--foreground) 50%,
      transparent 62%
    ),
    linear-gradient(
      90deg,
      color-mix(in oklab, var(--foreground) 70%, transparent),
      color-mix(in oklab, var(--foreground) 70%, transparent)
    );
  background-size: 250% 100%, 100% 100%;
  background-repeat: no-repeat;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: prompt-enhancer-sweep 1.4s linear infinite;
}
.prompt-enhancer-settle {
  background-image:
    linear-gradient(
      90deg,
      transparent 40%,
      var(--primary) 50%,
      transparent 60%
    ),
    linear-gradient(90deg, var(--foreground), var(--foreground));
  background-size: 250% 100%, 100% 100%;
  background-repeat: no-repeat;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  /* fill-mode both: holds the band offscreen at the end, so the text sits
     at plain foreground until the class is removed — no end-of-sweep snap. */
  animation: prompt-enhancer-sweep 0.9s cubic-bezier(0.16, 1, 0.3, 1) 1 both;
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
    "flex h-7 items-center justify-center text-muted-foreground",
    "transition-[color,background-color,transform] duration-150",
    "hover:bg-state-hover hover:text-foreground",
    "active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100",
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
  /** Structured mention labels snapshotted when the pending run started. */
  const mentionLabelsRef = useRef<readonly string[]>([]);
  /** Live reveal state; null when no reveal is running. */
  const revealRef = useRef<{
    target: string;
    shown: number;
    done: boolean;
  } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = usePickerState();
  const myScopeKey = scopeKey(view.scope);

  // Eagerly warm the shared store so the tooltip and check marks reflect the
  // remembered selection without opening the picker first.
  useEffect(() => {
    ensurePickerLoaded(rpc);
  }, [rpc]);

  // While busy the spark half stays enabled — it becomes the cancel button.
  // A running agent does NOT disable enhancing: drafting while the agent
  // works is exactly when a queued prompt gets refined.
  const startDisabled = busy || view.draft.isEmpty;
  const disabled = !busy && view.draft.isEmpty;

  const overrideLabel = (() => {
    if (picker.override === null) return null;
    const provider = picker.catalog?.providers.find(
      (entry) => entry.id === picker.override?.providerId,
    );
    const model = provider?.models.find(
      (entry) => entry.model === picker.override?.model,
    );
    const level = picker.override.reasoningLevel;
    const suffix = level ? ` · ${levelLabel(level)}` : "";
    return model === undefined || provider === undefined
      ? `${picker.override.model}${suffix}`
      : `${provider.displayName} · ${model.displayName}${suffix}`;
  })();

  function stopTimers(): void {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (revealTimerRef.current !== null) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    revealRef.current = null;
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function clearPending(): void {
    stopTimers();
    pendingRuns.delete(myScopeKey);
    pendingIdRef.current = null;
    setBusy(false);
    setCancelHover(false);
    composer.setInputLock(false);
    composer.setTextEffect(null);
  }

  /**
   * A cancelled/failed/timed-out run may have revealed partial output into
   * the composer; the draft must come back, not the half-rewrite.
   */
  function abortReveal(): void {
    const hadReveal = revealRef.current !== null;
    if (revealTimerRef.current !== null) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    revealRef.current = null;
    if (!hadReveal) return;
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
    // Structured mention labels are ground truth, regex covers the rest.
    const missing = missingReferences(original, enhanced, mentionLabelsRef.current);
    if (missing.length > 0) {
      toast.warning(
        `The rewrite may have dropped: ${formatMissing(missing)} — check before sending.`,
      );
    }
  }

  // Input lock and text effect are plugin-scoped and auto-release on
  // unmount/scope change; the timers need explicit cleanup.
  useEffect(() => stopTimers, []);

  /** The reveal reached its final text: sweep, notify, release. */
  function completeReveal(finalText: string): void {
    if (revealTimerRef.current !== null) {
      clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
    revealRef.current = null;
    setBusy(false);
    setCancelHover(false);
    composer.setInputLock(false);
    composer.setTextEffect({ className: "prompt-enhancer-settle" });
    notifyEnhanced(finalText);
    settleTimerRef.current = setTimeout(() => {
      try {
        composer.setTextEffect(null);
        composer.focus();
      } catch {
        // Composer gone; the host released lock and effect already.
      }
    }, SETTLE_MS);
  }

  /**
   * Feed text into the reveal engine. Called with partial output as it
   * arrives and with the final text (done=true); the engine types toward
   * whatever the current target is, easing out as it catches up, so one big
   * block and a trickle of chunks look equally alive. Any failure falls back
   * to an instant setText — the rewrite must never be lost to an animation.
   */
  function feedReveal(text: string, done: boolean): void {
    if (done) {
      // The result is in hand: it can no longer be cancelled or time out.
      pendingIdRef.current = null;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
    if (prefersReducedMotion()) {
      // Reduced motion: no typing choreography, content lands instantly.
      try {
        composer.setText(text);
      } catch {
        // Composer gone mid-flight; the host released lock/effect.
      }
      if (done) {
        revealRef.current = null;
        notifyEnhanced(text);
        clearPending();
        try {
          composer.focus();
        } catch {
          // Best-effort.
        }
      }
      return;
    }
    const state = revealRef.current ?? { target: "", shown: 0, done: false };
    revealRef.current = state;
    // The final text always wins; partials only ever extend the target.
    if (done || text.length > state.target.length) state.target = text;
    if (done) state.done = true;
    if (revealTimerRef.current !== null) return;
    // First feed: typing begins — swap the dimmed waiting shimmer for fully
    // readable text so the arriving rewrite is legible as it types.
    try {
      composer.setTextEffect(null);
    } catch {
      // Composer gone; the resolution paths handle the rest.
    }
    revealTimerRef.current = setInterval(() => {
      const current = revealRef.current;
      if (current === null) return;
      try {
        if (current.shown < current.target.length) {
          current.shown = nextShown(current.shown, current.target.length);
          composer.setText(current.target.slice(0, current.shown));
        }
        if (current.done && current.shown >= current.target.length) {
          completeReveal(current.target);
        }
      } catch {
        // The composer went away mid-reveal (scope change/unmount) — land
        // the text if at all possible; never lose it to the animation.
        try {
          composer.setText(current.target);
        } catch {
          // Truly gone.
        }
        clearPending();
      }
    }, REVEAL_TICK_MS);
  }

  /** The run for this scope finished successfully: preview or reveal. */
  function resolveDone(enhanced: string): void {
    pendingRuns.delete(myScopeKey);
    if (previewGateRef.current) {
      // Review mode: release the composer untouched and let the user
      // decide in the preview dialog.
      clearPending();
      setPreview({ original: originalTextRef.current, enhanced });
      return;
    }
    // The engine finishes typing whatever remains, then settles.
    feedReveal(enhanced, true);
  }

  function armTimeout(id: string, ms: number): void {
    timeoutRef.current = setTimeout(() => {
      if (pendingIdRef.current === id) {
        // Tell the backend too so the hidden thread is stopped and reaped,
        // not left running toward a result nobody will read.
        void rpc.call("cancelEnhance", { id }).catch(() => {});
        abortReveal();
        clearPending();
        toast.error("Enhancement timed out");
      }
    }, ms);
  }

  useRealtime("prompt-enhancer", (payload) => {
    const signal = payload as EnhanceSignal;
    const run = pendingRuns.get(myScopeKey);
    if (
      run === undefined ||
      signal.id !== run.id ||
      pendingIdRef.current !== run.id
    )
      return;
    if (signal.status === "progress") {
      // Genuine partial output from the child thread. Preview mode keeps the
      // draft untouched until the user applies, so live paint is skipped.
      if (previewGateRef.current || typeof signal.text !== "string") return;
      feedReveal(signal.text, false);
      return;
    }
    void (async () => {
      try {
        const { enhancement } = await rpc.call("getEnhancement", {
          id: run.id,
        });
        if (enhancement?.status === "done" && enhancement.enhanced) {
          resolveDone(enhancement.enhanced);
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
      abortReveal();
      clearPending();
    })();
  });

  // Resume an in-flight run when a composer for this scope (re)mounts —
  // switching threads mid-enhancement must not lose the work. Re-locks,
  // re-arms the remaining deadline, and catches up on a completion that
  // happened while no composer for this scope was mounted.
  useEffect(() => {
    const run = pendingRuns.get(myScopeKey);
    if (run === undefined) return () => stopTimers();
    pendingIdRef.current = run.id;
    previewGateRef.current = run.previewGate;
    originalTextRef.current = run.originalText;
    mentionLabelsRef.current = run.mentionLabels;
    revealRef.current = null;
    setBusy(true);
    composer.setInputLock(true);
    composer.setTextEffect({ className: "prompt-enhancer-draft" });
    const remaining = run.deadline - Date.now();
    if (remaining <= 0) {
      void rpc.call("cancelEnhance", { id: run.id }).catch(() => {});
      clearPending();
      toast.error("Enhancement timed out");
      return () => stopTimers();
    }
    armTimeout(run.id, remaining);
    void (async () => {
      try {
        const { enhancement } = await rpc.call("getEnhancement", {
          id: run.id,
        });
        if (pendingIdRef.current !== run.id) return;
        if (enhancement?.status === "done" && enhancement.enhanced) {
          resolveDone(enhancement.enhanced);
        } else if (enhancement?.status === "error") {
          toast.error(enhancement.error ?? "Enhancement failed");
          clearPending();
        } else if (enhancement?.status === "cancelled") {
          clearPending();
        }
        // Still pending: realtime signals and the timeout take it from here.
      } catch {
        // Realtime signals and the timeout still cover this run.
      }
    })();
    return () => stopTimers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myScopeKey]);

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
    let timeoutMs = FALLBACK_TIMEOUT_MS;
    try {
      ({ id, timeoutMs } = await rpc.call("startEnhance", {
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
    const mentionLabels = mentionLabelsByScope.get(myScopeKey) ?? [];
    pendingRuns.set(myScopeKey, {
      id,
      originalText: composer.text,
      previewGate: previewGateRef.current,
      deadline: Date.now() + timeoutMs,
      mentionLabels,
    });
    pendingIdRef.current = id;
    originalTextRef.current = composer.text;
    mentionLabelsRef.current = mentionLabels;
    revealRef.current = null;
    setBusy(true);
    composer.setInputLock(true);
    composer.setTextEffect({ className: "prompt-enhancer-draft" });
    armTimeout(id, timeoutMs);
  }

  function cancel(): void {
    const id = pendingIdRef.current;
    if (id === null) return;
    void rpc.call("cancelEnhance", { id }).catch(() => {});
    abortReveal();
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
          : `Enhancer model: ${next.model}${
              next.reasoningLevel ? ` · ${levelLabel(next.reasoningLevel)}` : ""
            }`,
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
                    // Reasoning levels expand under the selected model —
                    // same progressive disclosure as bb's own composer
                    // picker, so the list stays scannable.
                    const showLevels = selected && model.reasoningLevels.length > 1;
                    return (
                      <Fragment key={`${provider.id}:${model.model}`}>
                        <CommandItem
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
                              // Keep the level when re-picking the same
                              // model; a different model starts at default.
                              reasoningLevel: selected
                                ? (picker.override?.reasoningLevel ?? null)
                                : null,
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
                        {showLevels
                          ? model.reasoningLevels.map((level) => {
                              const levelSelected =
                                (picker.override?.reasoningLevel ?? null) ===
                                  level ||
                                (picker.override?.reasoningLevel == null &&
                                  model.defaultReasoningLevel === level);
                              return (
                                <CommandItem
                                  key={`${provider.id}:${model.model}:${level}`}
                                  value={`${provider.id}:${model.model}:${level}`}
                                  keywords={[
                                    model.displayName,
                                    "thinking",
                                    "reasoning",
                                    "effort",
                                    level,
                                  ]}
                                  onSelect={() =>
                                    void selectOverride({
                                      providerId: provider.id,
                                      model: model.model,
                                      reasoningLevel: level,
                                    })
                                  }
                                >
                                  <Icon
                                    name="Check"
                                    className={
                                      levelSelected ? undefined : "invisible"
                                    }
                                    aria-hidden
                                  />
                                  <span className="truncate pl-4 text-xs text-muted-foreground">
                                    {levelLabel(level)}
                                  </span>
                                  {model.defaultReasoningLevel === level ? (
                                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                                      default
                                    </span>
                                  ) : null}
                                </CommandItem>
                              );
                            })
                          : null}
                      </Fragment>
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
    richText: {
      // Ground truth for the dropped-reference guard: the composer's
      // structured @-mentions, tracked per scope as the draft changes.
      onDraftChange(draft, view) {
        mentionLabelsByScope.set(
          scopeKey(view.scope),
          draft.mentions.map((mention) => mention.label),
        );
      },
    },
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
