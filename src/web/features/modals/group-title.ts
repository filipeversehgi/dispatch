import type { Card } from "../../../shared/types.js";

/**
 * Bounds the phrase portion of a group title alone.
 * @remarks Deliberately larger than Plan 78-02's ~48-char server-side generation cap, since this
 * budget also has to bound the otherwise-unbounded identifier-join fallback phrase, which no
 * generation-time clamp ever touches. Tuned against `CardView`'s 2-line/1-line-compact clamp and
 * the single-line ellipsis renders in `OrcaNavRow.tsx` and `PanelHeader.tsx` at a 390px viewport —
 * the phase-smoke-tester gate should visually confirm a 2-member and an 8-member group at that
 * width and adjust this constant if it looks visually broken (cut mid-identifier, or wrapping
 * past 2 lines on `CardView`).
 */
const PHRASE_CHAR_BUDGET = 56;

/**
 * Bounds the total title (phrase plus bracket-with-identifiers) before the bracket degrades to a
 * count-only suffix.
 * @remarks Same tuning basis as `PHRASE_CHAR_BUDGET` — see that constant's remarks.
 */
const TITLE_WITH_IDS_BUDGET = 80;

function truncatePhrase(phrase: string, max: number): string {
  return phrase.length <= max
    ? phrase
    : `${phrase.slice(0, max - 1).trimEnd()}…`;
}

function deterministicPhrase(members: Card[]): string {
  const firstProject = members[0].project;
  if (
    firstProject != null &&
    members.every((m) => m.project?.id === firstProject.id)
  ) {
    return firstProject.name;
  }
  return members.map((m) => m.identifier).join(" + ");
}

/**
 * Appends the GRP-02 bracketed count/identifier suffix to any phrase.
 * @remarks Bounds `phrase` to `PHRASE_CHAR_BUDGET` first, defending against the identifier-join
 * fallback branch which is otherwise unbounded by member count. Tries `phrase [N: id, id, ...]`;
 * falls back to `phrase [N tickets]` when the full form would exceed `TITLE_WITH_IDS_BUDGET`. The
 * bracketed suffix is present in both branches, never omitted.
 */
export function composeGroupTitle(phrase: string, members: Card[]): string {
  const bounded = truncatePhrase(phrase, PHRASE_CHAR_BUDGET);
  const ids = members.map((m) => m.identifier).join(", ");
  const withIds = `${bounded} [${members.length}: ${ids}]`;
  return withIds.length <= TITLE_WITH_IDS_BUDGET
    ? withIds
    : `${bounded} [${members.length} tickets]`;
}

/**
 * The client-only default group title: the shared Linear project name when every member's
 * `project?.id` matches, otherwise today's identifier join — always bracket-suffixed via
 * `composeGroupTitle`.
 * @remarks This is Plan 78-01's whole contribution to the title; Plan 78-02 layers a
 * background-generated phrase on top via this same `composeGroupTitle`.
 */
export function deterministicGroupTitle(members: Card[]): string {
  return composeGroupTitle(deterministicPhrase(members), members);
}
