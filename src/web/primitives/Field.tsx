import { type CSSProperties, type ReactNode } from "react";

interface FieldProps {
  children: ReactNode;
  mono?: boolean;
  section?: boolean;
  style?: CSSProperties;
}

const labelStyle: CSSProperties = {
  fontSize: "var(--font-label)",
  fontWeight: "var(--weight-semibold)",
  lineHeight: "var(--line-label)",
  color: "var(--text-muted)",
};

const monoLabelStyle: CSSProperties = {
  ...labelStyle,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-micro)",
};

const sectionLabelStyle: CSSProperties = {
  ...labelStyle,
  fontWeight: "var(--weight-medium)",
};

export function Field({ children, mono, section, style }: FieldProps) {
  const base = mono ? monoLabelStyle : section ? sectionLabelStyle : labelStyle;
  return <span style={{ ...base, ...style }}>{children}</span>;
}
