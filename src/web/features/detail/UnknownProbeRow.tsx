import { HelpCircle } from "lucide-react";
import type { ProbeFailureCategory } from "../../../shared/types.js";
import { unknownProbeCopy } from "../badges/index.js";

export function UnknownProbeRow({
  signal,
  category,
}: {
  signal: "pr" | "preview";
  category: ProbeFailureCategory;
}) {
  const { label, detail } = unknownProbeCopy(signal, category);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: "var(--space-sm)" }}
    >
      <HelpCircle
        size={14}
        strokeWidth={2}
        aria-hidden="true"
        style={{ flex: "0 0 auto", color: "var(--text-muted)" }}
      />
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          minWidth: 0,
        }}
      >
        <span
          style={{
            fontSize: "var(--font-body)",
            fontWeight: "var(--weight-semibold)",
            lineHeight: "var(--line-body)",
            color: "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontSize: "var(--font-label)",
            fontWeight: "var(--weight-regular)",
            lineHeight: "var(--line-label)",
            color: "var(--text-muted)",
          }}
        >
          {detail}
        </span>
      </div>
    </div>
  );
}
