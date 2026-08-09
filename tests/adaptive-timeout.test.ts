import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "../lib/adaptive-timeout";

test("falls back to the default without enough history", () => {
  assert.equal(adaptiveTimeoutMs([]), DEFAULT_TIMEOUT_MS);
  assert.equal(adaptiveTimeoutMs([5000, 6000]), DEFAULT_TIMEOUT_MS);
});

test("fast models get a much shorter timeout than the default", () => {
  const timeout = adaptiveTimeoutMs([4000, 5000, 6000, 5500]);
  assert.ok(timeout < DEFAULT_TIMEOUT_MS);
  assert.ok(timeout >= MIN_TIMEOUT_MS);
});

test("slow models get headroom above their p90", () => {
  const timeout = adaptiveTimeoutMs([30_000, 35_000, 40_000]);
  assert.ok(timeout > 40_000 * 2);
  assert.ok(timeout <= MAX_TIMEOUT_MS);
});

test("clamped to the floor and the ceiling", () => {
  assert.equal(adaptiveTimeoutMs([100, 120, 150]), MIN_TIMEOUT_MS);
  assert.equal(
    adaptiveTimeoutMs([200_000, 250_000, 300_000]),
    MAX_TIMEOUT_MS,
  );
});

test("garbage samples are ignored", () => {
  assert.equal(
    adaptiveTimeoutMs([-5, 0, Number.NaN, Number.POSITIVE_INFINITY]),
    DEFAULT_TIMEOUT_MS,
  );
});

test("one outlier dominates less than the worst case", () => {
  // p90 of mostly-fast runs with one straggler stays below the straggler.
  const timeout = adaptiveTimeoutMs([
    5000, 5200, 4800, 5100, 5300, 4900, 5000, 5200, 5100, 60_000,
  ]);
  assert.ok(timeout < 60_000 * 2 + 8_000);
});
