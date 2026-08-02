import type { Card } from "../../../shared/types.js";
import type { CardSearchResult } from "../../../shared/search.js";

/**
 * Widen a four-field search hit into a placeholder `Card` so an out-of-window selection can open
 * the detail panel instantly (SCALE-03). Every non-identity field (`issueId`, `description`,
 * `priority`, `updatedAt`) is a meaningless filler value — this stub is ALWAYS paired with
 * `hydrating: true` on `DetailPanel`, which gates the body region so those filler values never
 * reach the DOM. This is the ONE named, greppable construction site for a synthetic card
 * precisely so a placeholder record can never be built inline at a second call site.
 */
export function stubToCard(stub: CardSearchResult): Card {
  return {
    id: stub.id,
    identifier: stub.identifier,
    title: stub.title,
    column: stub.column,
    issueId: "",
    description: null,
    priority: 0,
    updatedAt: new Date(0).toISOString(),
  };
}
