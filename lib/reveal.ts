// Pacing math for the adaptive typewriter reveal. Pure so it can be unit
// tested; app.tsx owns the timer and the composer writes.

/** Reveal engine cadence. */
export const REVEAL_TICK_MS = 24;
/** Fraction of the remaining text revealed per tick (ease-out catch-up). */
export const REVEAL_CATCH_UP = 0.1;
/** Minimum characters per tick so the tail never crawls. */
export const REVEAL_MIN_STEP = 2;

/**
 * Next shown-character count for one tick. Reveals a fraction of whatever
 * remains, so a big arrival accelerates and the tail eases out; never
 * overshoots the target and always advances while text remains.
 */
export function nextShown(shown: number, targetLength: number): number {
  if (shown >= targetLength) return targetLength;
  const remaining = targetLength - shown;
  return Math.min(
    targetLength,
    shown + Math.max(REVEAL_MIN_STEP, Math.ceil(remaining * REVEAL_CATCH_UP)),
  );
}
