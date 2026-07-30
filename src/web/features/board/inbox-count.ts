import type { Card } from "../../../shared/types.js";

/**
 * Counts cards waiting in the Inbox, excluding group members.
 * @remarks Matches the counting convention already used by `groupCardsByColumn`
 * (orca-selectors.ts) and `StatusPillSwitcher`'s per-column count — a deliberate
 * alignment, not an arbitrary choice.
 */
export function inboxWaitingCount(cards: Card[]): number {
  return cards.filter((c) => c.column === "inbox" && c.groupId == null).length;
}
