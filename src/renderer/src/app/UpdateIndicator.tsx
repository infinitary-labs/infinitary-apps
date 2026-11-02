import type { UpdateStatus } from "@shared/update";
import { UPDATE_WORDS, UPDATE_WORK_WORDS } from "@shared/updateWords";
import type React from "react";
import { useEffect, useRef } from "react";
import { Button, IconButton, MicroLabel } from "../design";
import { focusWithRing } from "../design/focus";
import { usePopoverPresence } from "../design/motion";
import { useCommandKeys } from "./keyHints";
import {
  installOfferedUpdate,
  refreshUpdateStatus,
  setUpdateNoticeOpen as setOpen,
  updateLater,
  useUpdateState,
} from "./updateState";

const CHANNEL_LABEL: Record<UpdateStatus["channel"], string> = {
  stable: "Stable updates",
  alpha: "Alpha updates",
};

/**
 * The quiet update indicator (docs/architecture.md section 10): polls the
 * installed channel's update target through main (at most every 4h there),
 * shows nothing when current, and opens a small panel naming the channel,
 * the offered and installed versions, and that channel's selectable cask
 * upgrade command, when behind (docs/alpha.md "Update channels"). Where the
 * app installs its own updates - a deb, an rpm or an AppImage on Linux - the
 * panel offers Install instead (docs/alpha.md "Updates on Linux"). Nothing
 * installs on its own, ever.
 */
export function UpdateIndicator() {
  const { status, busy: installing, problem, later, noticeOpen: open } = useUpdateState();
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
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (open && drawn) {
      const first = panelRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])");
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
        label={`Update available: ${status.latestVersion ?? ""}`}
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
          onViewRelease={() => void window.infinitary.update.openReleasePage()}
          installing={installing}
          problem={problem}
          later={later}
          onInstall={() => {
            void installOfferedUpdate();
          }}
          onLater={() => {
            void updateLater();
          }}
        />
      )}
    </div>
  );
}

/** The selectable command block. */
function Command({ command }: { command: string }) {
  return (
    <code
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        color: "var(--fg-1)",
        background: "var(--bg-1)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-s)",
        padding: "8px 10px",
        userSelect: "all",
        overflowWrap: "anywhere",
      }}
    >
      {command}
    </code>
  );
}

/**
 * The open panel: the channel, the offered version with the installed one
 * beneath it, so an offer reads as new or not at a glance, and how to get
 * it - the channel's selectable upgrade command, or Install where the app
 * installs its own updates, with the command as the way round when
 * installing could not finish. While the update saves the crew's work it
 * says whose running work it waits for and offers Update later
 * (docs/alpha.md, "Saving work before an update").
 */
export function UpdatePanel({
  status,
  onViewRelease,
  onInstall,
  onLater,
  installing = false,
  problem = null,
  later = null,
  ref,
}: {
  status: UpdateStatus;
  onViewRelease: () => void;
  onInstall?: () => void;
  onLater?: () => void;
  installing?: boolean;
  problem?: string | null;
  /** Update later let the last update go. */
  later?: string | null;
  ref?: React.Ref<HTMLDivElement>;
}) {
  const install = status.install && onInstall ? status.install : null;
  const saving = status.work?.state === "saving" ? status.work : null;
  const laterKeys = useCommandKeys("updates.later");
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
      <MicroLabel>{CHANNEL_LABEL[status.channel]}</MicroLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
        <div
          data-update-offered
          style={{ fontSize: "var(--text-base)", color: "var(--fg-1)", fontWeight: 500 }}
        >
          Version {status.latestVersion} is available
        </div>
        <div data-update-installed style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
          You have {status.currentVersion}
        </div>
      </div>
      {install ? (
        <>
          <div
            data-update-install-note
            style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
          >
            {status.phase === "ready"
              ? "The checked update is ready. Restart to finish installing it."
              : install.restarts
                ? "Update and restart downloads and checks the new copy, then safely stops running work and restarts Infinitary."
                : install.asksPassword
                  ? "Install downloads it, checks it and asks for your password. Infinitary then starts again."
                  : "Install downloads it, checks it and replaces this copy. Infinitary then starts again."}
          </div>
          {status.phase === "downloading" && (
            <div
              role="status"
              data-update-progress
              style={{ color: "var(--fg-2)", fontSize: "var(--text-sm)" }}
            >
              Downloading{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {Math.round(status.percent ?? 0)}%
              </span>
              <progress
                aria-label={UPDATE_WORDS.progress}
                value={status.percent ?? 0}
                max={100}
                style={{ width: "100%", accentColor: "var(--accent)" }}
              />
            </div>
          )}
          {saving ? (
            <div
              role="status"
              data-update-saving
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "var(--space-1)",
                fontSize: "var(--text-sm)",
                color: "var(--fg-2)",
              }}
            >
              <div>{UPDATE_WORK_WORDS.saving}</div>
              {saving.tasks.map((task) => (
                <div key={task} data-update-waiting style={{ color: "var(--fg-3)" }}>
                  {UPDATE_WORK_WORDS.waitingFor(task)}
                </div>
              ))}
            </div>
          ) : (
            status.phase === "installing" && (
              <div
                role="status"
                data-update-updating
                style={{ fontSize: "var(--text-sm)", color: "var(--fg-2)" }}
              >
                {UPDATE_WORK_WORDS.updating}
              </div>
            )
          )}
          {later && !installing && (
            <div
              role="status"
              data-update-later-note
              style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
            >
              {later}
            </div>
          )}
          {(problem || status.problem) && (
            <div
              role="alert"
              data-update-problem
              style={{ fontSize: "var(--text-sm)", color: "var(--warn)" }}
            >
              {problem ?? status.problem}
            </div>
          )}
          {problem && status.upgradeCommand && (
            <>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
                Or install it from the terminal:
              </div>
              <Command command={status.upgradeCommand} />
            </>
          )}
        </>
      ) : (
        status.upgradeCommand && (
          <>
            <div style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}>
              Upgrade from the terminal:
            </div>
            <Command command={status.upgradeCommand} />
          </>
        )
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
        <Button variant="ghost" size="sm" onClick={onViewRelease}>
          {UPDATE_WORDS.release}
        </Button>
        {install && saving && onLater && (
          <Button variant="secondary" size="sm" onClick={onLater} data-update-later {...laterKeys}>
            {UPDATE_WORDS.later}
          </Button>
        )}
        {install && (
          <Button
            size="sm"
            onClick={onInstall}
            pending={installing || saving !== null}
            pendingLabel={
              saving
                ? UPDATE_WORDS.saving
                : status.phase === "downloading"
                  ? UPDATE_WORDS.downloading
                  : status.phase === "installing"
                    ? UPDATE_WORDS.updating
                    : UPDATE_WORDS.installing
            }
            data-update-install
          >
            {status.phase === "ready"
              ? UPDATE_WORDS.ready
              : install.restarts
                ? UPDATE_WORDS.restart
                : "Install"}
          </Button>
        )}
      </div>
    </div>
  );
}
