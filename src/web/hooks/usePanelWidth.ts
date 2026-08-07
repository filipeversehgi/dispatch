import { useSyncExternalStore } from "react";

const STORAGE_KEY = "dsp.panel.width";

function loadWidth(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

let width: number | null = loadWidth();
const listeners = new Set<() => void>();

window.addEventListener("storage", (e) => {
  if (e.key === STORAGE_KEY) {
    width = loadWidth();
    for (const cb of listeners) cb();
  }
});

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): number | null {
  return width;
}

export function setPanelWidth(px: number): void {
  width = px;
  try {
    localStorage.setItem(STORAGE_KEY, String(px));
  } catch {}
  for (const cb of listeners) cb();
}

export function clearPanelWidth(): void {
  width = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
  for (const cb of listeners) cb();
}

/**
 * Subscribe to the persisted detail-panel width; re-renders the caller whenever the panel
 * resizes or resets.
 *
 * @remarks
 * The width commits from three paths: `handleResizePointerDown`'s `pointerup` handler for both
 * mouse and touch pointers, the resize handle's arrow-key handler, and `clearPanelWidth` on
 * double-click reset. Touch reaches `pointerup` only because the handle declares
 * `touch-action: none`: without it the browser claims the finger drag as a page pan and fires
 * `pointercancel`, which aborts the drag and restores the pre-drag width instead of committing
 * it. The keyboard path commits through this same store, so a keyboard resize persists
 * identically to a pointer one.
 *
 * @see docs/ARCHITECTURE.md#panel-iframe-identity
 */
export function usePanelWidth(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
