import type { Column } from "../../shared/types.js";

/**
 * The executable FLOW-01 column-transition specification (`BOARD-06`): every column-changing
 * trigger against its legal source column(s), its target, and its OWNING code path. This is the
 * dense, reference-shaped spine — the human-readable table lives at
 * `docs/ARCHITECTURE.md#column-transition-specification`, hand-maintained from this list rather
 * than generated (the invariant gate verifies presence in both homes, not content-equality,
 * matching every other dual-homed invariant in this codebase).
 *
 * 1. Hook `Stop` + `DISPATCH_STATUS: DONE` -> `agent_done` — owner
 *    `hook-events.ts#applyStopEvent` (:119-128) -> `board.store.ts#applyMarker` (:1022-1049).
 *    Sources: any except `APPLY_MARKER_EXCLUDED_SOURCES`.
 * 2. Hook `Stop` + `DISPATCH_STATUS: NEEDS_INPUT` -> `needs_input` — same owner/sources as #1.
 * 3. Hook `UserPromptSubmit` -> `in_progress` — owner `hook-events.ts#applyPromptSubmit`
 *    (:137-139) -> `board.store.ts#flipBack` (:1079-1096). Sources: `FLIP_BACK_SOURCES` (widened
 *    this plan from `needs_input` alone).
 * 4. Hook `PreToolUse` for a pause-class tool -> `needs_input` — owner
 *    `hook-events.ts#applyPreToolUseEvent` (:162-178) -> `applyMarker`. Same sources as #1.
 * 5. Hook `PostToolUse` for a pause-class tool -> `in_progress` — owner `applyHookEvent`'s
 *    `PostToolUse` branch (:301-303) -> `flipBack`. Same sources as #3.
 * 6. Watcher marker decision (pane-parsed) -> `needs_input`/`agent_done` — owner
 *    `watcher.ts#scanSession` (:192-210) reading the PURE `scan-decision.ts#decideScan`, to
 *    `applyMarker`. Same sources as #1.
 * 7. Watcher flip-back decision -> `in_progress` — owner same path (`watcher.ts#scanSession`
 *    :207-209), to `flipBack`. Source: ONLY `needs_input` — `decideScan` never emits a `flipBack`
 *    decision for `agent_done`/`in_review` sources, so the watcher does NOT drive the two edges
 *    this plan adds; only the hook channel (#3, #5) does. Named fact, not a bug.
 * 8. Manual drag / `POST /cards/:id/move` -> any — owner `board.store.ts#moveCardManual`
 *    (:1117-1140), gated by `routes/cards.route.ts`. Today this is a blind set with no source
 *    check (:1122); `agent_done` and To Do -> `in_progress` are illegitimate manual targets closed
 *    in Plan 77-02 — not implemented here.
 * 9. Group member mirroring — NOT an independent trigger; a fan-out from #1, #3, #6 (when the
 *    watcher path applies), #8, `attachExistingSession`, and `completeStart` — owner
 *    `board.store.ts#mirrorMemberColumn` (:186-192), called from exactly these five writers.
 *    Unchanged by Phase 77 — no writer is added to or removed from this set.
 * 10. Session-lost (watcher 3-strike detector, boot reconcile) — column-PRESERVING, no column
 *     write — owner `board.store.ts#markSessionLost` (:965-990).
 * 11. Resume / resume-failed — column-PRESERVING — owner `board.store.ts#resumeSession`
 *     (:1183-) / `#recordResumeFailure` (:1227-1244).
 * 12. Cleanup (Done teardown) — column-PRESERVING (the card already reached `done` via #8 before
 *     cleanup runs) — owner `services/orchestration/cleanup.ts` plus the `board.store.ts` cleanup
 *     mutators.
 * 13. Card creation -> To Do (`createLocalCard` :1391-1418 / `createGroupCard` :1437-) or ->
 *     `inbox` (`newInboxCard` via `store/mapping.ts#applyIssues`) — owner as named.
 * 14. Boot hydration legacy migration (`in_planning` -> To Do / `in_progress`) — owner
 *     `board.store.ts#hydrateFromParsed` (:346-388, migration at :352-353), one-way, deliberately
 *     skips `mirrorMemberColumn`.
 * 15. Start-saga success -> `in_progress` — owner `board.store.ts#completeStart` (:1147-1171) /
 *     `#attachExistingSession` (:869-894).
 *
 * Agent Done and In Review carry OPPOSITE asymmetries. Agent Done has an automatic in-edge
 * (marker) and, before this plan, no automatic out-edge except an already-intentional
 * `agent_done -> needs_input` on a new distinct marker (`applyMarker`'s own guard, unchanged). In
 * Review has NO automatic in-edge (deliberately deferred, out of this phase's scope) but DOES have
 * automatic out-edges (marker to needs_input / agent_done, and, after this plan, prompt-driven
 * flip-back to in_progress).
 *
 * Conflicts this phase closes, by plan: `flipBack`'s guard covered `needs_input` only (closed
 * HERE, Task 2); the Inbox marker-guard hole in `applyMarker` (closed HERE, Task 2);
 * `moveCardManual`'s blind set into `agent_done` and To Do -> `in_progress` (closed in Plan 77-02);
 * `applyMarker`'s event-type derived from the target column rather than passed explicitly, and the
 * `hookRoutedAt` double-write window at launch (both closed in Plan 77-03).
 *
 * Legal source columns for `flipBack` — the target is always `in_progress` (no
 * return-to-previous-column history state). Read by `board.store.ts#flipBack`.
 * @see docs/ARCHITECTURE.md#column-transition-specification
 */
export const FLIP_BACK_SOURCES: readonly Column[] = [
  "needs_input",
  "agent_done",
  "in_review",
] as const;

/**
 * The subset of {@link FLIP_BACK_SOURCES} whose flip ALSO clears `card.lastMarker`. `needs_input`
 * is deliberately EXCLUDED — flipping out of `needs_input` must stay byte-identical to today
 * (FLOW-05). Read by `board.store.ts#flipBack`.
 */
export const FLIP_BACK_CLEARS_LAST_MARKER: readonly Column[] = [
  "agent_done",
  "in_review",
] as const;

/**
 * Source columns `applyMarker` refuses to move a card out of. `inbox` is the new member this plan
 * adds (an inbox card structurally never carries a `tmuxSession` so no live caller reaches this
 * path today, but the guard must not rely on that accident); To Do and Done are unchanged from
 * today. Read by `board.store.ts#applyMarker`.
 */
export const APPLY_MARKER_EXCLUDED_SOURCES: readonly Column[] = [
  "todo",
  "done",
  "inbox",
] as const;

/**
 * `BOARD-07`: Agent Done is NEVER a legal manual target from any source — the only sanctioned
 * entry is a real completion signal via `applyMarker`, never a drag or a bare REST move. Read by
 * `board.store.ts#moveCardManual` and `routes/cards.route.ts#manualMoveTransitionError`.
 * @see docs/ARCHITECTURE.md#column-transition-specification
 */
export function blocksAgentDoneManualEntry(to: Column): boolean {
  return to === "agent_done";
}

/**
 * `BOARD-07`: To Do -> In Progress is reserved for the start saga (`completeStart` /
 * `attachExistingSession`), which provisions a session; a manual move would park a card in In
 * Progress with none. Read by the same two call sites as {@link blocksAgentDoneManualEntry}.
 */
export function blocksTodoToInProgressManualMove(
  from: Column,
  to: Column,
): boolean {
  return from === "todo" && to === "in_progress";
}

/**
 * `BOARD-07`: the manual-move allowlist. Every `(from, to)` pair the pre-Phase-77 blind set
 * allowed stays allowed — this closes exactly the two named holes above, nothing more. The sole
 * authority is `moveCardManual`, consulted inside the enqueue callback (WR-04 precedent); the
 * route's use of this same predicate is for a legible message only, never the enforcement point.
 * @see docs/ARCHITECTURE.md#column-transition-specification
 */
export function isManualMoveAllowed(from: Column, to: Column): boolean {
  return (
    !blocksAgentDoneManualEntry(to) &&
    !blocksTodoToInProgressManualMove(from, to)
  );
}
