// bb-plugin-prompt-enhancer — frontend entry.
//
// Adds a unified "Enhance prompt" control to every composer: the spark half
// rewrites the draft via the backend (a hidden bb thread), the chevron half
// opens a searchable model picker (popover + command palette) to pin an
// explicit provider+model for the enhancement (default: inherit the current
// thread's provider, or the project default on the new-thread composer).
// While an enhancement runs, the control shimmers and the draft gets an
// animated text effect.
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

const TIMEOUT_MS = 90_000;

interface EnhanceSignal {
  id?: string;
  status?: "done" | "error";
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

// ---------------------------------------------------------------------------
// Shared catalog/selection store (per window)
// ---------------------------------------------------------------------------

interface PickerState {
  loaded: boolean;
  catalog: ModelCatalog | null;
  override: ModelOverride | null;
}

let pickerState: PickerState = {
  loaded: false,
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
  pickerInflight = (async () => {
    try {
      const [modelsResult, overrideResult] = await Promise.all([
        rpc.call("listModels"),
        rpc.call("getModelOverride"),
      ]);
      pickerState = {
        loaded: true,
        catalog: modelsResult,
        override: overrideResult.override,
      };
    } catch {
      // Leave unloaded — the next picker open retries.
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
// Shimmer styles — raw CSS because keyframes cannot come from the Tailwind
// pass. Injected by a content script (the sanctioned escape hatch), removed
// on dispose. Colors derive from currentColor only — never hardcoded.
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
  background-image: linear-gradient(
    110deg,
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
`;

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
  const pendingIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = usePickerState();

  // Eagerly warm the shared store so the tooltip and check marks reflect the
  // remembered selection without opening the picker first.
  useEffect(() => {
    ensurePickerLoaded(rpc);
  }, [rpc]);

  const disabled = busy || view.draft.isEmpty || view.run.isRunning;

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

  function clearPending(): void {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    pendingIdRef.current = null;
    setBusy(false);
    composer.setInputLock(false);
    composer.setTextEffect(null);
  }

  // Input lock and text effect are plugin-scoped and auto-release on
  // unmount/scope change; only the timeout needs explicit cleanup.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  useRealtime("prompt-enhancer", (payload) => {
    const signal = payload as EnhanceSignal;
    const pendingId = pendingIdRef.current;
    if (pendingId === null || signal.id !== pendingId) return;
    void (async () => {
      try {
        const { enhancement } = await rpc.call("getEnhancement", {
          id: pendingId,
        });
        if (enhancement?.status === "done" && enhancement.enhanced) {
          composer.setText(enhancement.enhanced);
          toast.success("Prompt enhanced");
        } else if (enhancement?.status === "error") {
          toast.error(enhancement.error ?? "Enhancement failed");
        } else {
          // Still pending — keep waiting for the next signal or the timeout.
          return;
        }
      } catch {
        toast.error("Failed to fetch the enhanced prompt");
      }
      clearPending();
    })();
  });

  async function enhance(): Promise<void> {
    const text = composer.text.trim();
    if (!text || disabled) return;
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
    let id: string;
    try {
      ({ id } = await rpc.call("startEnhance", {
        text,
        threadId: scopeThreadId,
        projectId: scopeProjectId,
      }));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start enhancement",
      );
      return;
    }
    pendingIdRef.current = id;
    setBusy(true);
    composer.setInputLock(true);
    composer.setTextEffect({ className: "prompt-enhancer-draft" });
    timeoutRef.current = setTimeout(() => {
      if (pendingIdRef.current === id) {
        clearPending();
        toast.error("Enhancement timed out");
      }
    }, TIMEOUT_MS);
  }

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
      role="group"
      aria-label="Prompt enhancer"
      className={cn(
        "flex items-center overflow-hidden rounded-md border border-input",
        busy && "prompt-enhancer-pill-busy",
      )}
    >
      <button
        type="button"
        className={groupHalfClass("w-7")}
        disabled={disabled}
        onClick={() => void enhance()}
        aria-label="Enhance prompt"
        title={
          overrideLabel === null
            ? "Enhance prompt"
            : `Enhance prompt (${overrideLabel})`
        }
      >
        <Icon
          name={busy ? "Loading" : "AiContentGenerator01"}
          className={cn("size-4", busy && "animate-spin")}
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
            aria-label="Choose enhancer model"
            title="Choose enhancer model"
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
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompt-enhancer",
    actions: [{ id: "enhance", component: EnhanceButton }],
  });
  // Keyframes for the busy shimmer. The Tailwind pass cannot emit raw
  // keyframes, so a content script injects them and cleans up on dispose.
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
