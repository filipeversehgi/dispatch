import type { PreviewInfo } from "../../shared/types.js";
import { listPrsForBranch, type PrProbeResult } from "./gh.js";
import { panePidsBySession } from "./tmux.js";
import { listeningPortsBySession } from "./dev-server.js";
import { store } from "../store/board.store.js";

/**
 * Detection tick cadence. Replaces the 60s Linear-poll piggyback (F-01/F-02) with a dedicated
 * timer so both probes run regardless of Linear configuration or health.
 */
const ARTIFACT_DETECT_INTERVAL_MS = 10_000;

let artifactDetectInFlight: Promise<void> | null = null;

/**
 * Fan out the combined per-card artifact detection (PR lookup + dev-server preview scan) across
 * every live-session card, driven by this module's own self-rescheduling ~10s loop.
 *
 * @remarks
 * Single-flighted: a tick slower than the 10s cadence must not stack a second fan-out on top of
 * one still in flight. One guard still covers BOTH probe types in one pass — preview detection is
 * a passenger on the same call, never a second timer or a second in-flight variable.
 */
async function detectCardArtifacts(backendPort: number): Promise<void> {
  if (artifactDetectInFlight != null) return artifactDetectInFlight;

  artifactDetectInFlight = runArtifactDetection(backendPort).finally(() => {
    artifactDetectInFlight = null;
  });
  return artifactDetectInFlight;
}

/**
 * @remarks
 * Per-repo PR outcomes (F-03/F-04): a failing repo no longer discards a succeeding sibling's PRs
 * — `next` flattens only the `ok: true` entries, while any `ok: false` entry sets `prsUnknown` to
 * the first failing repo's category. The asymmetry is deliberate: a repo that answers with zero
 * PRs still clears that repo's contribution to `prs`, while a failing repo contributes nothing to
 * `prs` and sets `prsUnknown` — so a card with one succeeding and one failing repo shows both the
 * succeeding repo's PRs AND the unknown badge at once. Both the `prs` and `prsUnknown` writes carry
 * their own write-skip diff so an unchanged tick never rebroadcasts.
 */
async function runArtifactDetection(backendPort: number): Promise<void> {
  const cards = store.cardsWithSession();

  const panePids = await panePidsBySession();
  let portsBySession: Map<string, number[]> | null = null;
  if (panePids != null) {
    const sessionNames = new Set(
      cards.map((c) => c.tmuxSession).filter((s): s is string => s != null),
    );
    const narrowed = new Map(
      [...panePids].filter(([session]) => sessionNames.has(session)),
    );
    portsBySession = await listeningPortsBySession(narrowed);
  }

  await Promise.all(
    cards.map(async (card) => {
      const session = card.tmuxSession as string;

      if (card.branch != null && card.workspace != null) {
        const branch = card.branch;
        const repos = card.workspace.repos;
        const results = await Promise.all(
          repos.map((repo) => listPrsForBranch(repo.path, branch)),
        );
        const failed = results.filter(
          (r): r is Extract<PrProbeResult, { ok: false }> => !r.ok,
        );
        const next = results
          .filter((r): r is Extract<PrProbeResult, { ok: true }> => r.ok)
          .flatMap((r) => r.prs);
        if (JSON.stringify(card.prs ?? []) !== JSON.stringify(next)) {
          await store.setPrsIfSession(card.id, session, next);
        }
        if (failed.length > 0) {
          const category = failed[0].category;
          if (card.prsUnknown?.category !== category) {
            await store.setPrsUnknownIfSession(card.id, session, {
              category,
            });
          }
        } else if (card.prsUnknown != null) {
          await store.setPrsUnknownIfSession(card.id, session, null);
        }
      }

      if (portsBySession == null) return;
      const ports = portsBySession.get(session) ?? [];
      const next: PreviewInfo[] = ports
        .filter((port) => port !== card.ttydPort && port !== backendPort)
        .map((port) => ({ port, url: `http://localhost:${port}` }));
      if (JSON.stringify(card.previews ?? []) === JSON.stringify(next)) return;
      await store.setPreviewsIfSession(card.id, session, next);
    }),
  );
}

/**
 * Start the unconditional artifact-detection loop. Runs regardless of Linear configuration or
 * health (closes F-01/F-02), self-rescheduling on its own ~10s cadence rather than piggybacking on
 * the 60s Linear poll.
 * @remarks Mirrors `startMarkerWatcher`'s tick/scheduleNext/unref/immediate-first-run shape
 * exactly: a self-rescheduling `setTimeout` (never a fixed-interval timer, which could overlap a
 * slow tick), `timer.unref?.()` so it never pins the process, and a per-tick try/catch so one
 * failure never kills the loop. `backendPort` arrives as a plain parameter rather than an
 * infra-layer config lookup — `adapters` may import only `adapters`/`sources`/`store`/`shared`.
 * @see docs/ARCHITECTURE.md#dev-server-preview-detection
 */
export function startArtifactDetectionLoop(backendPort: number): void {
  async function tick(): Promise<void> {
    try {
      await detectCardArtifacts(backendPort);
    } catch (err) {
      console.error(
        `[artifact-detect] tick failed — continuing: ${(err as Error).message}`,
      );
    } finally {
      scheduleNext();
    }
  }

  function scheduleNext(): void {
    const timer = setTimeout(() => void tick(), ARTIFACT_DETECT_INTERVAL_MS);
    timer.unref?.();
  }

  void tick();
}
