import { Router } from "express";
import { resolveTerminalTheme } from "../services/infra/terminal-theme.js";

/**
 * Native terminal theme/font surface behind the shared `/api` loopback guard. The native client is
 * the only terminal, so this is the sole theme/font source — there is no ttyd-served alternative
 * client left to leave it inert for.
 */
export const terminalThemeRouter = Router();

terminalThemeRouter.get("/terminal-theme", async (_req, res) => {
  res.status(200).json(await resolveTerminalTheme());
});
