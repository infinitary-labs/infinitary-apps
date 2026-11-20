import type { WindowControl, WindowState } from "@shared/channels/shell";
import * as m from "@shared/i18n/messages.generated";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AmbientSoundControl } from "../ambient/AmbientSoundControl";
import { IconButton } from "../design";
import { thisDesktop, WINDOW_CONTROLS, WINDOW_CONTROLS_CLEARANCE } from "../design/core/desktop";
import { fixedKeys } from "../design/core/fixedKeys";
import { RemoteControlLine } from "../devices/RemoteControl";
import { useCommandKeys } from "./keyHints";
import { type BarRoom, ProjectFocusControl } from "./ProjectFocusControl";
import { ReducedMotionIndicator } from "./ReducedMotionIndicator";
import type { ShellView } from "./store";
import { UpdateIndicator } from "./UpdateIndicator";
import { WorkSetupLine } from "./WorkSetupNotice";

const icoS = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const Ico = {
  gear: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  back: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <path d="m15 18-6-6 6-6" />
    </svg>
  ),
  // The window's own buttons where the app draws them: Lucide minus,
  // square, copy and x.
  minimize: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  ),
  maximize: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </svg>
  ),
  restore: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  ),
  close: (
    <svg width="16" height="16" viewBox="0 0 24 24" {...icoS} aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  ),
};

export type TopBarProps = {
  view: ShellView;
  onSettings: () => void;
  onBack: () => void;
  /** Ref target for initial focus when settings opens. */
  backButtonRef?: React.Ref<HTMLButtonElement>;
};

/** The bar's height, px: a maximized card keeps clear of it (`stage/CardLayer.tsx`). */
export const TOP_BAR_HEIGHT = 52;

/**
 * The window's own buttons where the app draws them (design skill readme,
 * "Linux desktop conventions"): Minimize, Maximize or Restore and Close
 * window at the top bar's right, over everything the window shows, as a
 * Mac's own buttons are at its left.
 */
function WindowControls() {
  const [state, setState] = useState<WindowState>({ maximized: false });
  useEffect(() => {
    let live = true;
    void window.infinitary.app
      .windowState()
      .then((read) => {
        if (live) setState(read);
      })
      .catch(() => {});
    const stop = window.infinitary.app.onWindowState(setState);
    return () => {
      live = false;
      stop();
    };
  }, []);
  const control = (which: WindowControl) => {
    void window.infinitary.app
      .controlWindow(which)
      .then(setState)
      .catch(() => {});
  };
  return (
    <div
      data-window-controls=""
      style={
        {
          position: "fixed",
          top: 0,
          right: WINDOW_CONTROLS.inset,
          width: WINDOW_CONTROLS.width,
          height: TOP_BAR_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          // Over the picture viewer and command search, as a Mac's buttons are.
          zIndex: 50,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      <IconButton label={m.shellTopBarMinimize()} onClick={() => control("minimize")}>
        {Ico.minimize}
      </IconButton>
      <IconButton
        label={state.maximized ? m.shellTopBarRestore() : m.shellTopBarMaximize()}
        onClick={() => control("maximize")}
      >
        {state.maximized ? Ico.restore : Ico.maximize}
      </IconButton>
      <IconButton
        label={m.shellTopBarCloseWindow()}
        // Ctrl+W closes the window where the app draws its own buttons (main/keyboard.ts).
        keys="Ctrl+W"
        aria-keyshortcuts="Control+W"
        onClick={() => control("close")}
      >
        {Ico.close}
      </IconButton>
    </div>
  );
}

export function TopBar({ view, onSettings, onBack, backButtonRef }: TopBarProps) {
  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;
  const settingsKeys = useCommandKeys("settings.open");
  // A Mac's own buttons sit inset at the left; where the app draws them,
  // they take the right (design skill readme, "Linux desktop conventions").
  const appControls = thisDesktop().windowControls === "app";
  const barRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // The room the project row may open into: between what the bar holds at
  // its left and its buttons at its right, in the bar's own coordinates.
  const room = useCallback((): BarRoom | null => {
    const bar = barRef.current?.getBoundingClientRect();
    const start = startRef.current?.getBoundingClientRect();
    const end = endRef.current?.getBoundingClientRect();
    if (!bar || !start || !end) return null;
    return { left: start.right - bar.left, right: end.left - bar.left };
  }, []);
  return (
    <div
      ref={barRef}
      data-topbar=""
      style={
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: TOP_BAR_HEIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          // Leave room for the macOS traffic lights under hiddenInset, or for
          // the window's own buttons where the app draws them.
          padding: appControls ? `0 ${WINDOW_CONTROLS_CLEARANCE}px 0 16px` : "0 16px 0 80px",
          WebkitAppRegion: "drag",
        } as React.CSSProperties
      }
    >
      <div ref={startRef} style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {view === "settings" && (
          <IconButton
            label={m.shellTopBarBack()}
            {...fixedKeys("Escape")}
            onClick={onBack}
            ref={backButtonRef}
            style={noDrag}
          >
            {Ico.back}
          </IconButton>
        )}
        {view === "settings" && (
          <span style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}>
            {m.shellTopBarSettings()}
          </span>
        )}
        {/* Which Mac this app controls, when it controls another (docs/view.md). */}
        {view !== "settings" && <RemoteControlLine />}
        {/* The work notice put away with Not now, which reopens it (WorkSetupNotice). */}
        {view !== "settings" && <WorkSetupLine style={noDrag} />}
      </div>
      {/* The project pill, centred: focus the window on one project (docs/project-focus.md). */}
      {view !== "settings" && <ProjectFocusControl room={room} />}
      <div
        ref={endRef}
        style={{ display: "flex", alignItems: "center", gap: 6 }}
        data-topbar-actions
      >
        <UpdateIndicator />
        {view !== "settings" && <ReducedMotionIndicator />}
        {view !== "settings" && <AmbientSoundControl />}
        {view !== "settings" && (
          <IconButton
            label={m.shellTopBarSettings()}
            onClick={onSettings}
            style={noDrag}
            {...settingsKeys}
          >
            {Ico.gear}
          </IconButton>
        )}
      </div>
      {appControls && <WindowControls />}
    </div>
  );
}
