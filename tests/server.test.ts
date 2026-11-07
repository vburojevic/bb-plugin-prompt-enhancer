// Backend behavior against the SDK's fake host: real SQLite storage, real RPC
// validation, recorded bb.sdk calls. Each test drives one run the way bb
// would: an RPC from the composer, then the child thread's events.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server";

const SCOPE_THREAD = "thr_scope";
const CHILD = "thr_child";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** A loaded plugin with one scope thread and a child whose output we control. */
async function setup() {
  const child = { output: null as string | null };
  const { bb, harness } = createFakePluginHost({
    pluginId: "prompt-enhancer",
    sdk: {
      providers: { list: async () => [] },
      projects: { list: async () => [] },
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "proj_1",
            environmentId: "env_1",
            providerId: "claude-code",
          }),
        output: async ({ threadId }: { threadId: string }) => ({
          output: threadId === CHILD ? child.output : "earlier reply",
        }),
        spawn: async () =>
          makeThreadResponse({ id: CHILD, projectId: "proj_1", providerId: "claude-code" }),
        stop: async () => ({}),
        delete: async () => ({}),
        events: { list: async () => [] },
      },
    },
  });
  await plugin(bb);
  const childOutputReads = () =>
    harness.inspection.sdk
      .callsTo("threads.output")
      .filter(([args]) => (args as { threadId: string }).threadId === CHILD).length;
  const signals = () =>
    harness.inspection.realtimeSignals.map(
      (signal) => signal.payload as { id: string; status: string; text?: string },
    );
  async function start(): Promise<string> {
    const { id } = (await harness.behavior.callRpc("startEnhance", {
      text: "fix the add bug pls",
      scopeKey: `thread/${SCOPE_THREAD}`,
      threadId: SCOPE_THREAD,
      projectId: null,
      attachmentCount: 0,
      previewGate: false,
      mentionLabels: [],
    })) as { id: string };
    await waitFor(() => childOutputReads() === 1, "the first read of the child");
    return id;
  }
  /** Waits (up to `ms`) for the run to leave pending, then returns it. */
  async function settled(id: string, ms: number) {
    const deadline = Date.now() + ms;
    while ((await enhancement(id)).status === "pending" && Date.now() < deadline) {
      await sleep(20);
    }
    return enhancement(id);
  }
  async function enhancement(id: string) {
    const { enhancement } = (await harness.behavior.callRpc("getEnhancement", {
      id,
    })) as { enhancement: { status: string; enhanced: string | null; error: string | null } };
    return enhancement;
  }
  const announce = () =>
    harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
      sequence: 1,
    });
  return { harness, child, childOutputReads, signals, start, enhancement, settled, announce };
}

test("reads the child only when bb announces new events, never on a timer", async () => {
  const { harness, child, childOutputReads, signals, start, enhancement, announce } =
    await setup();
  const id = await start();
  // The 400 ms poller would have read the child three more times by now.
  await sleep(1_300);
  assert.equal(childOutputReads(), 1);

  child.output = "Fix the `add` bug.";
  await announce();
  await waitFor(() => childOutputReads() === 2, "the announced read");
  await waitFor(
    () => signals().some((signal) => signal.status === "progress"),
    "the progress signal",
  );
  assert.deepEqual(
    signals().filter((signal) => signal.status === "progress"),
    [{ id, status: "progress", text: "Fix the `add` bug." }],
  );

  await harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1" }),
    lastAssistantText: "Fix the `add` bug.",
  });
  assert.equal((await enhancement(id)).status, "done");
  assert.equal((await enhancement(id)).enhanced, "Fix the `add` bug.");
  // Done means done: no further reads, even when the child announces again.
  await announce();
  await sleep(50);
  assert.equal(childOutputReads(), 2);
});

test("written output followed by a quiet child finishes the run", async () => {
  const { child, start, settled, announce } = await setup();
  const id = await start();
  child.output = "Rewritten prompt.";
  await announce();
  // thread.idle never arrives (a provider slow to tear down).
  const run = await settled(id, 2_500);
  assert.equal(run.status, "done");
  assert.equal(run.enhanced, "Rewritten prompt.");
});

test("a child that fails without an error message reports its last error event", async () => {
  const { harness, start, settled } = await setup();
  harness.inspection.sdk.stub("threads.events.list", async () => [
    { type: "provider/error", data: { message: "Rate limited" } },
  ]);
  const id = await start();
  await harness.behavior.emitThreadEvent("thread.failed", {
    thread: makeThreadResponse({ id: CHILD, projectId: "proj_1", status: "error" }),
    error: null,
  });
  const run = await settled(id, 1_000);
  assert.equal(run.status, "error");
  assert.equal(run.error, "Rate limited");
});
