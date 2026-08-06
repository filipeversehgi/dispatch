import type { CSSProperties } from "react";

/**
 * Returns the single keyboard-focus ring expression every call site spreads in last.
 * @remarks An `overflow: hidden` ancestor can clip an offset outline where a box-shadow
 * ring was not clipped. The locked resolution is to pass `flush` and drop the offset to 0
 * at those sites, never to revert to a box-shadow — a box-shadow ring is structurally
 * identical to the selection ring, which is the defect this definition exists to remove.
 */
export function focusRing(on: boolean, flush?: boolean): CSSProperties {
  return on
    ? { outline: "2px solid var(--accent)", outlineOffset: flush ? 0 : "2px" }
    : { outline: "none", outlineOffset: 0 };
}
