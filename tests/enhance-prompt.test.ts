import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEnhancePrompt,
  CUSTOM_INSTRUCTIONS_CAP,
  PROMPT_TEXT_CAP,
  type EnhanceContext,
} from "../lib/enhance-prompt";

function ctx(overrides: Partial<EnhanceContext> = {}): EnhanceContext {
  return {
    kind: "new-task",
    attachmentCount: 0,
    threadTitle: null,
    lastOutput: null,
    customInstructions: null,
    ...overrides,
  };
}

test("new-task framing states the brief is the agent's entire brief", () => {
  const prompt = buildEnhancePrompt("fix the bug", ctx());
  assert.match(prompt, /brand-new task/);
  assert.doesNotMatch(prompt, /follow-up message/);
});

test("follow-up framing forbids restating background", () => {
  const prompt = buildEnhancePrompt("fix it", ctx({ kind: "follow-up" }));
  assert.match(prompt, /follow-up message in an ongoing conversation/);
  assert.match(prompt, /do NOT restate background/);
  assert.doesNotMatch(prompt, /brand-new task/);
});

test("draft is embedded verbatim between triple-quote fences", () => {
  const prompt = buildEnhancePrompt("hello @world in src/x.ts", ctx());
  assert.match(prompt, /"""\nhello @world in src\/x\.ts\n"""/);
});

test("oversized draft is truncated at the cap with a marker", () => {
  const prompt = buildEnhancePrompt("x".repeat(PROMPT_TEXT_CAP + 500), ctx());
  assert.match(prompt, /\[…truncated\]/);
  assert.ok(!prompt.includes("x".repeat(PROMPT_TEXT_CAP + 1)));
});

test("no context block without thread title or output", () => {
  const prompt = buildEnhancePrompt("do it", ctx());
  assert.doesNotMatch(prompt, /Conversation context/);
});

test("context block carries title and output tail when present", () => {
  const prompt = buildEnhancePrompt(
    "fix that bug",
    ctx({
      kind: "follow-up",
      threadTitle: "Auth refactor",
      lastOutput: "The crash is in refreshToken()",
    }),
  );
  assert.match(prompt, /Conversation context/);
  assert.match(prompt, /Thread title: Auth refactor/);
  assert.match(prompt, /The crash is in refreshToken\(\)/);
  assert.match(prompt, /never restate it in the rewrite/);
});

test("title-only context omits the output section", () => {
  const prompt = buildEnhancePrompt(
    "continue",
    ctx({ threadTitle: "T", lastOutput: null }),
  );
  assert.match(prompt, /Thread title: T/);
  assert.doesNotMatch(prompt, /Latest assistant message/);
});

test("attachment rule appears only when attachments exist", () => {
  const without = buildEnhancePrompt("go", ctx());
  const withTwo = buildEnhancePrompt("go", ctx({ attachmentCount: 2 }));
  assert.doesNotMatch(without, /attachment/);
  assert.match(withTwo, /2 attachment\(s\) you cannot see/);
});

test("custom instructions are appended and capped", () => {
  const prompt = buildEnhancePrompt(
    "go",
    ctx({ customInstructions: `  ${"y".repeat(CUSTOM_INSTRUCTIONS_CAP + 100)}  ` }),
  );
  assert.match(prompt, /User preference: y/);
  assert.ok(!prompt.includes("y".repeat(CUSTOM_INSTRUCTIONS_CAP + 1)));
});

test("blank custom instructions add no preference rule", () => {
  const prompt = buildEnhancePrompt("go", ctx({ customInstructions: "   " }));
  assert.doesNotMatch(prompt, /User preference/);
});

test("output-only contract and language rule are always present", () => {
  const prompt = buildEnhancePrompt("go", ctx());
  assert.match(prompt, /Return ONLY the rewritten prompt/);
  assert.match(prompt, /Keep the same language/);
  assert.match(prompt, /Preserve verbatim every @mention/);
});
