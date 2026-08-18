import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeKey } from "../lib/scope-key";

// This key is how a run finds its way back to the draft it belongs to after
// the composer that started it has unmounted. Two rules matter: drafts that
// can be on screen at the same time must never share a key, and a key must not
// change under a run that is already in flight.

test("each thread's composer owns its own runs", () => {
  assert.equal(scopeKey({ kind: "thread", threadId: "thr_a" }), "thread/thr_a");
  assert.notEqual(
    scopeKey({ kind: "thread", threadId: "thr_a" }),
    scopeKey({ kind: "thread", threadId: "thr_b" }),
  );
});

test("a queued-message editor never adopts its thread's run", () => {
  const thread = scopeKey({ kind: "thread", threadId: "thr_a" });
  const queued = scopeKey({
    kind: "queued-message",
    threadId: "thr_a",
    queuedMessageId: "msg_1",
  });
  assert.notEqual(queued, thread);
  assert.notEqual(
    queued,
    scopeKey({
      kind: "queued-message",
      threadId: "thr_a",
      queuedMessageId: "msg_2",
    }),
  );
});

test("a side chat keeps one key across its first send", () => {
  const base = {
    kind: "side-chat" as const,
    projectId: "proj_1",
    parentThreadId: "thr_a",
    tabId: "tab_1",
  };
  // childThreadId flips from null to an id on the first send; the draft — and
  // therefore any run against it — is the same one throughout.
  assert.equal(
    scopeKey({ ...base, childThreadId: null }),
    scopeKey({ ...base, childThreadId: "thr_child" }),
  );
  assert.notEqual(
    scopeKey({ ...base, childThreadId: null }),
    scopeKey({ ...base, tabId: "tab_2", childThreadId: null }),
  );
});

test("the new-thread composer keys by project, resolved or not", () => {
  assert.equal(
    scopeKey({ kind: "new-thread", projectId: "proj_1" }),
    "new-thread/proj_1",
  );
  assert.equal(
    scopeKey({ kind: "new-thread", projectId: null }),
    "new-thread/unresolved",
  );
});

test("an unknown future scope kind gets its own key, not a collision", () => {
  assert.equal(scopeKey({ kind: "some-future-kind" }), "some-future-kind");
  assert.notEqual(
    scopeKey({ kind: "some-future-kind" }),
    scopeKey({ kind: "thread", threadId: "thr_a" }),
  );
});
