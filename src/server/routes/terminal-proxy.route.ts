import { Router } from "express";
import {
  httpForward,
  resolveLiveTtydPort,
} from "../adapters/terminal-proxy.js";
import { WEB_DIST_DIR } from "../services/infra/paths.js";

/**
 * Card.id-keyed terminal reverse-proxy, mounted as a sibling top-level path (never nested under
 * `/api` — a byte-stream forward has no business behind the JSON-oriented `apiRouter` gate). No
 * auth gating this phase (nothing beyond loopback can reach it yet); this router is the single
 * named, wrappable route mount Phase 73's gate wraps (T-72-05). The named wildcard (`*rest`) is
 * required — a bare `*` throws at boot under `express@5.2.1`/path-to-regexp v8 (live-verified,
 * 72-RESEARCH.md) — and it MUST sit inside an optional group (`{/*rest}`): under path-to-regexp v8
 * a bare `/*rest` must consume at least one character, so the iframe's actual first request
 * (`/sessions/<id>/terminal/`, empty rest) and the no-trailing-slash form both miss the route and
 * fall through to the production SPA fallback, silently serving Dispatch's own index.html with a
 * 200 instead of ttyd's page. The no-trailing-slash form is forwarded verbatim rather than
 * redirected here, because ttyd under `-b` already answers it with its own 302 to the
 * trailing-slash index (live-verified against ttyd 1.7.7).
 * @remarks With `DISPATCH_NATIVE_TERMINAL` set, a GET on this path serves dispatch's OWN built
 * terminal bundle instead of proxying to ttyd — the live-port resolution and 404-on-unknown-card
 * behavior run FIRST and unchanged, so the bundle is never served for a card with no live session
 * (T-S1-02). `res.sendFile(relPath, { root: WEB_DIST_DIR })` uses the `{ root }` form rather than a
 * pre-joined absolute path so send's dotfile/`..` traversal policy is confined to the relative
 * segment (T-S1-01, the established `spaFallback` pattern). The flag is read fresh from
 * `process.env` on every request, never cached. Flag OFF, or any non-GET (the WS upgrade never
 * reaches this router — it is a Node-level `server.on("upgrade")` handler), falls through to the
 * unchanged `httpForward` proxy.
 * @see docs/ARCHITECTURE.md#terminal-ttyd
 */
export const terminalProxyRouter = Router();

terminalProxyRouter.all("/:id/terminal{/*rest}", (req, res) => {
  const port = resolveLiveTtydPort(req.params.id);
  if (port == null) {
    res.status(404).end();
    return;
  }
  if (process.env.DISPATCH_NATIVE_TERMINAL && req.method === "GET") {
    const rest = req.params.rest as string | string[] | undefined;
    const relPath = Array.isArray(rest) ? rest.join("/") : (rest ?? "");
    res.set("Cache-Control", "no-cache");
    res.sendFile(relPath === "" ? "terminal.html" : relPath, {
      root: WEB_DIST_DIR,
    });
    return;
  }
  httpForward(req, res, port);
});
