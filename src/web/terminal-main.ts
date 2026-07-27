import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

const OUTPUT = 0x30;
const TITLE = 0x31;

const RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_ATTEMPTS = 5;

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
 * Builds the terminal instance and the reverse-tabnabbing-safe link handlers, wired to BOTH
 * `WebLinksAddon` (plain-text URLs) and `linkHandler` (OSC-8, the code path real Claude Code `⏺`
 * output uses and `WebLinksAddon` never fires for) so cmd-click parity holds for either link
 * source.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
function createTerminal(): { term: Terminal; fit: FitAddon } {
  const term = new Terminal({ cursorBlink: false, allowProposedApi: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon(activateLink));
  term.options.linkHandler = { activate: activateLink };
  return { term, fit };
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
 * a bounded reconnect on an unclean close) so `main()` stays a single call. `term.onData`/
 * `term.onResize` are registered exactly ONCE against the `socket` closure variable rather than
 * inside `ws.onopen` — re-registering them per reconnect would stack a new listener on every
 * attempt, each still holding its own now-closed WebSocket, so a later reconnect would throw on
 * every keystroke from the stale listeners. The bounded reconnect covers only transient drops
 * (e.g. a backend restart re-adopting ttyd) — the board's own `terminalError`/`ttydPort` contract
 * stays server-driven via `recordTtydExit` on a real ttyd exit, so this client never sets a
 * terminal-error state itself.
 */
function connect(term: Terminal, mount: HTMLElement, fit: FitAddon): void {
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

    ws.onopen = () => {
      attempts = 0;
      sendHandshake(ws, term);
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
      if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
      attempts += 1;
      setTimeout(open, RECONNECT_DELAY_MS * attempts);
    };
  };

  open();
  attachShiftEnterHandler(term, () => socket);

  term.open(mount);
  fit.fit();
  new ResizeObserver(() => fit.fit()).observe(mount);
}

function main(): void {
  const mount = document.getElementById("terminal");
  if (!mount) return;
  const { term, fit } = createTerminal();
  connect(term, mount, fit);
}

main();
