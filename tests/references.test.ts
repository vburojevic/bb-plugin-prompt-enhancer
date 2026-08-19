import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReferences,
  formatMissing,
  missingReferences,
} from "../lib/references";

test("extracts file paths, mentions, urls, and code spans", () => {
  const refs = extractReferences(
    "fix src/auth/login.ts per @readme, see https://example.com/docs and run `npm test`",
  );
  assert.ok(refs.includes("src/auth/login.ts"));
  assert.ok(refs.includes("@readme"));
  assert.ok(refs.includes("https://example.com/docs"));
  assert.ok(refs.includes("npm test"));
});

test("email addresses are not treated as @mentions", () => {
  const refs = extractReferences("mail dev@example.com about it");
  assert.ok(!refs.some((token) => token.startsWith("@")));
});

test("plain prose yields no references", () => {
  assert.deepEqual(
    extractReferences("make the login page look better and fix the crash"),
    [],
  );
});

test("missingReferences flags only dropped tokens", () => {
  const original = "update docs/auth.md and src/auth/session.ts";
  const enhanced = "Update src/auth/session.ts and refresh the auth docs.";
  assert.deepEqual(missingReferences(original, enhanced), ["docs/auth.md"]);
});

test("code-span content preserved without backticks still counts", () => {
  const original = "run `npm test` after";
  const enhanced = "Run npm test afterwards.";
  assert.deepEqual(missingReferences(original, enhanced), []);
});

test("nothing missing when everything survives", () => {
  const text = "fix src/a.ts per https://x.dev and @notes";
  assert.deepEqual(missingReferences(text, `Rewritten: ${text}`), []);
});

test("known mention labels are verified exactly, not heuristically", () => {
  const original = "summarize @meeting notes and clean up the doc";
  const enhanced = "Summarize the meeting notes and clean up the document.";
  // Regex alone finds "@meeting"; the structured label is ground truth.
  assert.deepEqual(
    missingReferences(original, enhanced, ["@meeting notes"]),
    ["@meeting", "@meeting notes"],
  );
  const preserved = "Summarize @meeting notes and clean up the document.";
  assert.deepEqual(
    missingReferences(original, preserved, ["@meeting notes"]),
    [],
  );
});

test("known tokens absent from the original are ignored", () => {
  // A stale label from a previous draft must not produce a false warning.
  assert.deepEqual(missingReferences("do the thing", "Do it.", ["@stale"]), []);
});

test("formatMissing lists up to three then elides", () => {
  assert.equal(formatMissing(["a/b", "c/d"]), "a/b, c/d");
  assert.equal(
    formatMissing(["a/b", "c/d", "e/f", "g/h"]),
    "a/b, c/d, e/f, …",
  );
});

test("a URL is not also reported as a bare path", () => {
  const refs = extractReferences(
    "follow https://stripe.com/docs/idempotency and patch src/pay.ts",
  );
  assert.ok(refs.includes("https://stripe.com/docs/idempotency"));
  assert.ok(refs.includes("src/pay.ts"));
  assert.ok(!refs.includes("stripe.com/docs/idempotency"));
});
