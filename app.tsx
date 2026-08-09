// bb-plugin-prompt-enhancer — frontend entry.
//
// Adds a unified "Enhance prompt" control to every composer: the zap half
// rewrites the draft via the backend (a hidden bb thread), the chevron half
// opens a dropdown to pin an explicit provider+model for the enhancement
// (default: inherit the current thread's provider, or the project default on
// the new-thread composer). Styling uses host token classes only.
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TIMEOUT_MS = 90_000;

interface EnhanceSignal {
  id?: string;
  status?: "done" | "error";
}
interface ModelOverride {
  providerId: string;
  model: string;
}
type ModelCatalog = {
  providers: {
    id: string;
    displayName: string;
    models: { model: string; displayName: string; isDefault: boolean }[];
  }[];
};

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

  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [override, setOverride] = useState<ModelOverride | null>(null);
  const [menuLoaded, setMenuLoaded] = useState(false);

  const disabled = busy || view.draft.isEmpty || view.run.isRunning;

  const overrideLabel = (() => {
    if (override === null || catalog === null) return null;
    const provider = catalog.providers.find(
      (entry) => entry.id === override.providerId,
    );
    const model = provider?.models.find(
      (entry) => entry.model === override.model,
    );
    return model === undefined || provider === undefined
      ? override.model
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
  }

  // The input lock is plugin-scoped and auto-releases on unmount/scope change;
  // only the timeout needs explicit cleanup.
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
    timeoutRef.current = setTimeout(() => {
      if (pendingIdRef.current === id) {
        clearPending();
        toast.error("Enhancement timed out");
      }
    }, TIMEOUT_MS);
  }

  async function loadMenu(): Promise<void> {
    try {
      const [modelsResult, overrideResult] = await Promise.all([
        rpc.call("listModels"),
        rpc.call("getModelOverride"),
      ]);
      setCatalog(modelsResult);
      setOverride(overrideResult.override);
      setMenuLoaded(true);
    } catch {
      toast.error("Failed to load the model list");
    }
  }

  async function selectOverride(next: ModelOverride | null): Promise<void> {
    try {
      await rpc.call("setModelOverride", { override: next });
      setOverride(next);
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
      className="flex items-center overflow-hidden rounded-md border border-input"
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
          name={busy ? "Loading" : "Zap"}
          className={cn("size-4", busy && "animate-spin")}
          aria-hidden
        />
      </button>
      <div className="h-4 w-px bg-border" aria-hidden />
      <DropdownMenu
        onOpenChange={(open) => {
          if (open && !menuLoaded) void loadMenu();
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={groupHalfClass("w-5")}
            aria-label="Choose enhancer model"
            title="Choose enhancer model"
          >
            <Icon name="ChevronDown" className="size-3.5" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Enhancer model</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void selectOverride(null)}>
            <Icon
              name="Check"
              className={override === null ? undefined : "invisible"}
              aria-hidden
            />
            Provider default
          </DropdownMenuItem>
          {catalog === null ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : (
            catalog.providers.map((provider) => (
              <DropdownMenuGroup key={provider.id}>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{provider.displayName}</DropdownMenuLabel>
                {provider.models.map((model) => {
                  const selected =
                    override !== null &&
                    override.providerId === provider.id &&
                    override.model === model.model;
                  return (
                    <DropdownMenuItem
                      key={`${provider.id}:${model.model}`}
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
                      <span className="truncate">
                        {model.displayName}
                        {model.isDefault ? " (default)" : ""}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompt-enhancer",
    actions: [{ id: "enhance", component: EnhanceButton }],
  });
});
