import type { ProbeFailureCategory } from "../../../shared/types.js";

/**
 * The sole source of "could not check" copy for both the card badge and the detail-panel row, so
 * the two render sites can never drift (SIG-04). `label` is the short visible badge text; `detail`
 * is the longer category-specific sentence shown as a tooltip on the card and as visible text in
 * the detail panel.
 */
export function unknownProbeCopy(
  signal: "pr" | "preview",
  category: ProbeFailureCategory,
): { label: string; detail: string } {
  const label = signal === "pr" ? "PR unknown" : "Preview unknown";
  switch (category) {
    case "gh not authenticated":
      return {
        label,
        detail: "Could not check — not authenticated for this repo",
      };
    case "gh unavailable":
      return { label, detail: "Could not check — gh CLI not available" };
    case "gh pr list failed":
      return { label, detail: "Could not check — gh lookup failed" };
    case "detection unavailable":
      return { label, detail: "Could not check — detection tooling failed" };
    default:
      return { label, detail: "Could not check" };
  }
}
