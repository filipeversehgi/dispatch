import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import { parsePort } from "../adapters/ttyd.js";
import { DISPATCH_DIR, TTYD_INDEX_PATH } from "../services/infra/paths.js";
import {
  FONT_FAMILY,
  FONT_SPEC,
  NERD_FONT_WOFF2_BASE64,
} from "../../shared/nerd-font-mono.js";

/**
 * Reverse-tabnabbing-safe modifier-gated link activator, shared verbatim by both cmd-click
 * patches (`cmd-click-weblinks` and `cmd-click-osc8`): open a blank tab, null its opener, THEN
 * navigate — never `window.open(url,"_blank")`, which does not reliably null the opener across
 * browsers. Its `(e,t)` signature matches both WebLinksAddon's click handler shape and xterm's
 * `linkHandler.activate(event, uri)` shape, which is why both patches can reuse it unmodified.
 * The else-branch warn preserves the popup-blocked diagnostic both stock xterm code paths emit
 * when `window.open()` returns null — without it a blocked cmd+click does nothing silently,
 * indistinguishable from an unapplied patch when debugging.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
const PATCH_HANDLER =
  "(e,t)=>{if(e.metaKey||e.ctrlKey){const w=window.open();" +
  "if(w){try{w.opener=null}catch(_){}w.location.href=t}" +
  'else console.warn("dispatch: cmd+click open blocked")}}';

/** Existing WebLinksAddon plain-text-link patch anchor (52-RESEARCH.md). */
const PATCH_TARGET = "new l.WebLinksAddon";

/**
 * Bridges single-finger touch drag to synthetic wheel scroll for tmux's alternate buffer, because
 * xterm.js 5.x cancels its own touch handlers whenever tmux owns the mouse
 * (`coreMouseService.areMouseEventsActive`) and upstream has declined to fix this for mobile
 * (xterm.js #1007 closed not-planned, #5377 deprioritizes mobile) — the wheel path (already
 * forwarded to tmux as an SGR mouse report) is the only working scroll input left, so this
 * dispatches synthetic WheelEvents from raw touch deltas. Reads `window.term` lazily at each
 * touchstart rather than at script-load time, so patch-vs-ttyd load order never matters. Engages
 * only once `window.term.buffer.active.type==="alternate"` (tmux's scrollback view) — on the
 * normal buffer xterm's native touch scroll already works, and engaging here too would
 * double-scroll. `touchmove` is registered `{passive:false}` because iOS silently no-ops
 * `preventDefault()` on passive listeners; without it the page scrolls underneath the synthetic
 * wheel dispatch. An 8px slop before engaging keeps a plain tap free to focus/type instead of
 * being swallowed as a drag. A second concurrent touch (pinch-zoom) always resets tracking so
 * two-finger gestures pass through untouched, and no momentum/inertia is applied (deliberate v1
 * scope).
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
const TOUCH_SCROLL_SCRIPT =
  "(()=>{let tracking=false,engaged=false,startY=0,lastY=0;" +
  'document.addEventListener("touchstart",(e)=>{' +
  "if(e.touches.length!==1){tracking=false;engaged=false;return}" +
  "const tgt=e.target;" +
  'if(!tgt||typeof tgt.closest!=="function"||!tgt.closest("#terminal,.xterm")){tracking=false;engaged=false;return}' +
  "const term=window.term;" +
  'if(!term||!term.buffer||!term.buffer.active||term.buffer.active.type!=="alternate"){tracking=false;engaged=false;return}' +
  "tracking=true;engaged=false;startY=lastY=e.touches[0].clientY" +
  "},true);" +
  'document.addEventListener("touchmove",(e)=>{' +
  "if(!tracking||e.touches.length!==1)return;" +
  "const t=e.touches[0];" +
  "if(!engaged){if(Math.abs(t.clientY-startY)<8)return;engaged=true}" +
  "e.preventDefault();" +
  "const deltaY=lastY-t.clientY;lastY=t.clientY;" +
  'if(deltaY!==0)e.target.dispatchEvent(new WheelEvent("wheel",{deltaY,deltaMode:0,bubbles:true,cancelable:true,clientX:t.clientX,clientY:t.clientY}))' +
  "},{passive:false,capture:true});" +
  'document.addEventListener("touchend",()=>{tracking=false;engaged=false},true);' +
  'document.addEventListener("touchcancel",()=>{tracking=false;engaged=false},true)' +
  "})()";

/**
 * One named, independently-degrading patch to ttyd's served index: `target` is an exact-count-1
 * literal anchor in the captured stock bundle, `build` returns the full replacement string, and
 * `disabledWarning` names the feature lost when the anchor drifts.
 */
interface NamedPatch {
  name: string;
  target: string;
  build: () => string;
  disabledWarning: string;
}

/**
 * Seven independent patches applied to ttyd's served index, in order. Each anchor is checked for
 * an exact-count-1 occurrence before being applied; a drifted anchor skips ONLY that patch, never
 * the others, and is never force-applied via regex or fuzzy matching (59-RESEARCH.md Anchors 1-3).
 * @remarks `cmd-click-osc8` sets `terminal.options.linkHandler` because real Claude Code `⏺`
 * output uses OSC-8 hyperlinks — a different, earlier-registered xterm.js code path than
 * `WebLinksAddon`, which never fires for that output (59-RESEARCH.md Pitfall 1). `shift-enter`
 * sends raw LF via the Dispatcher's own bound `sendData`, never `term.paste` (which silently
 * converts `\n` back into `\r` via xterm's `prepareTextForTerminal` — 59-RESEARCH.md Pitfall 2).
 * Its guards are load-bearing: `e.isComposing` (runs BEFORE xterm's own composition check — IME
 * safety, Pitfall 4) and `e.type==="keyup"` always pass through untouched. On a matching
 * Shift+Enter the handler swallows BOTH the `keydown` AND the following `keypress` for the SAME
 * keystroke (calling `sendData` only once, on `keydown`) — `_keyPress` only short-circuits on
 * `_keyDownHandled`, which xterm sets internally ONLY when its own (not our) keydown handling ran
 * to completion, so an early customKeyEventHandler-return during keydown never sets it; without
 * also swallowing keypress, xterm's stock keypress path independently `triggerDataEvent`s the
 * Enter key's own CR right after our injected LF, submitting the message instead of inserting a
 * newline (live-discovered defect, fixed same-plan, 59-02-SUMMARY.md).
 * @remarks `font-load-gate` MUST stay the FIRST entry and `font-face-inject` the LAST: the
 * gate's target (`t.loadAddon(new l.WebLinksAddon),t.open(e),i.fit()}`) is a SUPERSET of both
 * `cmd-click-weblinks`'s anchor (`new l.WebLinksAddon`) and `shift-enter`'s anchor
 * (`t.open(e),i.fit()}`) — superset-anchor coupling. Anchor counts run against the
 * ALREADY-MUTATED string in array order (see `patchIndexHtml`'s own remark below), so if either
 * of those two patches ran BEFORE font-load-gate it would consume/alter the shared substring and
 * silently break font-load-gate's own count-1 match (or vice versa if font-load-gate ran last),
 * disabling a feature with no anchor-drift warning to distinguish it from real ttyd version
 * drift. font-load-gate's `build()` deliberately re-emits both downstream anchors VERBATIM inside
 * its `.then()` callback — the sanctioned exception to "no patch's build() output may contain
 * another patch's anchor substring" noted below, required here so cmd-click-weblinks and
 * shift-enter still find their (now one level deeper) anchors at exact-count-1 on their turn.
 * `font-face-inject` targets the served index's single `</style>` closing tag and has no anchor
 * overlap with any other patch, so its position past the other four is unconstrained beyond
 * "last" (TERM-01, 67-RESEARCH.md Pattern 1/2).
 * @remarks `mobile-viewport` and `touch-scroll` sit between `shift-enter` and `font-face-inject`,
 * with `mobile-viewport` strictly first: `mobile-viewport` targets the single `<meta
 * charset="UTF-8">` tag and self-re-emits it verbatim (same pattern as `font-load-gate`'s
 * downstream anchors) followed by the new viewport meta, so it never disturbs any anchor another
 * patch depends on. `touch-scroll` targets the served index's single `</head>` closing tag
 * (verified count-1 against the live stock capture; no earlier patch emits or consumes it) and
 * self-re-emits it verbatim after injecting `TOUCH_SCROLL_SCRIPT` in a `<script>` element. Neither
 * new build's output contains any other patch's anchor substring.
 * @remarks `font-load-gate`'s built expression guards `document.fonts&&document.fonts.load`
 * BEFORE constructing the `Promise.race`, falling back to `Promise.resolve()` when the CSS Font
 * Loading API is absent entirely — a bare `document.fonts.load(...)` reference would throw
 * synchronously in that case (before any promise exists, so the `.catch(()=>{})` on the load
 * promise itself cannot help), which would propagate out of `open(e)` and leave the terminal
 * never opening: strictly worse than stock ttyd. With the guard, an absent API immediately
 * resolves and calls `t.open(e),i.fit()` — matching stock behavior exactly, so "degrades to
 * today's behavior, never worse" (67-RESEARCH.md, 67-01-PLAN.md) holds for every browser, not
 * only ones where the API exists but its promise rejects.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
const PATCHES: NamedPatch[] = [
  {
    name: "font-load-gate",
    target: "t.loadAddon(new l.WebLinksAddon),t.open(e),i.fit()}",
    build: () =>
      "t.loadAddon(new l.WebLinksAddon)," +
      `(document.fonts&&document.fonts.load?Promise.race([document.fonts.load('${FONT_SPEC}').catch(()=>{}),` +
      `new Promise(r=>setTimeout(r,1500))]):Promise.resolve()).then(()=>{t.open(e),i.fit()})}`,
    disabledWarning:
      "Nerd Font glyph load-gate disabled (glyphs may render with wrong metrics)",
  },
  {
    name: "cmd-click-weblinks",
    target: PATCH_TARGET,
    build: () => `new l.WebLinksAddon(${PATCH_HANDLER})`,
    disabledWarning: "cmd+click links (plain-text fallback) disabled",
  },
  {
    name: "cmd-click-osc8",
    target: "this.terminal=new n.Terminal(this.options.termOptions);",
    build: () =>
      "this.terminal=new n.Terminal(this.options.termOptions);" +
      `this.terminal.options.linkHandler={activate:${PATCH_HANDLER}};`,
    disabledWarning: "cmd+click links (real Claude Code OSC-8 output) disabled",
  },
  {
    name: "shift-enter",
    target: "t.open(e),i.fit()}",
    build: () =>
      "t.open(e),t.attachCustomKeyEventHandler((e=>{" +
      'if(e.isComposing||e.type==="keyup")return!0;' +
      'if(e.key==="Enter"&&e.shiftKey&&!e.ctrlKey&&!e.altKey&&!e.metaKey){' +
      'if(e.type==="keydown")this.sendData("\\n");return!1}return!0})),i.fit()}',
    disabledWarning: "shift+enter newline disabled",
  },
  {
    name: "mobile-viewport",
    target: '<meta charset="UTF-8">',
    build: () =>
      '<meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    disabledWarning:
      "mobile viewport meta disabled (remote pages render desktop-scaled on phones)",
  },
  {
    name: "touch-scroll",
    target: "</head>",
    build: () => `<script>${TOUCH_SCROLL_SCRIPT}</script></head>`,
    disabledWarning:
      "mobile touch-scroll disabled (finger drag cannot scroll terminal history)",
  },
  {
    name: "font-face-inject",
    target: "</style>",
    build: () =>
      "html,body{-webkit-text-size-adjust:100%;text-size-adjust:100%}" +
      `@font-face{font-family:"${FONT_FAMILY}";` +
      `src:url(data:font/woff2;charset=utf-8;base64,${NERD_FONT_WOFF2_BASE64}) format("woff2");` +
      `font-weight:400;font-style:normal;font-display:block}</style>`,
    disabledWarning:
      "Nerd Font CSS injection disabled (falls back to whatever font-family is set)",
  },
];

/**
 * Apply every patch in PATCHES independently against `html`. A target whose occurrence count
 * isn't exactly 1 (ttyd version drift) skips ONLY that patch and the loop continues — the same
 * "named independent checks, never short-circuit" contract `preflight.ts`'s
 * `REQUIRED_BINARIES`/`probePreflight` already follows for prerequisite checks. Every replacement
 * is a function callback so `$`-patterns in a future patch string are never string-interpolated
 * into the artifact.
 * @remarks Anchor counts run against the ALREADY-MUTATED string in PATCHES order, not the
 * pristine capture — so no patch's `build()` output may contain another patch's anchor substring
 * (holds for all seven, verified against the live bundle), or the later patch's count silently
 * drifts to 0/2 and the boot log misreports it as ttyd version drift.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
export function patchIndexHtml(html: string): {
  html: string;
  applied: string[];
  skipped: string[];
} {
  let out = html;
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const patch of PATCHES) {
    const count = out.split(patch.target).length - 1;
    if (count !== 1) {
      skipped.push(patch.name);
      continue;
    }
    out = out.replace(patch.target, () => patch.build());
    applied.push(patch.name);
  }
  return { html: out, applied, skipped };
}

/**
 * Spawn a throwaway ttyd bound to a bogus tmux target, fetch its served index, and kill it. No
 * real tmux session is needed — ttyd serves `/` regardless of whether the WS-attach target exists
 * (52-RESEARCH.md, live-verified). Not detached, so the capture process is always reaped here.
 */
async function captureStockIndex(): Promise<string> {
  const child = spawn(
    "ttyd",
    [
      "-i",
      "127.0.0.1",
      "-p",
      "0",
      "tmux",
      "attach",
      "-t",
      "dispatch-ttyd-index-capture",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    const port = await parsePort(child);
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`index fetch returned ${res.status}`);
    return await res.text();
  } finally {
    try {
      child.kill();
    } catch {}
  }
}

/**
 * Unlink a stale prior-boot artifact, tolerating ENOENT. A failed provisioning must never leave a
 * previous boot's patched index sitting around to be served against a drifted ttyd binary, so
 * file-existence at spawn time stays a trustworthy signal for spawnTtyd's conditional `-I`. Any
 * other unlink error (EACCES/EPERM on ~/.dispatch) warns instead of throwing: the module's
 * never-throws contract wins, and a loud warning is the only remedy left when the
 * artifact-matches-this-boot invariant cannot be enforced.
 */
async function removeStaleArtifact(): Promise<void> {
  try {
    await fsp.unlink(TTYD_INDEX_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    console.warn(
      `[ttyd-index] stale artifact removal failed — a prior boot's patched index may still be served: ${(err as Error).message}`,
    );
  }
}

/**
 * Capture ttyd's stock served index, apply every patch in PATCHES independently, and write the
 * (possibly partial) result atomically to TTYD_INDEX_PATH whenever at least one patch applied —
 * partial capability beats none (CONTEXT.md). Never throws — mirrors installHookArtifacts's
 * self-healing-every-boot shape: a future `brew upgrade ttyd` re-captures automatically, and any
 * failure (capture error, every patch drifted, or artifact write) degrades to stock ttyd behavior
 * (spawnTtyd omits `-I` when the file is absent) with a boot warning naming each disabled feature,
 * never a startup crash. A failed WRITE also unlinks the prior boot's artifact, preserving the
 * invariant that an existing artifact always matches the ttyd binary this boot captured; the outer
 * catch is the contract's final safety net (mkdir failure, or anything unexpected disabling every
 * patch).
 * @remarks Started fire-and-forget in bootstrap and deliberately NOT awaited: the cold
 * first-ttyd-spawn-per-boot measured ~5s (Pitfall 5), and awaiting it would put that spawn on the
 * serial boot path ahead of listen — the instant-startup constraint forbids that. It must be
 * kicked off strictly AFTER reconcileSessions: the boot orphan sweep's fingerprint
 * (`ttyd … tmux attach`) matches the throwaway capture child, so an overlapping sweep would
 * SIGTERM the capture mid-flight and silently disable every patch for the whole boot. Safe to
 * overlap listen because spawnTtyd re-checks artifact existence per spawn — a terminal opened
 * inside the capture window gets the prior boot's artifact or stock behavior for that one spawn.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
export async function provisionTtydIndex(): Promise<void> {
  try {
    await fsp.mkdir(DISPATCH_DIR, { recursive: true, mode: 0o700 });
    let html: string;
    try {
      html = await captureStockIndex();
    } catch (err) {
      console.warn(
        `[ttyd-index] capture failed — all served-index patches disabled (cmd+click links, shift+enter, Nerd Font, mobile viewport/touch-scroll): ${(err as Error).message}`,
      );
      await removeStaleArtifact();
      return;
    }
    const { html: patched, applied, skipped } = patchIndexHtml(html);
    for (const name of skipped) {
      const patch = PATCHES.find((p) => p.name === name);
      if (patch) {
        console.warn(
          `[ttyd-index] ${patch.disabledWarning} — anchor not found exactly once (ttyd version drift suspected)`,
        );
      }
    }
    if (applied.length === 0) {
      await removeStaleArtifact();
      return;
    }
    try {
      await writeFileAtomic(TTYD_INDEX_PATH, patched, { mode: 0o644 });
    } catch (err) {
      console.warn(
        `[ttyd-index] artifact write failed — all served-index patches disabled (cmd+click links, shift+enter, Nerd Font, mobile viewport/touch-scroll): ${(err as Error).message}`,
      );
      await removeStaleArtifact();
    }
  } catch (err) {
    console.warn(
      `[ttyd-index] provisioning failed — all served-index patches disabled (cmd+click links, shift+enter, Nerd Font, mobile viewport/touch-scroll): ${(err as Error).message}`,
    );
  }
}
