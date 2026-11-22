import type { UpdateStatus } from "@shared/update";
import { UPDATE_WORDS, UPDATE_WORK_WORDS } from "@shared/updateWords";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { useMinute } from "../design/core/useMinute";
import { useCommandKeys } from "./keyHints";
import { checkForUpdates, installOfferedUpdate, updateLater, useUpdateState } from "./updateState";
import {
  type UpdateStep,
  type UpdateStepAction,
  type UpdateStepButton,
  updateStep,
} from "./updateStep";

/**
 * The one update part (docs/alpha.md "Update channels"): the ladder's line,
 * with what it holds beside it, and the step's buttons. The Version row in
 * Settings → General and the top-right update notice draw the same two
 * pieces from the same step, so they always say and offer the same thing.
 */

export function useUpdateStep(): { status: UpdateStatus | null; step: UpdateStep | null } {
  const { status, checking, busy, problem, later } = useUpdateState();
  const now = useMinute();
  return { status, step: updateStep(status, { checking, busy, problem, later, now }) };
}

export function runUpdateStep(action: UpdateStepAction, command?: string): Promise<unknown> {
  switch (action) {
    case "check":
      return checkForUpdates();
    case "install":
      return installOfferedUpdate();
    case "later":
      return updateLater();
    case "release":
      return window.infinitary.update.openReleasePage();
    case "copy":
      return navigator.clipboard.writeText(command ?? "");
  }
}

function Command({ command }: { command: string }) {
  return (
    <code
      data-update-command=""
      style={{
        display: "block",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-sm)",
        color: "var(--fg-1)",
        background: "var(--bg-2)",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-s)",
        padding: "var(--space-2) var(--space-3)",
        userSelect: "all",
        overflowWrap: "anywhere",
      }}
    >
      {command}
    </code>
  );
}

/**
 * The line, with the version it offers as a link that opens that version's
 * release page (INF-3405, the captain's direction B: View release became
 * this link, so Check for updates fits beside the next step).
 */
function StepLine({
  line,
  version,
  onAction,
}: {
  line: string;
  version: string | undefined;
  onAction: (action: UpdateStepAction) => void;
}) {
  const at = version ? line.indexOf(version) : -1;
  if (!version || at < 0) return <>{line}</>;
  return (
    <>
      {line.slice(0, at)}
      <button
        type="button"
        data-update-release=""
        title={UPDATE_WORDS.release}
        style={{
          font: "inherit",
          padding: 0,
          border: "none",
          background: "none",
          cursor: "pointer",
          color: "var(--accent)",
          textDecoration: "underline",
          textDecorationThickness: 1,
          textUnderlineOffset: 2,
          borderRadius: "var(--radius-s)",
        }}
        onClick={() => onAction("release")}
      >
        {version}
      </button>
      {line.slice(at + version.length)}
    </>
  );
}

export function UpdateStepText({
  step,
  strong = false,
  onAction = (action) => void runUpdateStep(action),
}: {
  step: UpdateStep;
  strong?: boolean;
  onAction?: (action: UpdateStepAction) => void;
}) {
  return (
    <div
      data-update-step={step.state}
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      {step.line && (
        <div
          data-update-line=""
          role={step.problem ? "alert" : "status"}
          style={{
            fontSize: "var(--text-sm)",
            color: step.problem ? "var(--warn)" : strong ? "var(--fg-1)" : "var(--fg-2)",
          }}
        >
          <StepLine line={step.line} version={step.version} onAction={onAction} />
          {step.percent !== undefined && (
            <>
              {" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>{Math.round(step.percent)}%</span>
            </>
          )}
        </div>
      )}
      {step.percent !== undefined && (
        <progress
          aria-label={UPDATE_WORDS.progress}
          value={step.percent}
          max={100}
          style={{ width: "100%", accentColor: "var(--accent)" }}
        />
      )}
      {step.waiting?.map((task) => (
        <div
          key={task}
          data-update-waiting=""
          style={{ fontSize: "var(--text-sm)", color: "var(--fg-3)" }}
        >
          {UPDATE_WORK_WORDS.waitingFor(task)}
        </div>
      ))}
      {step.command && <Command command={step.command} />}
    </div>
  );
}

function StepButton({
  button,
  variant,
  command,
  onAction,
  hook,
}: {
  button: UpdateStepButton;
  variant: "primary" | "secondary" | "ghost";
  command?: string;
  onAction: (action: UpdateStepAction) => void;
  hook?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const reset = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(reset);
  }, [copied]);
  const checkKeys = useCommandKeys("updates.check");
  const laterKeys = useCommandKeys("updates.later");
  const keys = button.action === "check" ? checkKeys : button.action === "later" ? laterKeys : {};
  return (
    <Button
      variant={variant}
      size="sm"
      data-update-action={button.action}
      {...(hook ? { "data-update-check": "" } : {})}
      {...keys}
      disabled={button.disabled}
      {...(button.pending ? { pending: true, pendingLabel: button.pending } : {})}
      onClick={() => {
        if (button.action === "copy")
          void runUpdateStep("copy", command).then(
            () => setCopied(true),
            () => {},
          );
        else onAction(button.action);
      }}
    >
      {button.action === "copy" && copied ? UPDATE_WORDS.copied : button.label}
    </Button>
  );
}

/**
 * The step's buttons: the secondary first, then the next step. `hook` marks
 * Check for updates, where the step offers it, or else the next step, as
 * the one command search's Check for updates focuses.
 */
export function UpdateStepButtons({
  step,
  onAction = (action) => void runUpdateStep(action),
  hook = false,
}: {
  step: UpdateStep;
  onAction?: (action: UpdateStepAction) => void;
  hook?: boolean;
}) {
  const checkSecond = step.secondary?.action === "check";
  return (
    <div
      data-update-buttons=""
      style={{
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: "var(--space-2)",
        flexShrink: 0,
      }}
    >
      {/* Keyed by action, so Check for updates stays the same button, keeping focus,
          when a check finds a version and it moves beside the next step. */}
      {step.secondary && (
        <StepButton
          key={step.secondary.action}
          button={step.secondary}
          variant="ghost"
          command={step.command}
          onAction={onAction}
          hook={hook && checkSecond}
        />
      )}
      <StepButton
        key={step.primary.action}
        button={step.primary}
        // Checking is the quiet step; every other next step is the primary.
        variant={step.primary.action === "check" ? "secondary" : "primary"}
        command={step.command}
        onAction={onAction}
        hook={hook && !checkSecond}
      />
    </div>
  );
}
