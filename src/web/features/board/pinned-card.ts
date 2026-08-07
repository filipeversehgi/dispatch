import type { Card as CardModel } from "../../../shared/types.js";

/**
 * The out-of-window card pinned into the detail panel so search can open it despite windowing
 * (SCALE-03). `"stub"` is `stubToCard`'s filler-value placeholder — every non-identity field is
 * meaningless, so it must NEVER be actionable. `"hydrated"` is a genuine `GET /api/cards/:id`
 * result: a complete, redacted, real card, exactly as actionable as one the board's own window
 * already carries. `card` and `kind` are bundled in one state value, not two booleans set in
 * parallel, so an action-derivation site cannot read one without the other and re-collapse the
 * distinction this type exists to keep explicit. `members` is bundled here for the same reason —
 * a site that could read the member list without also reading `kind` would re-collapse the
 * stub/hydrated distinction this type exists to keep explicit.
 */
export type PinnedCard = {
  card: CardModel;
  kind: "stub" | "hydrated";
  members: CardModel[];
};

/**
 * The card to act on when a live-window lookup (`board.cards.find`) misses — actionable ONLY when
 * the fallback is the pinned card AND it is genuinely hydrated, never a stub. Shared by every
 * click-time action derivation in `App.tsx` (`startCard`, `cleanupCard`) so a future one cannot
 * re-collapse the stub/hydrated distinction `PinnedCard` exists to keep explicit.
 */
export function actionablePinnedCard(
  id: string | null | undefined,
  pinned: PinnedCard | null,
): CardModel | null {
  return pinned != null && pinned.kind === "hydrated" && pinned.card.id === id
    ? pinned.card
    : null;
}

/**
 * The single site where a member row's actionability is decided for the pinned-fallback case —
 * the sibling to {@link actionablePinnedCard}, same three-part guard, boolean instead of the
 * card itself. A stub's members must never be actionable: every non-identity field of a stub is
 * filler (`search-stub.ts`), so presenting an action on one would act on values the client does
 * not actually know. Callers OR this with their own in-window test; this function deliberately
 * knows nothing about `board.cards`, mirroring how `actionablePinnedCard` does not either.
 *
 * `MemberRow`'s `actionable` prop (the sole consumer of this boolean, threaded through
 * `ReferenceBlocks`) is declared REQUIRED with no default — deliberately unlike `MemberRow`'s
 * `dense` prop — so a new call site is a compile error rather than a silent inherited default.
 * That rationale lives here, not as a JSDoc on `MemberRow.tsx` itself, because every `.tsx` file
 * under this repo's `src/web` tree carries zero comments of any kind under the comment standard.
 */
export function actionablePinnedMembers(
  id: string | null | undefined,
  pinned: PinnedCard | null,
): boolean {
  return pinned != null && pinned.kind === "hydrated" && pinned.card.id === id;
}
