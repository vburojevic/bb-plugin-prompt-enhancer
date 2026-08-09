// Live-reference extraction for the dropped-reference guard. The rewrite
// prompt tells the model to preserve these verbatim; this module verifies.

/**
 * Live references the rewriter is told to preserve verbatim: @mentions,
 * URLs, inline code spans, and anything path-shaped.
 */
export function extractReferences(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.match(/https?:\/\/[^\s)"']+/g) ?? []) out.add(match);
  for (const match of text.match(/(?:^|\s)@[\w./-]{2,}/g) ?? [])
    out.add(match.trim());
  for (const match of text.match(/`[^`\n]+`/g) ?? [])
    out.add(match.slice(1, -1));
  for (const match of text.match(/[\w.-]+\/[\w./-]+/g) ?? []) out.add(match);
  return [...out].filter((token) => token.length > 2);
}

export function missingReferences(original: string, enhanced: string): string[] {
  return extractReferences(original).filter(
    (token) => !enhanced.includes(token),
  );
}

export function formatMissing(missing: string[]): string {
  const shown = missing.slice(0, 3).join(", ");
  return missing.length > 3 ? `${shown}, …` : shown;
}
