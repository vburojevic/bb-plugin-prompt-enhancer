import { test } from "node:test";
import assert from "node:assert/strict";
import { deadlineVerdict } from "../lib/deadline";

// The regression this file pins: a finished rewrite must be DELIVERED on an
// expired deadline, never discarded — and a run the server still reports as
// pending must keep running, because the composer that started it is usually
// gone by the time the rewrite lands. An expired local clock ends nothing.

test("done past the deadline delivers the rewrite", () => {
  assert.deepEqual(
    deadlineVerdict({ status: "done", enhanced: "better prompt", error: null }),
    { kind: "deliver", enhanced: "better prompt" },
  );
});

test("done with empty text reads as a failure, not a silent lock", () => {
  assert.deepEqual(
    deadlineVerdict({ status: "done", enhanced: "", error: null }),
    { kind: "error", message: "The enhancement returned no text" },
  );
  assert.deepEqual(
    deadlineVerdict({ status: "done", enhanced: null, error: null }),
    { kind: "error", message: "The enhancement returned no text" },
  );
});

test("server-side error surfaces its message", () => {
  assert.deepEqual(
    deadlineVerdict({ status: "error", enhanced: null, error: "rate limited" }),
    { kind: "error", message: "rate limited" },
  );
  assert.deepEqual(
    deadlineVerdict({ status: "error", enhanced: null, error: null }),
    { kind: "error", message: "Enhancement failed" },
  );
});

test("cancelled elsewhere releases quietly", () => {
  assert.deepEqual(
    deadlineVerdict({ status: "cancelled", enhanced: null, error: null }),
    { kind: "release" },
  );
});

test("a run the server still calls pending keeps waiting", () => {
  assert.deepEqual(
    deadlineVerdict({ status: "pending", enhanced: null, error: null }),
    { kind: "pending" },
  );
});

test("a run the server has never heard of releases the composer", () => {
  assert.deepEqual(deadlineVerdict(null), { kind: "unknown" });
});
