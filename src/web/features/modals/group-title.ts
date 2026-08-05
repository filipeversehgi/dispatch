import type { Card } from "../../../shared/types.js";

/**
 * Bounds the phrase portion of a group title alone.
 * @remarks Deliberately larger than Plan 78-02's ~48-char server-side generation cap, since this
 * budget also has to bound the otherwise-unbounded identifier-join fallback phrase, which no
 * generation-time clamp ever touches. Tuned against `CardView`'s 2-line/1-line-compact clamp and
 * the single-line ellipsis renders in `OrcaNavRow.tsx` and `PanelHeader.tsx` at a 390px viewport —
 * visual verification should confirm a 2-member and an 8-member group at that width and this
 * constant should be adjusted if it looks visually broken (cut mid-identifier, or wrapping past 2
 * lines on `CardView`).
 */
const PHRASE_CHAR_BUDGET = 56;

/**
 * Bounds the total title (phrase plus bracket-with-identifiers) before the bracket degrades to a
 * count-only suffix.
 * @remarks Same tuning basis as `PHRASE_CHAR_BUDGET` — see that constant's remarks.
 */
const TITLE_WITH_IDS_BUDGET = 80;

/**
 * Approximate rendered width of one code point in budget units: astral-plane code points (emoji,
 * CJK extensions) occupy roughly two Latin character widths, everything else one.
 * @remarks A deliberate approximation, not a text-shaping measurement. It exists so the budget
 * constants mean roughly what their remarks claim — a VISUAL bound — rather than a raw count under
 * which 27 emoji "fit" a 56-unit budget while rendering about twice as wide.
 */
function pointWidth(point: string): number {
  return (point.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
}

/**
 * Truncate a phrase to `max` budget units, appending an ellipsis when it had to cut.
 * @remarks Iterates CODE POINTS, never UTF-16 code units. Slicing by code unit cut surrogate pairs
 * in half — a project name of emoji produced a title carrying a lone high surrogate, which survived
 * server-side length and marker validation, persisted into the card record, and then rendered as
 * the replacement character in every card, panel header and Orca row (and degraded to U+FFFD again
 * when the title was written into the kickoff file as UTF-8). `trimEnd` cannot repair that.
 */
function truncatePhrase(phrase: string, max: number): string {
  const points = [...phrase];
  let total = 0;
  for (const p of points) total += pointWidth(p);
  if (total <= max) return phrase;

  const kept: string[] = [];
  let width = 0;
  for (const p of points) {
    const w = pointWidth(p);
    if (width + w > max - 1) break;
    kept.push(p);
    width += w;
  }
  return `${kept.join("").trimEnd()}…`;
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
 * @remarks Guards the empty-member case even though the board cannot currently produce it
 * (`SelectionBar` renders nothing below two selections, and `Board` prunes `selectedIds` in the
 * same batch that sets `cards`, so the count and the filtered array cannot diverge). This runs in a
 * `useState` initializer, where a throw takes down the render rather than just the modal, and the
 * code it replaced was total — so the partiality would be newly introduced on a render path.
 * @remarks Collapses whitespace in the project name for the same reason the generated phrase is
 * newline-stripped server-side: an embedded line break would leave the field's DISPLAYED value (the
 * `<input>` value-sanitization algorithm strips CR/LF) different from the value actually submitted.
 */
function deterministicPhrase(members: Card[]): string {
  if (members.length === 0) return "";
  const firstProject = members[0].project;
  if (
    firstProject != null &&
    members.every((m) => m.project?.id === firstProject.id)
  ) {
    return firstProject.name.replace(/\s+/g, " ").trim();
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
 * The `MODAL-01` no-visible-wait gate: a background-generated phrase may replace the title field's
 * current value ONLY when the user has neither typed nor parked a caret inside it.
 * @remarks The caller MUST NEVER gate Start, disable any control, or show any loading indicator on
 * this predicate or on the generation promise settling — generation is a pure enhancement that
 * lands or does not.
 * @remarks Typing is not the only way to claim the field. The input is autofocused on open, so a
 * user can click between two words intending to insert a qualifier and then pause to read the
 * member list; a swap arriving seconds later replaces the whole value and drops the caret at the
 * end of a DIFFERENT string, so their next keystrokes land somewhere they did not choose. An
 * interaction, not just a mutation, therefore blocks the swap.
 * @remarks The test is deliberately "is the caret parked INSIDE the text", not "is the caret at the
 * end". A programmatically focused input's initial selection is browser-dependent — collapsed at
 * offset 0 in some engines, at the end in others — and neither is a user intent. An end-anchored
 * test would treat the offset-0 default as a claimed field and suppress every swap, silently
 * disabling the feature. Both defaults sit at an edge, so an inside-caret test reads them as
 * untouched. A non-collapsed selection is unambiguous user intent at any offset and always blocks.
 * @see docs/ARCHITECTURE.md#group-card-titles
 */
export function shouldAcceptGeneratedPhrase(
  userHasEdited: boolean,
  input: HTMLInputElement | null,
): boolean {
  if (userHasEdited) return false;
  if (input === null || document.activeElement !== input) return true;
  const { selectionStart, selectionEnd, value } = input;
  if (selectionStart === null || selectionEnd === null) return true;
  if (selectionStart !== selectionEnd) return false;
  return selectionStart === 0 || selectionStart === value.length;
}
