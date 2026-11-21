import type { ThisMac } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { WorkSetupReason } from "@shared/workSetup";
import type React from "react";
import { useState } from "react";
import { create } from "zustand";
import { Button } from "../design";
import { NoticeStrip } from "./NoticeStrip";
import { useShellStore } from "./store";

/**
 * Why this computer's work for the first mate it joined does not run
 * (docs/view.md, "A Mac that runs work"; design skill
 * `components/devices/DevicesTab`, "A Mac that has not finished setting
 * up"): under the input of a window that controls another computer and runs
 * its work, while its work cannot be set up or has not reached that
 * computer, with Try again and Not now. The window sets its work up again
 * by itself at every connection to its home, the first of each launch
 * included, and as it comes back to the front; Try again checks it now. Not
 * now folds the notice into a quiet line at the top bar's left, beside the
 * line that names the other computer, until the reason changes; pressing
 * that line opens the notice again.
 */

/** The reason whose notice was put away with Not now, while this window runs. */
const useFolded = create<{ reason: WorkSetupReason | null }>(() => ({ reason: null }));

/** Why this computer's work cannot run, or null while nothing stops it. */
function blockedReason(thisMac: ThisMac | null): WorkSetupReason | null {
  if (thisMac?.role !== "view" || thisMac.workSetup?.state !== "blocked") return null;
  return thisMac.workSetup.reason ?? "not-reached";
}

// Once the work runs again, a later stop shows its notice whole, whatever its reason.
useShellStore.subscribe((state) => {
  if (blockedReason(state.thisMac) === null && useFolded.getState().reason !== null)
    useFolded.setState({ reason: null });
});

/** Whether the notice for this reason is folded into the top bar's quiet line. */
function useNoticeFolded(): boolean {
  const reason = useShellStore((s) => blockedReason(s.thisMac));
  const folded = useFolded((s) => s.reason);
  return reason !== null && folded === reason;
}

/** The notice's words for a view's work half, or null while nothing stops it. */
export function workSetupNoticeText(thisMac: ThisMac | null): string | null {
  const reason = blockedReason(thisMac);
  return reason && thisMac?.role === "view" ? noticeWords(reason, thisMac.name) : null;
}

function noticeWords(reason: WorkSetupReason, home: string): string {
  const words = { home };
  switch (reason) {
    case "other-home":
      return m.viewWorkOtherHome(words);
    case "other-entry":
      return m.viewWorkOtherEntry(words);
    case "removal-unfinished":
      return m.viewWorkRemovalUnfinished(words);
    case "app-place":
      return m.viewWorkAppPlace(words);
    case "background-off":
      return m.viewWorkBackgroundOff(words);
    case "no-background":
      return m.viewWorkNoBackground(words);
    case "newer-work":
      return m.viewWorkNewerWork(words);
    case "local-network":
      return m.viewWorkLocalNetwork(words);
    default:
      return m.viewWorkNotReached(words);
  }
}

export function WorkSetupNoticeView({
  width,
  text,
  reason,
  trying,
  onTryAgain,
  onNotNow,
}: {
  width: string;
  text: string;
  reason: string;
  trying: boolean;
  onTryAgain: () => void;
  onNotNow: () => void;
}) {
  return (
    <NoticeStrip width={width} role="status" data-work-setup-notice={reason}>
      <div style={{ minWidth: 0, flex: 1, fontSize: "var(--text-sm)", color: "var(--fg-2)" }}>
        {text}
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
        <Button variant="ghost" size="sm" onClick={onNotNow}>
          {m.viewWorkNotNow()}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          pending={trying}
          pendingLabel={m.viewWorkTrying()}
          onClick={onTryAgain}
        >
          {m.viewWorkTryAgain()}
        </Button>
      </div>
    </NoticeStrip>
  );
}

export function WorkSetupNotice({ width }: { width: string }) {
  const thisMac = useShellStore((s) => s.thisMac);
  const [trying, setTrying] = useState(false);
  const folded = useNoticeFolded();
  const text = workSetupNoticeText(thisMac);
  const reason = blockedReason(thisMac);
  if (!text || !reason || folded) return null;
  return (
    <WorkSetupNoticeView
      width={width}
      text={text}
      reason={reason}
      trying={trying}
      onNotNow={() => useFolded.setState({ reason })}
      onTryAgain={() => {
        setTrying(true);
        void window.infinitary.devices
          .setUpWork()
          .catch(() => {})
          .finally(() => setTrying(false));
      }}
    />
  );
}

/**
 * The notice put away with Not now, at the top bar's left after the line
 * that names the other computer: a warn dot and a few quiet words, whose
 * press opens the notice again. It reads the notice whole as its description.
 */
export function WorkSetupLine({ style }: { style?: React.CSSProperties }) {
  const thisMac = useShellStore((s) => s.thisMac);
  const folded = useNoticeFolded();
  const text = workSetupNoticeText(thisMac);
  if (!folded || !text) return null;
  return (
    <span data-work-setup-line={blockedReason(thisMac) ?? undefined} style={style}>
      <Button
        variant="ghost"
        size="sm"
        aria-description={text}
        onClick={() => useFolded.setState({ reason: null })}
        style={{ gap: "var(--space-2)" }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--warn)",
            flexShrink: 0,
          }}
        />
        {m.viewWorkFolded()}
      </Button>
    </span>
  );
}
