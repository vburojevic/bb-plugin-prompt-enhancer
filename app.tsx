// bb-plugin-prompt-enhancer — frontend entry.
//
// Adds an "Enhance prompt" action to every composer. Clicking it hands the
// current draft to the backend (which rewrites it in a hidden bb thread),
// locks the input while waiting, and replaces the draft when the realtime
// completion signal arrives. Styling uses host token classes only.
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
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const TIMEOUT_MS = 90_000;

interface EnhanceSignal {
  id?: string;
  status?: "done" | "error";
}

function EnhanceButton() {
  const composer = useComposer();
  const view = useComposerView();
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const pendingIdRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disabled = busy || view.draft.isEmpty || view.run.isRunning;

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
    let id: string;
    try {
      ({ id } = await rpc.call("startEnhance", {
        text,
        threadId: view.scope.kind === "thread" ? view.scope.threadId : null,
        projectId:
          view.scope.kind === "new-thread" ? view.scope.projectId : null,
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

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      disabled={disabled}
      onClick={() => void enhance()}
      aria-label="Enhance prompt"
      title="Enhance prompt"
    >
      <Icon
        name={busy ? "Loading" : "Zap"}
        className={busy ? "animate-spin" : undefined}
        aria-hidden
      />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "prompt-enhancer",
    actions: [{ id: "enhance", component: EnhanceButton }],
  });
});
