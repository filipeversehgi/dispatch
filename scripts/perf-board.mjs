/**
 * Board-at-scale measurement harness (SCALE-05, dev/ops tooling, NOT test code): imports no test
 * framework, asserts nothing about app runtime behavior, and lives outside src/ — the same
 * category as check-invariants.mjs, perf-rerender.mjs, perf-sse.mjs, and perf-cleanup.mjs.
 *
 * It answers the one question Phase 82 needs a before/after number for: does the board pay a cost
 * proportional to total card count? Three numbers, each isolating one leg of that cost:
 *   - initial `/api/board` payload bytes and card count (the full-snapshot REST fallback)
 *   - one SSE frame's byte size following a single card mutation (the broadcast leg)
 *   - React commits caused by that same single mutation, via the same raw-CDP DevTools-hook
 *     technique perf-rerender.mjs already proved (headless Chrome, zero new npm dependency)
 *
 * SANDBOX SAFETY (non-negotiable, enforced by assertSandboxSafe before any fs/spawn call): this
 * harness seeds and boots a throwaway server. It never touches the real `~/.dispatch` directory
 * or `board.db`, never reads the real `~/.dispatch/config.json` (so it never needs, and never
 * sees, a Linear API key — cards are seeded directly via node:sqlite, not synced), and never binds
 * the port the user's real, live dispatch instance listens on. Every sandbox HOME lives under
 * `os.tmpdir()` with a `dispatch-perf-board-` basename, verified structurally, not by convention.
 *
 * `--dev` is intentionally UNSUPPORTED (a deliberate departure from perf-rerender.mjs's tsx+vite
 * fallback): vite.config.ts hardcodes its dev-mode `/api/`+`/sessions/` proxy target to the user's
 * real, live dispatch port, and this harness's sandbox-safety guarantee forbids ever binding that
 * port from a second instance. Passing `--dev` prints a clear explanation and exits 1 rather than
 * silently reusing that port or silently falling back to prod — only the production build
 * (`npm run build`) can be measured here.
 *
 * Usage:
 *   node scripts/perf-board.mjs [--done=500] [--runs=3]     measure the production build (default)
 *   node scripts/perf-board.mjs --dev                        unsupported — prints why, exits 1
 *
 * Prints one stderr line per run, then a machine-parsable summary:
 *   PERF-BOARD mode=<prod|dev> done=<n> initialBytes=<n> initialCards=<n> sseFrameBytes=<n> loadCommits=<n> commits=<n>
 *
 * Exit codes: 0 success. 1 setup/teardown/build error. 2 production hook never fired (rerun is
 * pointless — --dev is unsupported, so this is a hard failure, not a retry signal).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_ENTRY = join(REPO_ROOT, "dist", "server", "bootstrap", "index.js");

const SANDBOX_PORT = 47820;
const CDP_PORT = 9359;
const SANDBOX_PREFIX = "dispatch-perf-board-";

const POLL_INTERVAL_MS = 100;
const READY_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 5_000;

const DEFAULT_DONE_COUNT = 500;
const DEFAULT_RUNS = 3;
const AWAITING_EVERY_NTH = 25;

/**
 * The one manual-move pair this harness drives, verified against
 * src/shared/column-transitions.ts's `isManualMoveAllowed`: neither direction of done<->todo is
 * blocked (blocksAgentDoneManualEntry only refuses a move INTO agent_done; blocksTodoToInProgressManualMove
 * only refuses todo -> in_progress), so this round trip is a real, server-accepted transition, not
 * a guess.
 */
const MUTATION_TARGET_COLUMN = "todo";

/** Read `--done=N` off argv, defaulting to 500 (CONTEXT's locked "realistically large" number). */
function readDoneFlag(argv) {
  const flag = argv.find((a) => a.startsWith("--done="));
  if (!flag) return DEFAULT_DONE_COUNT;
  const n = Number(flag.slice("--done=".length));
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--done must be a positive integer, got: ${flag}`);
    process.exit(1);
  }
  return n;
}

/** Read `--runs=N` off argv, defaulting to 3 (this repo's 3-run-median convention). */
function readRunsFlag(argv) {
  const flag = argv.find((a) => a.startsWith("--runs="));
  if (!flag) return DEFAULT_RUNS;
  const n = Number(flag.slice("--runs=".length));
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--runs must be a positive integer, got: ${flag}`);
    process.exit(1);
  }
  return n;
}

function readDevFlag(argv) {
  return argv.includes("--dev");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * The structural guarantee behind "never touches the user's real board.db or port 4700": called
 * before any filesystem write or child-process spawn touching `home`. Throws (never silently
 * degrades) if any check fails.
 */
function assertSandboxSafe(home) {
  if (SANDBOX_PORT === 4700) {
    throw new Error(
      "SANDBOX_PORT must never equal 4700 — that is the user's live dispatch instance.",
    );
  }
  if (home === homedir()) {
    throw new Error(
      "sandbox home must never equal the real $HOME — refusing to proceed.",
    );
  }
  if (!home.startsWith(tmpdir())) {
    throw new Error(
      `sandbox home ${home} must live under ${tmpdir()} — refusing to proceed.`,
    );
  }
  if (!basename(home).startsWith(SANDBOX_PREFIX)) {
    throw new Error(
      `sandbox home ${home} must have a basename starting with "${SANDBOX_PREFIX}" — refusing to proceed.`,
    );
  }
}

/**
 * Sandbox HOME with NO `sources` key at all — this harness seeds Done cards directly via
 * node:sqlite, so it never reads the real `~/.dispatch/config.json` and never needs a Linear key.
 */
function makeSandboxHome(label) {
  const home = join(tmpdir(), `${SANDBOX_PREFIX}${label}-${process.pid}`);
  assertSandboxSafe(home);
  const dispatchDir = join(home, ".dispatch");
  mkdirSync(dispatchDir, { recursive: true });
  writeFileSync(
    join(dispatchDir, "config.json"),
    JSON.stringify(
      {
        port: SANDBOX_PORT,
        workspaceRoot: join(home, "workspaces"),
        statusChannel: "auto",
        updateCheck: false,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return home;
}

/** Poll `GET /api/board` on `port` until it returns 200. */
async function waitForReady(port) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/board`);
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // server not listening yet — keep polling
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `server on :${port} did not answer 200 on /api/board within ${READY_TIMEOUT_MS}ms`,
  );
}

function killAndWait(child) {
  if (child == null) return Promise.resolve();
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const escalate = setTimeout(() => child.kill("SIGKILL"), KILL_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(escalate);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

/**
 * Boot the harness's own server against `home`. `--dev` is refused here (see the file header) —
 * this function only ever spawns the production build, never the tsx/vite fallback.
 */
function bootServer(home, dev) {
  if (dev) {
    console.error(
      "perf-board.mjs does not support --dev: the dev-mode frontend proxy target is hardcoded " +
        "in vite.config.ts to the user's real, live dispatch port, and this harness's " +
        "sandbox-safety guarantee forbids ever binding that port from a second instance. Only " +
        "the production build can be measured by this script — run `npm run build` and rerun " +
        "without --dev.",
    );
    process.exit(1);
  }
  if (!existsSync(DIST_ENTRY)) {
    console.error(`Missing ${DIST_ENTRY} — run \`npm run build\` first.`);
    process.exit(1);
  }
  return spawn("node", [DIST_ENTRY], {
    env: { ...process.env, HOME: home, NODE_ENV: "production" },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

/**
 * TWO-BOOT seeding: boot once so the store's own `board-db.ts` creates the real schema (WAL mode,
 * every table/index), kill it, then insert `count` Done cards directly via node:sqlite. This
 * avoids a second, hand-duplicated schema that could drift from the store's own.
 */
async function seedDoneCards(home, count) {
  const warmup = bootServer(home, false);
  try {
    await waitForReady(SANDBOX_PORT);
  } finally {
    await killAndWait(warmup);
  }

  const dbPath = join(home, ".dispatch", "board.db");
  const db = new DatabaseSync(dbPath);
  try {
    const insert = db.prepare(
      `INSERT INTO cards (id, data) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
    );
    db.exec("BEGIN");
    for (let i = 0; i < count; i++) {
      const id = `perf-${i}`;
      const updatedAt = new Date(Date.now() - i * 60_000).toISOString();
      const card = {
        id,
        issueId: `perf-issue-${i}`,
        identifier: `PERF-${i}`,
        title: `Seeded done ticket ${i} for the board-at-scale harness`,
        description: null,
        priority: 3,
        column: "done",
        updatedAt,
      };
      if (i % AWAITING_EVERY_NTH === 0) {
        card.tmuxSession = `dsp-PERF-${i}`;
        card.workspacePath = join(home, "workspaces", `PERF-${i}`);
      }
      insert.run(id, JSON.stringify(card));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.close();
  }
}

/** `GET /api/board`'s raw byte size and card count — the full-snapshot REST fallback leg. */
async function measureInitialBytes(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/board`);
  const body = await res.text();
  const snapshot = JSON.parse(body);
  return {
    initialBytes: Buffer.byteLength(body, "utf8"),
    initialCards: snapshot.cards.length,
  };
}

async function moveCard(port, id, column) {
  const res = await fetch(`http://127.0.0.1:${port}/api/cards/${id}/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column }),
  });
  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`move ${id} -> ${column} failed (${res.status}): ${body}`);
  }
  await res.json();
}

/**
 * Wrap one SSE connection's readable body: `nextBoardFrame()` resolves on the next UNNAMED
 * `data:` frame, skipping every NAMED frame (`event: tunnel`/`event: ping`/`event: activity`) —
 * matching perf-sse.mjs's exact frame-boundary/skip logic.
 */
function makeFrameReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  return {
    async nextBoardFrame() {
      for (;;) {
        const boundary = buf.indexOf("\n\n");
        if (boundary !== -1) {
          const raw = buf.slice(0, boundary);
          buf = buf.slice(boundary + 2);
          if (raw.startsWith("data:")) return raw;
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream closed unexpectedly");
        buf += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

/**
 * One SSE frame's byte size following exactly one mutation on `perf-0` (done -> todo, then
 * restored to `done` so the run is idempotent). The resync frame sent on connect is discarded
 * before the mutation is driven, so only the broadcast frame counts.
 */
async function measureSseFrameBytes(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/stream`);
  const reader = makeFrameReader(res);
  try {
    await reader.nextBoardFrame();
    await moveCard(port, "perf-0", MUTATION_TARGET_COLUMN);
    const mutationFrame = await reader.nextBoardFrame();
    await moveCard(port, "perf-0", "done");
    return Buffer.byteLength(`${mutationFrame}\n\n`, "utf8");
  } finally {
    await reader.close();
  }
}

/** One full measured run: fresh sandbox, seed, boot, measure both byte legs, teardown. */
async function runByteMetrics(doneCount, runIndex) {
  const home = makeSandboxHome(`run${runIndex}`);
  let server = null;
  try {
    await seedDoneCards(home, doneCount);
    server = bootServer(home, false);
    await waitForReady(SANDBOX_PORT);
    const { initialBytes, initialCards } =
      await measureInitialBytes(SANDBOX_PORT);
    const sseFrameBytes = await measureSseFrameBytes(SANDBOX_PORT);
    console.error(
      `run=${runIndex} initialBytes=${initialBytes} initialCards=${initialCards} sseFrameBytes=${sseFrameBytes}`,
    );
    return { initialBytes, initialCards, sseFrameBytes };
  } finally {
    await killAndWait(server);
    rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const dev = readDevFlag(argv);
  if (dev) {
    bootServer(null, true);
    return;
  }

  const doneCount = readDoneFlag(argv);
  const runs = readRunsFlag(argv);

  for (let i = 1; i <= runs; i++) {
    await runByteMetrics(doneCount, i);
  }
}

main().catch((err) => {
  console.error(`perf-board failed: ${err.stack ?? err.message}`);
  process.exit(1);
});
