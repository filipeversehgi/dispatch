import { Router } from "express";
import { resolveTerminalTheme } from "../services/infra/terminal-theme.js";

/**
 * Native terminal theme/font surface behind the shared `/api` loopback guard. Unconditional (not
 * flag-gated on `DISPATCH_NATIVE_TERMINAL`) — ttyd's own served client never calls this, so it is
 * inert when the flag is off.
 */
export const terminalThemeRouter = Router();

terminalThemeRouter.get("/terminal-theme", async (_req, res) => {
  res.status(200).json(await resolveTerminalTheme());
});
