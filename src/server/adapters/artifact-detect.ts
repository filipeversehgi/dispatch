import net from "node:net";
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

/** Bare-TCP-connect confirmation timeout for a single discovered preview port candidate. */
const PREVIEW_PROBE_TIMEOUT_MS = 500;

/**
 * Bounded ceiling on consecutive detection-tool failures before a signal stops holding
 * last-known-good and falls to "could not check" (`RESIL-02`).
 *
 * @remarks
 * The same threshold `RESIL-01` already uses for three consecutive capture failures, applied here
 * to a second signal. A counter increments ONLY on a genuine detection-tool failure — an
 * `{ ok: false }` result from `listPrsForBranch`, or a `null` return from
 * `panePidsBySession`/`listeningPortsBySession` — never on a `confirmReachable`-rejected
 * candidate, which is a SUCCESSFUL tick that confirmed zero previews and resets the counter
 * instead. The unknown status is set on the first failure so a silent tooling failure is visible
 * at once; the data field is cleared only once the ceiling is reached, so a single blip never
 * wipes last-known-good.
 * @see docs/ARCHITECTURE.md#resilience-and-reconcile
 */
const PROBE_FAILURE_CEILING = 3;

/** Consecutive PR-probe tool-failure count per card id, pruned every tick to live sessions. */
const prFailureCounts = new Map<string, number>();

/** Consecutive preview-probe tool-failure count per card id, pruned every tick to live sessions. */
const previewFailureCounts = new Map<string, number>();

let artifactDetectInFlight: Promise<void> | null = null;

/**
 * Confirm a discovered port actually accepts a TCP connection before it is advertised as a
 * preview (F-07: a bound-but-unreachable LISTEN-only port is not the same claim as "answers").
 *
 * @remarks
 * Acceptance is TCP handshake completion ALONE — never an HTTP request or status code. An
 * HTTP-status probe would wrongly reject a real dev server whose `/` returns 404 (a common shape
 * for an API-only or SPA dev server with no index route) and would fail a TLS-only dev server
 * outright, whereas a bare connect asserts nothing about the application protocol above it. The
 * accepted limitation: a process wedged past its own accept queue still passes this probe — the
 * same tradeoff `ttyd.ts`'s `probeAdoption` already accepts in this codebase.
 */
function confirmReachable(
  port: number,
  timeoutMs = PREVIEW_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(timeoutMs, () => done(false));
  });
}

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
 * Per-repo PR outcomes (F-03/F-04): `next` flattens only the `ok: true` entries, while any
 * `ok: false` entry sets `prsUnknown` to the first failing repo's category and advances
 * `prFailureCounts` (`RESIL-02`) — reset to zero on a tick where every repo answers. The `prs`
 * write is the succeeding repos' data below the ceiling, so a card with one succeeding and one
 * failing repo shows both the succeeding repo's PRs AND the unknown badge at once; at or above
 * `PROBE_FAILURE_CEILING` consecutive failing ticks the write is forced to `[]` instead, so a
 * permanently-failing repo cannot leave a stale PR sitting on the board forever. Both the `prs`
 * and `prsUnknown` writes carry their own write-skip diff so an unchanged tick never rebroadcasts.
 *
 * Preview exclusion (F-09) is a `Set<number>` built ONCE per tick — `backendPort` plus every live
 * card's `ttydPort` — rather than checking only the current card's own field, so a stale, freed
 * ttyd port picked up moments later by a DIFFERENT card's real dev server can no longer leak into
 * that card's previews. A discovered candidate that survives the exclusion set still needs a
 * `confirmReachable` pass (F-07) before it becomes a `PreviewInfo`; a discovered-but-unreachable
 * port is a SUCCESSFUL tick that found zero confirmed previews (the `[]` case) and resets
 * `previewFailureCounts` (`RESIL-02`) — only a `null` return from
 * `panePidsBySession`/`listeningPortsBySession` is a genuine tool failure, which advances the
 * counter for every live-session card, latches `previewsUnknown` on the first failure, and forces
 * `previews` to `[]` once the ceiling is reached.
 */
async function runArtifactDetection(backendPort: number): Promise<void> {
  const cards = store.cardsWithSession();

  const excludedPorts = new Set<number>([backendPort]);
  for (const card of cards) {
    if (card.ttydPort != null) excludedPorts.add(card.ttydPort);
  }

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
        let finalPrs = results
          .filter((r): r is Extract<PrProbeResult, { ok: true }> => r.ok)
          .flatMap((r) => r.prs);

        if (failed.length > 0) {
          const count = (prFailureCounts.get(card.id) ?? 0) + 1;
          prFailureCounts.set(card.id, count);
          const category = failed[0].category;
          if (card.prsUnknown?.category !== category) {
            await store.setPrsUnknownIfSession(card.id, session, {
              category,
            });
          }
          if (count >= PROBE_FAILURE_CEILING) finalPrs = [];
        } else {
          prFailureCounts.delete(card.id);
          if (card.prsUnknown != null) {
            await store.setPrsUnknownIfSession(card.id, session, null);
          }
        }

        if (JSON.stringify(card.prs ?? []) !== JSON.stringify(finalPrs)) {
          await store.setPrsIfSession(card.id, session, finalPrs);
        }
      }

      if (portsBySession == null) {
        const count = (previewFailureCounts.get(card.id) ?? 0) + 1;
        previewFailureCounts.set(card.id, count);
        if (card.previewsUnknown?.category !== "detection unavailable") {
          await store.setPreviewsUnknownIfSession(card.id, session, {
            category: "detection unavailable",
          });
        }
        if (
          count >= PROBE_FAILURE_CEILING &&
          JSON.stringify(card.previews ?? []) !== "[]"
        ) {
          await store.setPreviewsIfSession(card.id, session, []);
        }
        return;
      }

      previewFailureCounts.delete(card.id);
      if (card.previewsUnknown != null) {
        await store.setPreviewsUnknownIfSession(card.id, session, null);
      }

      const ports = portsBySession.get(session) ?? [];
      const candidates = ports.filter((port) => !excludedPorts.has(port));
      const reachable = await Promise.all(
        candidates.map((port) => confirmReachable(port)),
      );
      const next: PreviewInfo[] = candidates
        .filter((_port, i) => reachable[i])
        .map((port) => ({ port, url: `http://localhost:${port}` }));
      if (JSON.stringify(card.previews ?? []) === JSON.stringify(next)) return;
      await store.setPreviewsIfSession(card.id, session, next);
    }),
  );

  const liveIds = new Set(store.cardsWithSession().map((c) => c.id));
  for (const id of prFailureCounts.keys()) {
    if (!liveIds.has(id)) prFailureCounts.delete(id);
  }
  for (const id of previewFailureCounts.keys()) {
    if (!liveIds.has(id)) previewFailureCounts.delete(id);
  }
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
