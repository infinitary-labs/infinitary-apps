import type { UpdateStatus } from "@shared/update";
import { UPDATE_NOTICES, UPDATE_PROBLEMS, UPDATE_WORDS } from "@shared/updateWords";
import { useEffect } from "react";
import { useCommandKeys } from "../app/keyHints";
import {
  checkForUpdates,
  checksUpdates,
  refreshUpdateStatus,
  setUpdateNoticeOpen,
  useUpdateState,
} from "../app/updateState";
import { Button } from "../design";

/**
 * Check for updates on the Version row in Settings → General (docs/alpha.md
 * "Update channels"): one line for what the last check found, on every copy
 * whose installation the app knows, and a button that reads the release
 * source now. Show update opens the update notice, where installing still
 * waits for its own click.
 */

/** Settings has a status to show, for a copy that can check. */
const shown = (status: UpdateStatus | null): status is UpdateStatus =>
  !!status && checksUpdates(status);

/** While an update downloads, installs or waits for a restart, there is nothing to check. */
const updating = (status: UpdateStatus) =>
  status.phase === "downloading" || status.phase === "installing" || status.phase === "ready";

/** The Version row's update line, or null when it has nothing to say. */
export function updateLine(status: UpdateStatus | null, checking: boolean): string | null {
  if (!shown(status)) return null;
  if (status.phase === "ready") return "Restart to finish updating before changing channels.";
  if (status.phase === "installing") return "Infinitary is finishing the update.";
  if (updating(status)) return null;
  if (checking || status.phase === "checking") return UPDATE_WORDS.checking;
  if (status.phase === "error") return status.problem ?? UPDATE_PROBLEMS.checkFailed;
  if (status.updateAvailable && status.latestVersion)
    return UPDATE_NOTICES.available(status.latestVersion);
  return status.notice ?? null;
}

export function UpdateCheckLine() {
  const { status, checking } = useUpdateState();
  useEffect(() => {
    void refreshUpdateStatus();
  }, []);
  const line = updateLine(status, checking);
  if (!line) return null;
  const offered =
    !checking && status?.updateAvailable && status.phase !== "error" && !updating(status);
  return (
    <div
      data-update-line=""
      style={{
        marginTop: "var(--space-2)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        color: "var(--fg-2)",
        fontSize: "var(--text-sm)",
      }}
    >
      <span role="status">{line}</span>
      {offered && (
        <Button variant="ghost" size="sm" onClick={() => setUpdateNoticeOpen(true)}>
          {UPDATE_WORDS.show}
        </Button>
      )}
    </div>
  );
}

export function UpdateCheckButton() {
  const { status, checking, busy } = useUpdateState();
  const keys = useCommandKeys("updates.check");
  if (!shown(status)) return null;
  const reading = checking || status.phase === "checking";
  return (
    <Button
      variant="secondary"
      size="sm"
      data-update-check=""
      {...keys}
      // A press while one reads joins it.
      disabled={busy || updating(status)}
      onClick={() => {
        void checkForUpdates();
      }}
    >
      {reading ? UPDATE_WORDS.checkingButton : UPDATE_WORDS.check}
    </Button>
  );
}
