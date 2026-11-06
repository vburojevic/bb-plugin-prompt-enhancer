import { test } from "node:test";
import assert from "node:assert/strict";
import { reanchorMentions } from "../lib/mentions";

const draft = (text: string, tokens: string[]) => ({
  text,
  mentions: tokens.map((token, index) => {
    const from = text.indexOf(token);
    return { from, to: from + token.length, label: token, id: index };
  }),
});

test("moves a pill onto its text in the rewrite and keeps its other fields", () => {
  const original = draft("fix @src/math.ts pls", ["@src/math.ts"]);
  const text = "Fix the bug in @src/math.ts and add a test.";
  assert.deepEqual(reanchorMentions(original, text), [
    { from: 15, to: 27, label: "@src/math.ts", id: 0 },
  ]);
});

test("keeps several pills in order, including repeats of the same text", () => {
  const original = {
    text: "@a.ts then @b.ts then @a.ts",
    mentions: [
      { from: 0, to: 5 },
      { from: 11, to: 16 },
      { from: 22, to: 27 },
    ],
  };
  const text = "Edit @a.ts, then @b.ts, then @a.ts again.";
  assert.deepEqual(
    reanchorMentions(original, text).map((m) => text.slice(m.from, m.to)),
    ["@a.ts", "@b.ts", "@a.ts"],
  );
  assert.deepEqual(
    reanchorMentions(original, text).map((m) => m.from),
    [5, 17, 29],
  );
});

test("finds pills the rewrite moved before earlier ones", () => {
  const original = draft("see @a.ts and @b.ts", ["@a.ts", "@b.ts"]);
  const text = "Start with @b.ts, then read @a.ts.";
  const placed = reanchorMentions(original, text);
  assert.deepEqual(
    placed.map((m) => [m.label, text.slice(m.from, m.to)]),
    [
      ["@b.ts", "@b.ts"],
      ["@a.ts", "@a.ts"],
    ],
  );
});

test("drops pills whose text the rewrite lost or has only partly revealed", () => {
  const original = draft("use @src/math.ts and @README.md", [
    "@src/math.ts",
    "@README.md",
  ]);
  assert.deepEqual(reanchorMentions(original, "Use @src/ma"), []);
  assert.deepEqual(
    reanchorMentions(original, "Use @src/math.ts only.").map((m) => m.label),
    ["@src/math.ts"],
  );
});

test("never places two pills on the same text", () => {
  const original = draft("@x.ts @x.ts", []);
  original.mentions.push(
    { from: 0, to: 5, label: "@x.ts", id: 0 },
    { from: 6, to: 11, label: "@x.ts", id: 1 },
  );
  assert.deepEqual(
    reanchorMentions(original, "Look at @x.ts.").map((m) => m.id),
    [0],
  );
});
