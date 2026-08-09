// Pure prompt construction for the enhancement child thread. No SDK imports
// so it stays unit-testable; server.ts owns all I/O and passes context in.

/** Draft text is embedded in the child thread's prompt capped at this size. */
export const PROMPT_TEXT_CAP = 8000;
/** User's custom instruction line is capped so it can't dominate the prompt. */
export const CUSTOM_INSTRUCTIONS_CAP = 500;

export interface EnhanceContext {
  kind: "new-task" | "follow-up";
  attachmentCount: number;
  threadTitle: string | null;
  /** Tail of the scope thread's latest assistant output, already capped. */
  lastOutput: string | null;
  customInstructions: string | null;
}

/**
 * The two composer situations produce very different "best prompts": a
 * follow-up lands mid-conversation where the agent already holds the context
 * (inflating it into a spec re-litigates settled ground), while a new-task
 * prompt is the agent's entire brief and earns real structure.
 */
export function buildEnhancePrompt(draft: string, ctx: EnhanceContext): string {
  const capped =
    draft.length > PROMPT_TEXT_CAP
      ? `${draft.slice(0, PROMPT_TEXT_CAP)}\n[…truncated]`
      : draft;
  const lines = [
    "You rewrite rough draft prompts into clear, effective prompts for a coding agent working in an agentic coding IDE.",
    "",
    ctx.kind === "follow-up"
      ? "This draft is a follow-up message in an ongoing conversation — the agent already has the full context. Keep it a follow-up: sharpen the ask, but do NOT restate background, re-explain the task, or expand it into a standalone spec."
      : "This draft starts a brand-new task; the rewritten prompt is the agent's entire brief, so make the goal and the definition of done unmistakable.",
  ];
  if (ctx.threadTitle !== null || ctx.lastOutput !== null) {
    lines.push(
      "",
      "Conversation context — use it ONLY to resolve vague references in the draft (\"that bug\", \"the second option\"); never restate it in the rewrite:",
      ...(ctx.threadTitle !== null ? [`Thread title: ${ctx.threadTitle}`] : []),
      ...(ctx.lastOutput !== null
        ? ["Latest assistant message (tail):", '"""', ctx.lastOutput, '"""']
        : []),
    );
  }
  lines.push(
    "",
    "Rules:",
    "- Preserve the draft's intent and meaning exactly; never invent requirements, constraints, file names, or technologies the draft does not imply.",
    "- Preserve verbatim every @mention, file path, identifier, code snippet, shell command, URL, and quoted string — they are live references that must survive untouched.",
    "- Choose the rewrite's shape from the draft itself: a simple ask stays roughly one line; genuinely multi-part work becomes a short brief (goal, constraints, acceptance criteria); append a 'Done when:' list only when the draft implies concrete, checkable outcomes.",
    "- Prefer concrete, actionable phrasing: what to do, where, and how to tell it's done.",
    "- Keep the same language the draft is written in.",
  );
  if (ctx.attachmentCount > 0) {
    lines.push(
      `- The draft carries ${ctx.attachmentCount} attachment(s) you cannot see. Keep every reference to them intact and never invent or describe their contents.`,
    );
  }
  const custom = ctx.customInstructions?.trim() ?? "";
  if (custom.length > 0) {
    lines.push(`- User preference: ${custom.slice(0, CUSTOM_INSTRUCTIONS_CAP)}`);
  }
  lines.push(
    "- Return ONLY the rewritten prompt: no preamble, no explanation, no quotes, no markdown fences.",
    "",
    "Draft prompt:",
    '"""',
    capped,
    '"""',
  );
  return lines.join("\n");
}
