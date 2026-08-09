import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextShown,
  REVEAL_MIN_STEP,
  REVEAL_TICK_MS,
} from "../lib/reveal";

test("always advances while text remains, never overshoots", () => {
  for (const target of [1, 2, 3, 10, 137, 5000]) {
    let shown = 0;
    while (shown < target) {
      const next = nextShown(shown, target);
      assert.ok(next > shown, `advances at ${shown}/${target}`);
      assert.ok(next <= target, `no overshoot at ${shown}/${target}`);
      shown = next;
    }
    assert.equal(shown, target);
  }
});

test("at or past the target is a fixpoint", () => {
  assert.equal(nextShown(50, 50), 50);
  assert.equal(nextShown(80, 50), 50);
});

test("eases out: steps shrink as the target nears", () => {
  const target = 1000;
  const firstStep = nextShown(0, target) - 0;
  const lateShown = 950;
  const lateStep = nextShown(lateShown, target) - lateShown;
  assert.ok(firstStep > lateStep);
  assert.ok(lateStep >= REVEAL_MIN_STEP);
});

test("mid-size rewrites finish within a snappy, visible window", () => {
  // A typical ~200-char rewrite should type in roughly 0.3–2s: fast enough
  // to feel responsive, slow enough to be seen. Guards pacing regressions.
  let shown = 0;
  let ticks = 0;
  while (shown < 200) {
    shown = nextShown(shown, 200);
    ticks += 1;
  }
  const ms = ticks * REVEAL_TICK_MS;
  assert.ok(ms >= 300, `too fast: ${ms}ms`);
  assert.ok(ms <= 2000, `too slow: ${ms}ms`);
});

test("a growing target keeps the reveal monotonic", () => {
  // Chunked arrival: target extends mid-reveal; shown never regresses.
  let shown = 0;
  const targets = [40, 40, 90, 90, 90, 220];
  let previous = 0;
  for (const target of targets) {
    shown = nextShown(shown, target);
    assert.ok(shown >= previous);
    previous = shown;
  }
});
