// Re-anchors the draft's @-mention pills on rewritten text. The rewrite is
// plain text from the model; the composer only keeps a pill when the write
// carries its range, so each pill is placed on the first free occurrence of
// its serialized text (e.g. `@src/app.ts`) in the new text. Pure so it can be
// unit tested; app.tsx owns the composer writes.

/** The part of a composer mention this module reads; the rest is kept as is. */
export interface MentionRange {
  from: number;
  to: number;
}

/**
 * The original draft's mentions moved onto `text`, in text order. Mentions
 * whose serialized text the rewrite dropped are left out (the
 * dropped-reference guard reports those), and so are mentions whose text is
 * only partly present yet, which is what a reveal mid-way through shows.
 */
export function reanchorMentions<M extends MentionRange>(
  original: { text: string; mentions: readonly M[] },
  text: string,
): M[] {
  const placed: M[] = [];
  const overlapsPlaced = (from: number, to: number): boolean =>
    placed.some((mention) => from < mention.to && mention.from < to);
  const findFree = (token: string, start: number): number => {
    for (let at = text.indexOf(token, start); at !== -1; at = text.indexOf(token, at + 1)) {
      if (!overlapsPlaced(at, at + token.length)) return at;
    }
    return -1;
  };
  // Prefer occurrences in the original order; a rewrite that reorders
  // sentences still gets its pills from anywhere in the text.
  let cursor = 0;
  const inOrder = [...original.mentions].sort((a, b) => a.from - b.from);
  for (const mention of inOrder) {
    const token = original.text.slice(mention.from, mention.to);
    if (token.length === 0) continue;
    let at = findFree(token, cursor);
    if (at === -1) at = findFree(token, 0);
    if (at === -1) continue;
    placed.push({ ...mention, from: at, to: at + token.length });
    cursor = Math.max(cursor, at + token.length);
  }
  return placed.sort((a, b) => a.from - b.from);
}
