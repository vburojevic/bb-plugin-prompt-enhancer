// Adaptive enhancement timeout: a flat ceiling fits neither a ~5s Haiku nor
// a busy Opus queue. The timeout scales from recent completion times for the
// same model key, so failures surface fast without killing slow-but-alive
// runs. Pure so it can be unit tested; server.ts supplies the samples.

export const DEFAULT_TIMEOUT_MS = 90_000;
export const MIN_TIMEOUT_MS = 20_000;
export const MAX_TIMEOUT_MS = 180_000;
/** Adapt only once this many completions exist for the model key. */
export const MIN_SAMPLES = 3;

/**
 * Timeout for the next run given recent completion durations (ms) of the
 * same model key: double the p90 plus fixed headroom, clamped. Too little
 * history falls back to the default.
 */
export function adaptiveTimeoutMs(recentDurationsMs: readonly number[]): number {
  const valid = recentDurationsMs.filter(
    (duration) => Number.isFinite(duration) && duration > 0,
  );
  if (valid.length < MIN_SAMPLES) return DEFAULT_TIMEOUT_MS;
  const sorted = [...valid].sort((a, b) => a - b);
  const p90 =
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, p90 * 2 + 8_000));
}
