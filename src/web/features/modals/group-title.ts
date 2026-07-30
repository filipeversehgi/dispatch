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

/**
 * The one thing a group is reliably known by before any generation lands: the Linear project every
 * member shares. Returns the empty string when they do not share one — there is NO deterministic
 * phrase in that case, and saying so lets `composeGroupTitle` emit the bracket alone.
 * @remarks Deliberately does NOT fall back to joining the identifiers. That join was the original
 * default this feature exists to remove, and re-emitting it here produced titles that carried the
 * identifiers twice over — `PROP-123 + PROP-456 [2: PROP-123, PROP-456]` — since the bracketed
 * suffix already names every member. At higher member counts the join also truncated mid-identifier
 * (`PROP-12…`) immediately before a count restating what the cut list was trying to convey.
 */
function deterministicPhrase(members: Card[]): string {
  const firstProject = members[0].project;
  if (
    firstProject != null &&
    members.every((m) => m.project?.id === firstProject.id)
  ) {
    return firstProject.name;
  }
  return "";
}

/**
 * Appends the GRP-02 bracketed count/identifier suffix to a phrase, which may be empty.
 * @remarks Bounds `phrase` to `PHRASE_CHAR_BUDGET` first. Tries `phrase [N: id, id, ...]`; falls
 * back to `phrase [N tickets]` when the full form would exceed `TITLE_WITH_IDS_BUDGET`. The
 * bracketed suffix is present in both branches, never omitted — it is the only part of the title
 * guaranteed to exist, so an empty phrase yields the bracket alone (`[2: PROP-123, PROP-456]`)
 * rather than a leading space. An empty phrase also leaves the whole budget to the identifiers, so
 * the no-phrase case keeps them at member counts where a phrase-bearing title would have degraded
 * to the count form.
 */
export function composeGroupTitle(phrase: string, members: Card[]): string {
  const bounded = truncatePhrase(phrase.trim(), PHRASE_CHAR_BUDGET);
  const lead = bounded === "" ? "" : `${bounded} `;
  const ids = members.map((m) => m.identifier).join(", ");
  const withIds = `${lead}[${members.length}: ${ids}]`;
  return withIds.length <= TITLE_WITH_IDS_BUDGET
    ? withIds
    : `${lead}[${members.length} tickets]`;
}

/**
 * The client-only default group title: the shared Linear project name when every member's
 * `project?.id` matches, otherwise nothing — always bracket-suffixed via `composeGroupTitle`, so a
 * group with no shared project defaults to the bracket alone.
 * @remarks This is the permanent title whenever generation fails, times out, or is never attempted,
 * so it has to stand on its own rather than read as a placeholder.
 */
export function deterministicGroupTitle(members: Card[]): string {
  return composeGroupTitle(deterministicPhrase(members), members);
}

/**
 * The `MODAL-01` no-visible-wait gate: a background-generated phrase may replace the title
 * field's current value ONLY when the user has not typed since the deterministic default (Plan
 * 78-01) was set.
 * @remarks The caller MUST NEVER gate Start, disable any control, or show any loading indicator on
 * this predicate or on the generation promise settling — generation is a pure enhancement that
 * lands or does not.
 * @see docs/ARCHITECTURE.md#group-card-titles
 */
export function shouldAcceptGeneratedPhrase(userHasEdited: boolean): boolean {
  return !userHasEdited;
}
