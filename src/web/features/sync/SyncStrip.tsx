import { useEffect, useState } from "react";
import {
  Activity,
  Inbox,
  Kanban,
  PanelLeft,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { ConnectionStatus } from "../../hooks/useBoardStream.js";
import { Glyph } from "../../primitives/Glyph.js";
import { IconButton } from "../../primitives/IconButton.js";

type ViewMode = "board" | "workspace";

interface SyncStripProps {
  syncedAt: string | null;
  connection: ConnectionStatus;
  pollIntervalMs: number | null;
  syncWarning: string | null;
  syncUnreachable?: boolean;
  onOpenSettings?: () => void;
  onOpenActivity?: () => void;
  activityUnseen?: boolean;
  activityOpen?: boolean;
  onOpenInbox?: () => void;
  inboxCount?: number;
  inboxOpen?: boolean;
  onOpenCreateTicket?: () => void;
  viewMode?: ViewMode;
  onSelectViewMode?: (mode: ViewMode) => void;
}

const focusRing = (on: boolean): string =>
  on ? "0 0 0 2px var(--accent)" : "none";

const VIEW_MODES: { id: ViewMode; label: string; icon: LucideIcon }[] = [
  { id: "board", label: "Board", icon: Kanban },
  { id: "workspace", label: "Workspace", icon: PanelLeft },
];

interface ViewModeSegmentProps {
  icon: LucideIcon;
  label: string;
  active: boolean;
  onClick: () => void;
}

function ViewModeSegment({
  icon: Icon,
  label,
  active,
  onClick,
}: ViewModeSegmentProps) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(e) => setFocus(e.currentTarget.matches(":focus-visible"))}
      onBlur={() => setFocus(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-xs)",
        height: "26px",
        padding: "0 var(--space-sm)",
        border: "none",
        borderRadius: "calc(var(--radius) - 2px)",
        background:
          active || hover ? "var(--surface-card-hover)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-muted)",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--font-label)",
        fontWeight: "var(--weight-semibold)",
        lineHeight: "var(--line-label)",
        cursor: "pointer",
        outline: "none",
        boxShadow: focusRing(focus),
      }}
    >
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

interface ViewModeSwitchProps {
  viewMode?: ViewMode;
  onSelect?: (mode: ViewMode) => void;
}

function ViewModeSwitch({ viewMode, onSelect }: ViewModeSwitchProps) {
  return (
    <div
      role="tablist"
      aria-label="View"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "2px",
        padding: "2px",
        background: "var(--surface-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      {VIEW_MODES.map((mode) => (
        <ViewModeSegment
          key={mode.id}
          icon={mode.icon}
          label={mode.label}
          active={viewMode === mode.id}
          onClick={() => onSelect?.(mode.id)}
        />
      ))}
    </div>
  );
}

function formatSynced(syncedTs: number, now: number): string {
  const elapsedMs = now - syncedTs;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (seconds < 5) return "Synced just now";
  if (seconds < 60) return `Synced ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `Synced ${minutes}m ago`;
}

export function SyncStrip({
  syncedAt,
  connection,
  pollIntervalMs,
  syncWarning,
  syncUnreachable,
  onOpenSettings,
  onOpenActivity,
  activityUnseen,
  activityOpen,
  onOpenInbox,
  inboxCount,
  inboxOpen,
  onOpenCreateTicket,
  viewMode,
  onSelectViewMode,
}: SyncStripProps) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const disconnected = connection === "disconnected";
  const syncedTs = syncedAt !== null ? new Date(syncedAt).getTime() : NaN;
  const syncedTsValid = Number.isFinite(syncedTs);
  const stale =
    !disconnected &&
    syncedAt !== null &&
    syncedTsValid &&
    pollIntervalMs != null &&
    now - syncedTs > 2 * pollIntervalMs;

  let text: string;
  if (disconnected) {
    text = "Disconnected — reconnecting…";
  } else if (syncedAt === null) {
    text = "Syncing…";
  } else if (syncUnreachable) {
    text = syncedTsValid
      ? `Reconnecting… (last synced ${formatSynced(syncedTs, now)})`
      : "Reconnecting…";
  } else if (!syncedTsValid) {
    text = "Synced";
  } else if (stale) {
    text = `Linear sync stale since ${new Date(syncedAt).toLocaleTimeString(
      [],
      {
        hour: "numeric",
        minute: "2-digit",
      },
    )}`;
  } else if (syncWarning) {
    text = syncWarning;
  } else {
    text = formatSynced(syncedTs, now);
  }

  const dotColor = disconnected
    ? "var(--status-down)"
    : syncUnreachable && syncedTsValid
      ? "var(--accent)"
      : stale
        ? "var(--status-stale)"
        : "var(--status-ok)";
  const dotTitle = disconnected
    ? "Disconnected — reconnecting…"
    : syncUnreachable && syncedTsValid
      ? "Reconnecting…"
      : stale
        ? "Sync stale"
        : "Connected";

  return (
    <div
      style={{
        height: "var(--strip-height)",
        flex: "0 0 var(--strip-height)",
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        alignItems: "center",
        padding: "0 var(--space-lg)",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface-column)",
        fontSize: "var(--font-label)",
        fontWeight: "var(--weight-semibold)",
        lineHeight: "var(--line-label)",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-xs)",
          color: "var(--text)",
        }}
      >
        <Glyph size={16} />
        <span
          style={{
            fontWeight: 800,
            fontSize: "12px",
            letterSpacing: "0.18em",
          }}
        >
          DISPATCH
        </span>
      </div>

      <ViewModeSwitch viewMode={viewMode} onSelect={onSelectViewMode} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifySelf: "end",
          gap: "var(--space-sm)",
        }}
      >
        <div
          role="status"
          aria-live="polite"
          style={{
            display: "flex",
            alignItems: "center",
            color: disconnected ? "var(--destructive)" : "var(--text-muted)",
          }}
        >
          <span
            title={dotTitle}
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: dotColor,
              marginRight: "var(--space-xs)",
              flex: "0 0 auto",
            }}
          />
          {text}
        </div>
        <IconButton
          aria-label="New ticket"
          title="New ticket"
          onClick={onOpenCreateTicket}
        >
          <Plus size={16} strokeWidth={2} aria-hidden="true" />
        </IconButton>
        {viewMode === "board" && (
          <div style={{ position: "relative", display: "flex" }}>
            <IconButton
              id="inbox-toggle"
              aria-label={
                inboxOpen
                  ? "Close inbox, return to board"
                  : inboxCount != null && inboxCount > 0
                    ? `Open inbox, ${inboxCount} ticket${inboxCount === 1 ? "" : "s"}`
                    : "Open inbox"
              }
              title={
                inboxCount != null && inboxCount > 0
                  ? `Inbox — ${inboxCount} ticket${inboxCount === 1 ? "" : "s"}`
                  : "Inbox"
              }
              aria-expanded={inboxOpen}
              aria-controls="inbox-view"
              onClick={onOpenInbox}
              style={{
                color: inboxOpen ? "var(--accent)" : "var(--text-muted)",
                ...(inboxOpen
                  ? { background: "var(--surface-card-hover)" }
                  : {}),
              }}
            >
              <Inbox size={16} />
            </IconButton>
            {inboxCount != null && inboxCount > 0 && (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  top: "2px",
                  right: "2px",
                  background:
                    "color-mix(in srgb, var(--accent) 16%, var(--surface-column))",
                  color: "var(--accent)",
                  borderRadius: "var(--radius)",
                  padding: "0 var(--space-xs)",
                  fontSize: "var(--font-label)",
                  fontWeight: "var(--weight-semibold)",
                  lineHeight: "var(--line-label)",
                  pointerEvents: "none",
                }}
              >
                {inboxCount}
              </span>
            )}
          </div>
        )}
        <div style={{ position: "relative", display: "flex" }}>
          <IconButton
            id="activity-toggle"
            aria-label="Activity feed"
            title={activityUnseen ? "Activity — unseen" : "Activity"}
            aria-expanded={activityOpen}
            aria-controls="activity-drawer"
            onClick={onOpenActivity}
          >
            <Activity size={16} />
          </IconButton>
          {activityUnseen && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                top: "2px",
                right: "2px",
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "var(--status-ok)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
        <IconButton
          aria-label="Sync filters"
          title="Settings"
          onClick={onOpenSettings}
        >
          <Settings size={16} />
        </IconButton>
      </div>
    </div>
  );
}
