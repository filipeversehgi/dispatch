/** Default Done-column page size for both wire endpoints when `doneLimit` is absent. */
export const DONE_PAGE_SIZE = 50;

/** Upper bound a client may ever request for `doneLimit` — the `T-82-01` DoS ceiling. */
export const DONE_LIMIT_MAX = 5000;

/**
 * Parse an untrusted `doneLimit` query value into a bounded integer, or `null` for anything
 * that does not coerce to a whole number in `[1, DONE_LIMIT_MAX]` (`T-82-01`). Never throws and
 * never clamps — the caller decides what an invalid value means: `GET /api/board` rejects it
 * with 400, while `GET /api/stream` falls back to {@link DONE_PAGE_SIZE} because an
 * `EventSource` retries a failed connect forever, so a 400 there would be an infinite reconnect
 * loop rather than an actionable error.
 */
export function parseDoneLimit(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > DONE_LIMIT_MAX) return null;
  return n;
}
