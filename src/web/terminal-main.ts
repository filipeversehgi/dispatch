import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { TerminalThemeResponse } from "../shared/types.js";
import {
  FONT_FAMILY,
  FONT_SPEC,
  NERD_FONT_WOFF2_BASE64,
} from "../shared/nerd-font-mono.js";

const OUTPUT = 0x30;
const TITLE = 0x31;

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_STABILITY_MS = 3000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Reverse-tabnabbing-safe, modifier-gated link activator shared by both the plain-text
 * (`WebLinksAddon`) and OSC-8 (`linkHandler`) code paths: open a blank tab, null its opener, THEN
 * navigate — `window.open(url, "_blank")` does not reliably null the opener across browsers, which
 * would let the opened page reach back into this terminal via `window.opener`. Ported verbatim
 * from the ttyd stock-index `PATCH_HANDLER` this client retires.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
function activateLink(event: MouseEvent, uri: string): void {
  if (!(event.metaKey || event.ctrlKey)) return;
  const win = window.open();
  if (win) {
    try {
      win.opener = null;
    } catch {}
    win.location.href = uri;
  } else {
    console.warn("dispatch: cmd+click open blocked");
  }
}

/**
 * Derives the ttyd WebSocket URL from the page's own path, since the same bundle is served
 * unmodified under every card's dynamic `/sessions/:id/terminal/` prefix — the client never learns
 * `:id` from anywhere but `window.location`. Chooses `wss:` when the page is `https:` so the
 * tunnel case keeps working.
 */
function deriveWebSocketUrl(): string {
  const base = window.location.pathname.replace(/\/$/, "");
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${base}/ws`;
}

/**
 * Sends the raw ttyd wire-protocol handshake: a single binary frame of bare UTF-8 JSON with NO
 * opcode byte, sent before any other message. ttyd treats this first frame specially — prefixing
 * it with an opcode or delaying it past other setup desyncs ttyd's init parser (RESEARCH.md
 * Pitfall 2).
 */
function sendHandshake(ws: WebSocket, term: Terminal): void {
  ws.send(
    enc.encode(
      JSON.stringify({ AuthToken: "", columns: term.cols, rows: term.rows }),
    ),
  );
}

/**
 * Fetch the resolved Ghostty-parity theme/font block. Returns `null` on any network/non-ok
 * failure — the backend resolver itself never throws, but the client must still open with plain
 * xterm defaults if the fetch itself cannot complete.
 */
async function fetchTheme(): Promise<TerminalThemeResponse | null> {
  try {
    const res = await fetch("/api/terminal-theme");
    if (!res.ok) return null;
    return (await res.json()) as TerminalThemeResponse;
  } catch {
    return null;
  }
}

/**
 * Self-hosts the bundled Nerd Font via a data-URI `@font-face` and enables ligature/stylistic-set
 * shaping on `.xterm` — the DOM renderer shapes `font-feature-settings` natively, so no WebGL
 * addon is needed. Mirrors the proven `font-face-inject` patch in `bootstrap/ttyd-index-setup.ts`
 * rather than reusing it directly, since that patch operates on ttyd's served HTML string, not a
 * live document.
 */
function injectFontFace(): void {
  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: "${FONT_FAMILY}";
      src: url(data:font/woff2;charset=utf-8;base64,${NERD_FONT_WOFF2_BASE64}) format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: block;
    }
    .xterm {
      font-feature-settings: "ss01" 1, "calt" 1, "liga" 1;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Builds the terminal instance and the reverse-tabnabbing-safe link handlers, wired to BOTH
 * `WebLinksAddon` (plain-text URLs) and `linkHandler` (OSC-8, the code path real Claude Code `⏺`
 * output uses and `WebLinksAddon` never fires for) so cmd-click parity holds for either link
 * source. `theme` is `null` when the theme fetch failed — the terminal then opens with plain
 * xterm defaults instead of a half-applied theme.
 * @remarks `smoothScrollDuration: 120` is set unconditionally rather than gated to desktop: a
 * media-query gate would leave hybrid devices (touchscreen laptops, iPad + trackpad) with an
 * instant jump, and the value is harmless on its own during a touch gesture. It is also inert for
 * the entirety of normal dispatch use — under `tmux attach` (the alternate buffer) mouse
 * reporting intercepts the wheel before `.xterm-viewport` ever scrolls, so the ~120ms animation
 * is only observable in the normal buffer. The mobile kinetic scroller zeroes this option for the
 * lifetime of a touch gesture and restores it on settle, so its animation cannot fight the
 * momentum loop's discrete ticks.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
function createTerminal(theme: TerminalThemeResponse | null): {
  term: Terminal;
  fit: FitAddon;
} {
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: theme?.cursorBlink ?? false,
    smoothScrollDuration: 120,
    ...(theme
      ? {
          theme: theme.theme,
          fontFamily: `"${theme.fontFamily}", monospace`,
          fontSize: theme.fontSize,
          fontWeight: theme.fontWeight,
          cursorStyle: theme.cursorStyle,
          ...(theme.letterSpacing !== undefined
            ? { letterSpacing: theme.letterSpacing }
            : {}),
        }
      : {}),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon(activateLink));
  term.options.linkHandler = { activate: activateLink };
  return { term, fit };
}

/**
 * Bounds font-readiness against a fixed timeout so the terminal always opens even if the woff2
 * never loads (a slow/offline data-URI decode, or a browser without the Font Loading API) —
 * mirrors the ttyd stock-index `font-load-gate` patch's `Promise.race` shape.
 */
async function fontsReady(): Promise<void> {
  if (!document.fonts?.load) return;
  await Promise.race([
    document.fonts.load(FONT_SPEC).catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
}

/**
 * Mirrors the ttyd stock-index `shift-enter` patch exactly: a raw LF is sent once, on `keydown`,
 * and BOTH `keydown` and the following `keypress` for the same keystroke are swallowed (`return
 * false`) — xterm's own keypress path independently emits the Enter key's CR immediately after,
 * which would submit the message instead of inserting a newline if keypress were left unswallowed
 * (RESEARCH.md Pitfall 6). `isComposing`/`keyup` always pass through untouched for IME safety.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
function attachShiftEnterHandler(
  term: Terminal,
  ws: () => WebSocket | null,
): void {
  term.attachCustomKeyEventHandler((event) => {
    if (event.isComposing || event.type === "keyup") return true;
    if (
      event.key === "Enter" &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
    ) {
      const socket = ws();
      if (event.type === "keydown" && socket?.readyState === WebSocket.OPEN) {
        socket.send(enc.encode("0" + "\n"));
      }
      return false;
    }
    return true;
  });
}

/**
 * Owns one WebSocket's full lifecycle (handshake, INPUT/RESIZE wiring, OUTPUT/TITLE dispatch, and
 * a bounded reconnect on close) so `main()` stays a single call. `term.onData`/
 * `term.onResize` are registered exactly ONCE against the `socket` closure variable rather than
 * inside `ws.onopen` — re-registering them per reconnect would stack a new listener on every
 * attempt, each still holding its own now-closed WebSocket, so a later reconnect would throw on
 * every keystroke from the stale listeners. The bounded reconnect covers only transient drops
 * (e.g. a backend restart re-adopting ttyd) — the board's own `terminalError`/`ttydPort` contract
 * stays server-driven via `recordTtydExit` on a real ttyd exit, so this client never sets a
 * terminal-error state itself.
 * @remarks The attempt budget resets only after a connection stays open for
 * `RECONNECT_STABILITY_MS`, never on bare `onopen`: a ttyd that accepts the socket then closes
 * immediately (its tmux target vanished while the process lingers, so `recordTtydExit` never
 * fires) would otherwise reset the budget every cycle and reconnect forever, never letting the
 * bounded budget exhaust and the server-driven error contract surface.
 */
function connect(term: Terminal): void {
  let attempts = 0;
  let socket: WebSocket | null = null;

  term.onData((data) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(enc.encode("0" + data));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(enc.encode("1" + JSON.stringify({ columns: cols, rows })));
    }
  });

  const open = () => {
    const ws = new WebSocket(deriveWebSocketUrl(), ["tty"]);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;

    ws.onopen = () => {
      sendHandshake(ws, term);
      stableTimer = setTimeout(() => {
        attempts = 0;
      }, RECONNECT_STABILITY_MS);
    };

    ws.onmessage = (event) => {
      const buf = event.data as ArrayBuffer;
      const bytes = new Uint8Array(buf);
      const op = bytes[0];
      const payload = buf.slice(1);
      if (op === OUTPUT) term.write(new Uint8Array(payload));
      else if (op === TITLE) document.title = dec.decode(payload);
    };

    ws.onclose = () => {
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
      attempts += 1;
      setTimeout(open, RECONNECT_DELAY_MS * attempts);
    };
  };

  open();
  attachShiftEnterHandler(term, () => socket);
}

/**
 * Mounts the terminal into the DOM and keeps it fit to its container, kept separate from
 * `connect()` so a mounted-but-not-yet-connected terminal exists for the mobile zoom controller
 * to wire against before the socket opens — safe because `ws.onopen` cannot fire until `connect()`
 * runs later, so `fit()` here still wins the race and `sendHandshake` still carries measured
 * dimensions.
 * @remarks The `ResizeObserver` callback is rAF-coalesced (a single pending-frame id, cleared on
 * fire) rather than calling `fit.fit()` synchronously per notification. This immunizes against
 * "ResizeObserver loop completed with undelivered notifications" and smooths Android's
 * soft-keyboard resize storm, where the visual viewport shrinks per keystroke burst and each
 * RO -> `fit()` -> `resize()` costs a RESIZE frame plus a full tmux pane repaint.
 */
function mountTerminal(
  term: Terminal,
  mount: HTMLElement,
  fit: FitAddon,
): void {
  term.open(mount);
  fit.fit();
  let pendingFrame: number | undefined;
  new ResizeObserver(() => {
    if (pendingFrame !== undefined) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined;
      fit.fit();
    });
  }).observe(mount);
}

/**
 * Tuning for the mobile kinetic scroller. `PX_PER_TICK` is derived rather than fixed because a
 * tick is worth `altLinesPerTick`/`normalLinesPerTick` rows of content, and a row's height changes
 * with the zoom level. `altLinesPerTick` is 5 to match tmux's default `copy-mode WheelUpPane ->
 * send-keys -X -N 5 scroll-up` binding; `normalLinesPerTick` is 1 because xterm's own viewport
 * consumes a `deltaMode: 1` tick as exactly one row. `maxTicksPerFrame` and `maxMomentumMs` cap the
 * SGR-report / tmux-repaint throughput a flick can generate over a tunnel; `friction` and
 * `minVelocity` shape the momentum decay; `slopPx` is what preserves tap-to-focus.
 */
const KINETIC = {
  slopPx: 8,
  friction: 0.95,
  minVelocity: 0.02,
  maxTicksPerFrame: 2,
  velocityEma: 0.7,
  altLinesPerTick: 5,
  normalLinesPerTick: 1,
  maxMomentumMs: 1200,
} as const;

/**
 * Scroll mode for the current gesture. `"none"` means the alternate buffer is active but the
 * application never enabled mouse reporting, so a dispatched wheel would be re-encoded by xterm as
 * cursor keys and typed straight into Claude's prompt — engaging there is strictly worse than not
 * scrolling at all.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
function scrollMode(term: Terminal): "alt" | "normal" | "none" {
  if (term.buffer.active.type !== "alternate") return "normal";
  return term.modes.mouseTrackingMode === "none" ? "none" : "alt";
}

function rowHeightPx(term: Terminal): number {
  const el = term.element;
  return el && term.rows > 0 ? el.clientHeight / term.rows : 17;
}

/**
 * Dispatches one discrete wheel tick. `deltaMode: 1` (`DOM_DELTA_LINE`) deliberately bypasses
 * xterm's internal `_wheelPartialScroll` pixel accumulator so each dispatch produces exactly one
 * mouse report (or exactly one viewport row) — the kinetic loop owns the sub-tick accumulation
 * itself, never xterm.
 */
function emitTick(term: Terminal, dir: 1 | -1, x: number, y: number): void {
  term.element?.dispatchEvent(
    new WheelEvent("wheel", {
      deltaY: dir,
      deltaMode: 1,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    }),
  );
}

/**
 * Attaches the coarse-pointer-only kinetic scroller. It never calls `term.scrollLines()` — a
 * verified no-op in the alternate buffer, which is 100% of the real Claude/tmux workload — and
 * instead dispatches synthetic wheel ticks via `emitTick`, gated off entirely by `scrollMode`
 * whenever mouse reporting is disabled.
 * @remarks Listens in the capture phase on `document`, not on `#terminal`/`.xterm-screen`, so
 * `stopPropagation()` can pre-empt xterm's own touch listeners on `term.element` before they
 * double-scroll in the normal-buffer case (the alternate-buffer case is already safe: xterm bails
 * on `areMouseEventsActive`). `{ passive: false }` on `touchmove` is mandatory — iOS silently
 * ignores `preventDefault()` on passive listeners. `touchstart` is never `preventDefault()`ed,
 * which would suppress the synthesized `click`/`mousedown` and kill tap-to-focus; the `slopPx`
 * threshold before engaging is what keeps a plain tap indistinguishable from a drag's first pixel.
 * `smoothScrollDuration` is zeroed for the lifetime of a gesture and its momentum, then restored:
 * on the normal-buffer path a live 120ms animation's `startTime`/target would otherwise be reset by
 * the next tick 16ms later, so the viewport would permanently chase a moving target.
 */
function attachKineticScroll(term: Terminal): void {
  let tracking = false;
  let engaged = false;
  let mode: "alt" | "normal" = "normal";
  let accum = 0;
  let velocity = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastT = 0;
  let momentumFrame: number | undefined;
  let restoreScrollDuration = term.options.smoothScrollDuration;

  const drain = (
    tickMode: "alt" | "normal",
    px: number,
    x: number,
    y: number,
  ): void => {
    accum += px;
    const perTick =
      rowHeightPx(term) *
      (tickMode === "alt"
        ? KINETIC.altLinesPerTick
        : KINETIC.normalLinesPerTick);
    let emitted = 0;
    while (Math.abs(accum) >= perTick && emitted < KINETIC.maxTicksPerFrame) {
      const dir = accum > 0 ? 1 : -1;
      emitTick(term, dir, x, y);
      accum -= dir * perTick;
      emitted += 1;
    }
    if (emitted === KINETIC.maxTicksPerFrame) accum = 0;
  };

  const engageGesture = (): void => {
    if (engaged) return;
    engaged = true;
    restoreScrollDuration = term.options.smoothScrollDuration;
    term.options.smoothScrollDuration = 0;
  };

  const settleGesture = (): void => {
    if (!engaged) return;
    engaged = false;
    term.options.smoothScrollDuration = restoreScrollDuration;
  };

  const cancelMomentum = (): void => {
    if (momentumFrame !== undefined) {
      cancelAnimationFrame(momentumFrame);
      momentumFrame = undefined;
    }
    settleGesture();
  };

  const runMomentum = (startTime: number): void => {
    let lastFrameT = startTime;
    const step = (now: number): void => {
      const frameMode = scrollMode(term);
      if (frameMode === "none" || now - startTime > KINETIC.maxMomentumMs) {
        momentumFrame = undefined;
        settleGesture();
        return;
      }
      const frameMs = now - lastFrameT;
      lastFrameT = now;
      drain(frameMode, velocity * frameMs, lastX, lastY);
      velocity *= KINETIC.friction;
      if (Math.abs(velocity) < KINETIC.minVelocity) {
        momentumFrame = undefined;
        settleGesture();
        return;
      }
      momentumFrame = requestAnimationFrame(step);
    };
    momentumFrame = requestAnimationFrame(step);
  };

  document.addEventListener(
    "touchstart",
    (e) => {
      if ((e.target as Element)?.closest?.(".dsp-zoom-chip")) return;
      cancelMomentum();
      if (e.touches.length !== 1) {
        tracking = false;
        engaged = false;
        accum = 0;
        velocity = 0;
        return;
      }
      if (!(e.target as Element)?.closest?.("#terminal, .xterm")) {
        tracking = false;
        return;
      }
      const sm = scrollMode(term);
      if (sm === "none") {
        tracking = false;
        return;
      }
      mode = sm;
      tracking = true;
      engaged = false;
      accum = 0;
      velocity = 0;
      startY = e.touches[0].clientY;
      lastX = e.touches[0].clientX;
      lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      e.stopPropagation();
    },
    { capture: true, passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (!engaged) {
        if (Math.abs(t.clientY - startY) < KINETIC.slopPx) return;
        engageGesture();
      }
      e.preventDefault();
      e.stopPropagation();
      const dy = lastY - t.clientY;
      const dt = Math.max(1, e.timeStamp - lastT);
      velocity =
        KINETIC.velocityEma * (dy / dt) + (1 - KINETIC.velocityEma) * velocity;
      lastX = t.clientX;
      lastY = t.clientY;
      lastT = e.timeStamp;
      drain(mode, dy, t.clientX, t.clientY);
    },
    { capture: true, passive: false },
  );

  const onTouchEnd = (): void => {
    tracking = false;
    if (engaged && Math.abs(velocity) > KINETIC.minVelocity) {
      runMomentum(performance.now());
    } else {
      settleGesture();
    }
  };

  document.addEventListener("touchend", onTouchEnd, {
    capture: true,
    passive: true,
  });
  document.addEventListener("touchcancel", onTouchEnd, {
    capture: true,
    passive: true,
  });
}

async function main(): Promise<void> {
  const mount = document.getElementById("terminal");
  if (!mount) return;
  const theme = await fetchTheme();
  injectFontFace();
  const { term, fit } = createTerminal(theme);
  await fontsReady();
  mountTerminal(term, mount, fit);
  if (window.matchMedia("(pointer: coarse)").matches) {
    attachKineticScroll(term);
  }
  connect(term);
}

void main();
