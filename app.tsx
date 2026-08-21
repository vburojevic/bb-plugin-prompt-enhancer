// bb-plugin-prompt-enhancer — frontend entry.
//
// Adds an "Enhance prompt" button to every composer: it rewrites the draft via
// the backend (a hidden bb thread). While an enhancement runs the button
// shimmers, the draft gets an animated text effect, and the button doubles as
// a cancel control. The rewrite then streams into the composer, settles with a
// one-shot accent sweep, and offers Undo via the success toast. All motion
// collapses to instant replacement under prefers-reduced-motion.
//
// Which provider+model does the rewriting is a settings-page choice
// (`ModelSettingsSection`), not a composer one — it is set once and rarely
// revisited, so it does not earn permanent real estate beside the draft.
// Without an explicit pin the enhancement inherits the current thread's
// provider, or the project default on the new-thread composer.
import { useEffect, useRef, useState } from "react";
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
  deadlineVerdict,
  type EnhancementSnapshot,
} from "@/lib/deadline";
import {
  formatMissing,
  missingReferences,
} from "@/lib/references";
import { scopeKey as scopeKeyOf } from "@/lib/scope-key";
import { nextShown, REVEAL_TICK_MS } from "@/lib/reveal";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const SHORTCUT_HINT = isMac ? "⌘E" : "Ctrl+E";
/** One-shot settle sweep duration; keep in sync with the CSS animation. */
const SETTLE_MS = 950;
/** Timeout used if startEnhance somehow returns without one. */
const FALLBACK_TIMEOUT_MS = 90_000;
/**
 * How often a run that outlived its predicted duration re-checks with the
 * server. It is a safety net for a completion signal that arrived while this
 * scope had no composer mounted; the run itself is never ended from here.
 */
const RESYNC_MS = 4_000;

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
type ComposerScope = ReturnType<typeof useComposerView>["scope"];

/** One key per composer draft — see `lib/scope-key`. */
function scopeKey(scope: ComposerScope): string {
  return scopeKeyOf(scope);
}

// ---------------------------------------------------------------------------
// Module state that must survive unmounts and scope switches (per window)
// ---------------------------------------------------------------------------

/**
 * In-flight enhancement per composer scope — a CACHE, not the record. The
 * record is the server row, which `resumeForScope` hands to whichever composer
 * mounts on the scope next; this map only lets a remount re-lock the draft in
 * the same frame instead of flashing an idle composer for one round trip. It
 * is therefore allowed to be empty (window reload, plugin reload, second
 * window) without anything being lost.
 */
interface PendingRun {
  id: string;
  originalText: string;
  previewGate: boolean;
  /** Absolute time after which the run is running longer than predicted. */
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
// Animation styles — raw CSS because keyframes cannot come from the Tailwind
// pass. Injected by a content script (the sanctioned escape hatch), removed
// on dispose. Colors derive from host theme tokens only — never hardcoded.
// (Not currentColor for the draft: the gradient-text trick sets
// color: transparent, which would make currentColor transparent too.)
// ---------------------------------------------------------------------------

const SHIMMER_CSS = `
@keyframes prompt-enhancer-pill-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
/* Only the band layer travels; the solid underlay stays pinned. */
@keyframes prompt-enhancer-text-sweep {
  from { background-position: -50vw 0, 0 0; }
  to { background-position: 50vw 0, 0 0; }
}
/* One-shot variant: starts and ends fully clear of the viewport, so there is
   no band on screen at either end of the settle. */
@keyframes prompt-enhancer-text-settle {
  from { background-position: -70vw 0, 0 0; }
  to { background-position: 110vw 0, 0 0; }
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
  animation: prompt-enhancer-pill-sweep 1.4s linear infinite;
}
/* Text effects use TWO gradient layers clipped to the glyphs: a moving
   non-repeating band on top of a solid base. The solid underlay means text
   outside the band always renders at exactly the base color — no repeated
   ghost bands drifting through, and (for the settle) an end state identical
   to normal text, so removing the class is invisible.

   background-attachment: fixed is load-bearing, not decoration. The host
   turns one whole-draft effect into ONE DECORATION SPAN PER DOCUMENT SEGMENT
   — per block, and again wherever a mention pill splits a paragraph's text
   nodes. Box-relative sizing therefore handed every span its own gradient box
   and its own sweep: short lines flashed while long ones crawled, and the
   band restarted at every mention. That is the "line by line" shimmer.
   Anchoring the background to the viewport gives every span one shared
   coordinate space, so a single band crosses the whole draft, hitting the
   same x on every line. (Under a transformed ancestor the anchor becomes that
   ancestor's box instead of the viewport — still one shared box, so the sweep
   stays unified.)

   The band's core sits at 50% of a 100vw image, so travelling -50vw → 50vw
   walks it across the viewport exactly once per cycle with no dead frame.
   90deg on purpose: the band must vary along x only, so it crosses every
   wrapped line at the same spot; a diagonal band reads as blotches. */
.prompt-enhancer-draft {
  background-image:
    linear-gradient(
      90deg,
      transparent 30%,
      var(--foreground) 50%,
      transparent 70%
    ),
    linear-gradient(
      90deg,
      color-mix(in oklab, var(--foreground) 62%, transparent),
      color-mix(in oklab, var(--foreground) 62%, transparent)
    );
  background-size: 100vw 100%, 100% 100%;
  background-repeat: no-repeat;
  background-attachment: fixed;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: prompt-enhancer-text-sweep 1.9s linear infinite;
}
.prompt-enhancer-settle {
  background-image:
    linear-gradient(
      90deg,
      transparent 34%,
      var(--primary) 50%,
      transparent 66%
    ),
    linear-gradient(90deg, var(--foreground), var(--foreground));
  background-size: 100vw 100%, 100% 100%;
  background-repeat: no-repeat;
  background-attachment: fixed;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  /* linear, not an ease-out: the band now travels a viewport-sized distance
     rather than a span-sized one, so front-loaded easing spent the whole
     sweep in the first ~0.15s and the accent never registered.
     fill-mode both: holds the band offscreen at both ends, so the text sits
     at plain foreground until the class is removed — no end-of-sweep snap. */
  animation: prompt-enhancer-text-settle 0.9s linear 1 both;
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

function EnhanceButton() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [cancelHover, setCancelHover] = useState(false);
  const [preview, setPreview] = useState<{
    /** The run behind this preview, acknowledged once the user decides. */
    id: string;
    original: string;
    enhanced: string;
  } | null>(null);
  const pendingIdRef = useRef<string | null>(null);
  /**
   * The run whose result is currently landing in the draft. Separate from
   * `pendingIdRef`, which is cleared the moment the text is in hand: delivery
   * is only acknowledged once the reveal actually finishes, so leaving the
   * thread mid-reveal leaves the run adoptable and it re-types on return.
   */
  const deliveringIdRef = useRef<string | null>(null);
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

  const myScopeKey = scopeKey(view.scope);

  // While busy the button stays enabled — it becomes the cancel button.
  // A running agent does NOT disable enhancing: drafting while the agent
  // works is exactly when a queued prompt gets refined.
  const startDisabled = busy || view.draft.isEmpty;
  const disabled = !busy && view.draft.isEmpty;

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
    // The whole rewrite is in the draft now — this is the moment delivery is
    // real, and the only moment the run stops being offered to this scope.
    if (deliveringIdRef.current !== null) {
      ackRun(deliveringIdRef.current);
      deliveringIdRef.current = null;
    }
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
        if (deliveringIdRef.current !== null) {
          ackRun(deliveringIdRef.current);
          deliveringIdRef.current = null;
        }
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

  /**
   * The run's result reached the user — in the draft, in the preview dialog's
   * verdict, or as an error toast. Until this lands, the server keeps offering
   * the run to whichever composer mounts on this scope, which is what makes
   * leaving mid-run lossless; without it, a delivered rewrite would be
   * re-applied on every later visit.
   */
  function ackRun(id: string): void {
    pendingRuns.delete(myScopeKey);
    void rpc.call("ackEnhancement", { id }).catch(() => {
      // Best-effort: an unacked row ages out of the resume window on its own.
    });
  }

  /** The run for this scope finished successfully: preview or reveal. */
  function resolveDone(id: string, enhanced: string): void {
    deliveringIdRef.current = id;
    if (previewGateRef.current) {
      // Review mode: release the composer untouched and let the user decide
      // in the preview dialog. The run stays adoptable until that decision,
      // so leaving with the dialog open brings the rewrite back on return.
      clearPending();
      deliveringIdRef.current = null;
      setPreview({ id, original: originalTextRef.current, enhanced });
      return;
    }
    // The engine finishes typing whatever remains, then settles.
    feedReveal(enhanced, true);
  }

  /**
   * Re-check with the server, then act on what it says. This is the ONLY
   * place a wait ends other than a realtime signal, and it can no longer end
   * one by force: a run the server still calls pending simply gets waited on
   * again. Killing healthy runs from a local clock was the bug — a rewrite
   * takes tens of seconds, so leaving the thread and coming back is normal
   * use, and the returning composer would reap the very run it came back for.
   * `ms` may be <= 0, which just means "check now".
   */
  function armResync(id: string, ms: number): void {
    // Only ever one re-sync in flight, so adopting a run twice (cache first,
    // then the server's answer) cannot leave an orphaned timer behind.
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(
      () => {
        void (async () => {
          if (pendingIdRef.current !== id) return;
          let snapshot: EnhancementSnapshot | null = null;
          let reachedServer = false;
          try {
            const { enhancement } = await rpc.call("getEnhancement", { id });
            reachedServer = true;
            if (enhancement) {
              snapshot = {
                status: enhancement.status,
                enhanced: enhancement.enhanced,
                error: enhancement.error,
              };
            }
          } catch {
            // Server unreachable; treat it as "no news" and try again.
          }
          if (pendingIdRef.current !== id) return;
          if (!reachedServer) {
            armResync(id, RESYNC_MS);
            return;
          }
          const verdict = deadlineVerdict(snapshot);
          if (verdict.kind === "deliver") {
            resolveDone(id, verdict.enhanced);
            return;
          }
          if (verdict.kind === "pending") {
            // Slower than predicted, not stuck. The server ends runs (it
            // reaps its own child thread); the composer only waits.
            armResync(id, RESYNC_MS);
            return;
          }
          if (verdict.kind === "error") {
            toast.error(verdict.message);
            ackRun(id);
          }
          if (verdict.kind === "unknown") ackRun(id);
          abortReveal();
          clearPending();
        })();
      },
      Math.max(0, ms),
    );
  }

  useRealtime("prompt-enhancer", (payload) => {
    const signal = payload as EnhanceSignal;
    const id = pendingIdRef.current;
    // Keyed off the run this composer is actually waiting on, not off the
    // module cache: after a reload the cache is empty while the wait, adopted
    // from the server, is entirely real.
    if (id === null || signal.id !== id) return;
    if (signal.status === "progress") {
      // Genuine partial output from the child thread. Preview mode keeps the
      // draft untouched until the user applies, so live paint is skipped.
      if (previewGateRef.current || typeof signal.text !== "string") return;
      feedReveal(signal.text, false);
      return;
    }
    // A terminal signal: let the shared re-sync path read the row and decide,
    // so realtime and polling can never disagree about what happens next. Only
    // the re-sync timer is rescheduled — a reveal already typing must keep its
    // state, or the arriving final text would re-type from the first character.
    armResync(id, 0);
  });

  /**
   * Take ownership of a run this composer may not have started: lock the
   * draft, restore the state the reveal and the dropped-reference guard need,
   * and either deliver a finished rewrite or go back to waiting.
   */
  function adoptRun(run: {
    id: string;
    originalText: string;
    previewGate: boolean;
    deadline: number;
    mentionLabels: readonly string[];
  }): void {
    pendingIdRef.current = run.id;
    previewGateRef.current = run.previewGate;
    originalTextRef.current = run.originalText;
    mentionLabelsRef.current = run.mentionLabels;
    revealRef.current = null;
    pendingRuns.set(myScopeKey, {
      id: run.id,
      originalText: run.originalText,
      previewGate: run.previewGate,
      deadline: run.deadline,
      mentionLabels: run.mentionLabels,
    });
    setBusy(true);
    composer.setInputLock(true);
    composer.setTextEffect({ className: "prompt-enhancer-draft" });
    // An expired deadline is NOT a failure: armResync(id, 0) asks the server
    // before deciding, and a run it still calls pending is simply waited on.
    armResync(run.id, Math.max(0, run.deadline - Date.now()));
  }

  // Pick up whatever this scope has in flight whenever a composer for it
  // (re)mounts. Rewrites take tens of seconds, so leaving the thread mid-run
  // is ordinary use and the composer that started the run is usually gone by
  // the time it lands. The module cache is only a flicker-free head start —
  // the server is asked every time, which is what makes this survive a window
  // reload, a plugin reload, and a second window as well as a thread switch.
  useEffect(() => {
    const cached = pendingRuns.get(myScopeKey);
    if (cached !== undefined) adoptRun(cached);
    let abandoned = false;
    void (async () => {
      try {
        const { run } = await rpc.call("resumeForScope", {
          scopeKey: myScopeKey,
        });
        if (abandoned || run === null) return;
        // Already landing this exact run (a done signal beat this round trip);
        // re-adopting would restart its reveal from the first character.
        if (deliveringIdRef.current === run.id) return;
        // A newer run started elsewhere (another window) wins over the cached
        // one; the same run just refreshes the state adopted above.
        if (pendingIdRef.current !== run.id || cached === undefined) {
          adoptRun(run);
        }
        if (run.status === "done" && run.enhanced) {
          resolveDone(run.id, run.enhanced);
        } else if (run.status === "error" || run.status === "done") {
          // "done" with no text is a server-side bug; surfacing it beats
          // leaving the draft locked against a run that will never deliver.
          toast.error(run.error ?? "Enhancement failed");
          ackRun(run.id);
          clearPending();
        }
        // Still pending: realtime signals and the re-sync take it from here.
      } catch {
        // Nothing in flight that we can see; the cached run (if any) still
        // has its own re-sync running.
      }
    })();
    return () => {
      abandoned = true;
      stopTimers();
    };
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
    const mentionLabels = mentionLabelsByScope.get(myScopeKey) ?? [];
    const originalText = composer.text;
    let id: string;
    let timeoutMs = FALLBACK_TIMEOUT_MS;
    try {
      // Everything a future composer needs to adopt this run travels with the
      // request: the run is owned by the scope, not by this component.
      ({ id, timeoutMs } = await rpc.call("startEnhance", {
        text,
        scopeKey: myScopeKey,
        threadId: scopeThreadId,
        projectId: scopeProjectId,
        attachmentCount: view.draft.attachmentCount,
        previewGate: previewGateRef.current,
        mentionLabels: [...mentionLabels],
      }));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start enhancement",
      );
      return;
    }
    adoptRun({
      id,
      originalText,
      previewGate: previewGateRef.current,
      deadline: Date.now() + timeoutMs,
      mentionLabels,
    });
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
    const { id, enhanced } = preview;
    setPreview(null);
    ackRun(id);
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
    if (preview !== null) ackRun(preview.id);
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

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="Prompt enhancer"
      aria-busy={busy}
      className="flex items-center"
    >
      {/* Same idiom as the Prompts plugin's composer button, so the row
          reads as one family: bordered 28px pill, muted-to-foreground on
          hover, size-4 icon. On a coarse pointer it grows to 36x40 — the
          size BB's own composer actions (expand, prompt actions, voice)
          take there, so the row stays one family on touch too instead of
          leaving this the one 28px target among 40px neighbours. */}
      <button
        type="button"
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-input",
          "max-md:pointer-coarse:h-10 max-md:pointer-coarse:w-9",
          "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
          "disabled:pointer-events-none disabled:opacity-50",
          busy && "prompt-enhancer-pill-busy",
        )}
        disabled={disabled}
        onClick={() => (busy ? cancel() : void enhance())}
        onMouseEnter={() => setCancelHover(true)}
        onMouseLeave={() => setCancelHover(false)}
        aria-label={busy ? "Cancel enhancement" : "Enhance prompt"}
        title={
          busy ? "Cancel enhancement" : `Enhance prompt (${SHORTCUT_HINT})`
        }
      >
        <Icon
          name={busy ? (cancelHover ? "X" : "Loading") : "AiContentGenerator01"}
          className={cn(
            "size-4 max-md:pointer-coarse:size-5",
            busy && !cancelHover && "animate-spin",
          )}
          aria-hidden
        />
      </button>
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

// ---------------------------------------------------------------------------
// Settings section — where the enhancer model is chosen
// ---------------------------------------------------------------------------

interface PickerState {
  status: "loading" | "ready" | "failed";
  catalog: ModelCatalog | null;
  override: ModelOverride | null;
}

/**
 * The model + reasoning-level picker, rendered on the plugin's settings page.
 * It lives here rather than in the composer so the control beside the draft
 * stays a single button: the model is a set-once preference, not a per-draft
 * decision, and the settings page has the room for a searchable list.
 */
function ModelSettingsSection() {
  const rpc = useRpc<typeof rpcContract>();
  const [reloadToken, setReloadToken] = useState(0);
  const [picker, setPicker] = useState<PickerState>({
    status: "loading",
    catalog: null,
    override: null,
  });

  useEffect(() => {
    let cancelled = false;
    setPicker((current) => ({ ...current, status: "loading" }));
    void (async () => {
      try {
        const [catalog, { override }] = await Promise.all([
          rpc.call("listModels"),
          rpc.call("getModelOverride"),
        ]);
        if (!cancelled) setPicker({ status: "ready", catalog, override });
      } catch {
        // Flag the failure so the list can offer a retry instead of showing
        // an eternal "Loading…".
        if (!cancelled)
          setPicker({ status: "failed", catalog: null, override: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, reloadToken]);

  const { catalog, override } = picker;

  /** The pinned model's catalog entry, when one is pinned and known. */
  const selectedModel =
    override === null
      ? null
      : (catalog?.providers
          .find((entry) => entry.id === override.providerId)
          ?.models.find((entry) => entry.model === override.model) ?? null);

  const overrideLabel = (() => {
    if (override === null) return null;
    const provider = catalog?.providers.find(
      (entry) => entry.id === override.providerId,
    );
    const model = provider?.models.find(
      (entry) => entry.model === override.model,
    );
    const level = override.reasoningLevel;
    const suffix = level ? ` · ${levelLabel(level)}` : "";
    return model === undefined || provider === undefined
      ? `${override.model}${suffix}`
      : `${provider.displayName} · ${model.displayName}${suffix}`;
  })();

  /**
   * Model and reasoning level are one combined choice, so the list stays put
   * across selections and both can be set in a single visit (same behavior as
   * bb's own model picker). The toast reuses one id so a run of selections
   * updates a single toast instead of stacking.
   */
  async function selectOverride(next: ModelOverride | null): Promise<void> {
    // Optimistic: the row's check moves under the finger immediately, and a
    // failed save reverts it below.
    const previous = override;
    setPicker((current) => ({ ...current, override: next }));
    try {
      await rpc.call("setModelOverride", { override: next });
      toast.success(
        next === null
          ? "Enhancer uses the thread's provider default"
          : `Enhancer model: ${next.model}${
              next.reasoningLevel ? ` · ${levelLabel(next.reasoningLevel)}` : ""
            }`,
        { id: "prompt-enhancer-model" },
      );
    } catch (error) {
      setPicker((current) => ({ ...current, override: previous }));
      toast.error(
        error instanceof Error ? error.message : "Failed to save the model",
        { id: "prompt-enhancer-model" },
      );
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Enhancements run on{" "}
        <span className="font-medium text-foreground">
          {overrideLabel ?? "the thread's provider default"}
        </span>
        .
      </p>
      <div className="overflow-hidden rounded-md border border-input">
        <Command>
          <CommandInput placeholder="Search models…" />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {picker.status === "ready"
                ? "No models match your search."
                : picker.status === "failed"
                  ? "Couldn't load models."
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
                  className={override === null ? undefined : "invisible"}
                  aria-hidden
                />
                <span className="truncate">Provider default</span>
                <span className="ml-auto text-xs text-muted-foreground">
                  inherit
                </span>
              </CommandItem>
            </CommandGroup>
            {/* Reasoning section, mirroring bb's own model picker: the
                pinned model's levels in their own group rather than nested
                under a row, so the choice is visible without hunting. */}
            {selectedModel === null ? (
              <CommandGroup heading="Reasoning">
                <CommandItem
                  value="reasoning-hint"
                  disabled
                  keywords={["thinking", "reasoning", "effort"]}
                >
                  <span className="truncate text-xs text-muted-foreground">
                    Pick a model to choose its reasoning level
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : selectedModel.reasoningLevels.length > 0 ? (
              <CommandGroup heading="Reasoning">
                {selectedModel.reasoningLevels.map((level) => {
                  const levelSelected =
                    (override?.reasoningLevel ?? null) === level ||
                    (override?.reasoningLevel == null &&
                      selectedModel.defaultReasoningLevel === level);
                  return (
                    <CommandItem
                      key={`reasoning-${level}`}
                      value={`reasoning-${level}`}
                      keywords={[
                        "thinking",
                        "reasoning",
                        "effort",
                        levelLabel(level),
                      ]}
                      onSelect={() =>
                        void selectOverride({
                          providerId: override!.providerId,
                          model: override!.model,
                          reasoningLevel: level,
                        })
                      }
                    >
                      <Icon
                        name="Check"
                        className={levelSelected ? undefined : "invisible"}
                        aria-hidden
                      />
                      <span className="truncate">{levelLabel(level)}</span>
                      {selectedModel.defaultReasoningLevel === level ? (
                        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                          default
                        </span>
                      ) : null}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ) : null}
            {catalog?.providers.map((provider) => (
              <CommandGroup key={provider.id} heading={provider.displayName}>
                {provider.models.map((model) => {
                  const selected =
                    override !== null &&
                    override.providerId === provider.id &&
                    override.model === model.model;
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
                          // Keep the level when re-picking the same model;
                          // a different model starts at its own default.
                          reasoningLevel: selected
                            ? (override?.reasoningLevel ?? null)
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
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </div>
      {picker.status === "failed" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReloadToken((token) => token + 1)}
        >
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "model",
    title: "Enhancer model",
    description:
      "Which provider and model rewrites your drafts. Defaults to the provider of the thread you are drafting in.",
    component: ModelSettingsSection,
  });
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
