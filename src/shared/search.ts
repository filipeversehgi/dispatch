import type { Column } from "./types.js";

/**
 * A board-wide search hit (`GET /api/search`, SCALE-03): four fields, deliberately NOT a `Card`
 * and NOT a `Partial<Card>`. A minimal record typed as `Card` would eventually be rendered as one
 * by a call site that skipped its type guard; a `Partial<Card>` still structurally PERMITS
 * `hookToken` and `description` to ride along if a future edit widened the projection by accident.
 * This type makes that impossible by construction — there is no field to redact because there is
 * no field to carry it.
 */
export interface CardSearchResult {
  id: string;
  identifier: string;
  title: string;
  column: Column;
}

/** Maximum rows a single `GET /api/search` response ever carries; `total` reports the full count. */
export const SEARCH_RESULT_LIMIT = 20;

/** Minimum trimmed query length before any request fires — below this the client opens no panel. */
export const SEARCH_QUERY_MIN = 2;

/**
 * Maximum trimmed query length `GET /api/search` accepts, bounding worst-case scan cost — a DoS
 * guard, not an injection guard (`T-82-02`).
 */
export const SEARCH_QUERY_MAX = 100;
