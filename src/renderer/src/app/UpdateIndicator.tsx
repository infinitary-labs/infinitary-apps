import * as m from "@shared/i18n/messages.generated";
import type { UpdateStatus } from "@shared/update";
import type React from "react";
import { useEffect, useRef } from "react";
import { IconButton, MicroLabel } from "../design";
import { useMinute } from "../design/core/useMinute";
import { focusWithRing } from "../design/focus";
import { usePopoverPresence } from "../design/motion";
import { useCommandKeys } from "./keyHints";
import { UpdateStepButtons, UpdateStepText } from "./UpdateStepView";
import {
  followAskedUpdate,
  refreshUpdateStatus,
  setUpdateNoticeOpen as setOpen,
  useUpdateState,
} from "./updateState";
import { type UpdateStepAction, type UpdateStepPresses, updateStep } from "./updateStep";

const CHANNEL_LABEL: Record<UpdateStatus["channel"], () => string> = {
  stable: () => m.shellUpdateStable(),
  alpha: () => m.shellUpdateAlpha(),
};

/**
 * The quiet update indicator (docs/architecture.md section 10): polls the
 * installed channel's update target through main (at most every 4h there),
 * shows nothing when current, and opens a small panel drawing the same
 * update part as the Version row in Settings when behind (docs/alpha.md
 * "Update channels"): Update and restart on a direct Mac copy, Install
 * where the app installs its own updates on Linux, and the selectable
 * upgrade command with Copy command where a package manager does. Nothing
 * installs on its own, ever.
 */
export function UpdateIndicator() {
  const { status, checking, busy, problem, later, noticeOpen: open } = useUpdateState();
  const now = useMinute();
  const updateKeys = useCommandKeys("updates.show");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel grows from the button and fades out as it closes.
  const drawn = usePopoverPresence(open, panelRef, buttonRef);

  useEffect(() => {
    void refreshUpdateStatus();
    const interval = setInterval(
      () => {
        void refreshUpdateStatus();
      },
      60 * 60 * 1000,
    );
    // A paired phone or Mac started this computer's update: the notice opens and follows it.
    const unsubscribe = window.infinitary.update.onAsked(() => followAskedUpdate());
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (open && drawn) {
      // The step's first button; the version's link in the line comes after them by Shift+Tab.
      const first = panelRef.current?.querySelector<HTMLButtonElement>(
        "[data-update-buttons] button:not([disabled])",
      );
      if (first) focusWithRing(first);
    }
  }, [open, drawn]);

  useEffect(() => {
    if (!status?.updateAvailable && open) setOpen(false);
  }, [status?.updateAvailable, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!status?.updateAvailable) return null;

  const noDrag = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

  return (
    <div ref={rootRef} style={{ position: "relative", ...noDrag }}>
      <IconButton
        ref={buttonRef}
        label={m.shellUpdateAvailable({ version: status.latestVersion ?? "" })}
        tone="accent"
        {...updateKeys}
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v8m-4-4 4 4 4-4" />
        </svg>
      </IconButton>
      {drawn && (
        <UpdatePanel
          ref={panelRef}
          status={status}
          presses={{ checking, busy, problem, later }}
          now={now}
        />
      )}
    </div>
  );
}

/** What the panel's step reads when nothing was pressed in this window. */
const NOTHING_PRESSED: Omit<UpdateStepPresses, "now"> = {
  checking: false,
  busy: false,
  problem: null,
  later: null,
};

/**
 * The open panel: the channel, then the same update part as the Version row
 * in Settings (UpdateStepView.tsx) - the line that says where the update stands,
 * the version this copy has beneath it, and the step's buttons, the next
 * step always the primary. While the update saves the crew's work it says
 * whose running work it waits for and offers Update later (docs/alpha.md,
 * "Saving work before an update").
 */
export function UpdatePanel({
  status,
  presses = NOTHING_PRESSED,
  now = Date.now(),
  onAction,
  ref,
}: {
  status: UpdateStatus;
  presses?: Omit<UpdateStepPresses, "now">;
  now?: number;
  onAction?: (action: UpdateStepAction) => void;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const step = updateStep(status, { ...presses, now });
  return (
    <div
      ref={ref}
      data-update-channel={status.channel}
      style={{
        position: "absolute",
        top: "calc(100% + 8px)",
        right: 0,
        width: 340,
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-m)",
        boxShadow: "var(--shadow-2)",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        zIndex: 20,
      }}
    >
      <MicroLabel>{CHANNEL_LABEL[status.channel]()}</MicroLabel>
      {step && <UpdateStepText step={step} strong {...(onAction ? { onAction } : {})} />}
      {status.askedFrom && (
        <div data-update-asked-from style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          {m.viewHomeUpdateAskedFrom({ name: status.askedFrom })}
        </div>
      )}
      <div data-update-installed style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
        {m.shellUpdateInstalled({ version: status.currentVersion })}
      </div>
      {step && <UpdateStepButtons step={step} {...(onAction ? { onAction } : {})} />}
    </div>
  );
}
