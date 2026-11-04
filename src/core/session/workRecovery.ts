import type { WorkInvokeChannel } from "@shared/ipc";

/**
 * Opened tool lists match when they name the same tools, in any order.
 * Both sides of a placed conversation compare them this way.
 */
export function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const names = new Set(left);
  return right.every((name) => names.has(name));
}

/** What to inspect when a begun change has no kept answer, in the operation's own words. */
export const CHANGE_RECOVERY: Partial<
  Record<WorkInvokeChannel, readonly [string, string, string]>
> = {
  "inf:work:card": [
    "showing this card",
    "it may already be up",
    "Check your task with tasks before showing it again.",
  ],
  "inf:work:card-refused": [
    "recording why this card was refused",
    "the refusal may already be recorded",
    "Check your task with tasks before recording it again.",
  ],
  "inf:work:close-card": [
    "closing this card",
    "it may already be closed",
    "Check your task with tasks before closing it again.",
  ],
  "inf:work:followup": [
    "filing this follow-up",
    "it may already be filed",
    "Look for the follow-up with tasks before filing it again.",
  ],
  "inf:work:progress": [
    "recording your progress",
    "the line may already be recorded",
    "Read your task with tasks before continuing. That cannot confirm this record, so do not repeat it automatically.",
  ],
  "inf:work:report": [
    "keeping your report",
    "the report may already be recorded",
    "Check your task with tasks before reporting it again.",
  ],
  "inf:work:reply": [
    "replying under this card",
    "the reply may already be there",
    "Read your task with tasks before continuing. That cannot confirm whether the reply was posted, so do not repeat it automatically.",
  ],
  "inf:work:revise-required-action": [
    "correcting this required action",
    "the correction may already be saved",
    "Read the card with tasks card before correcting it again; the same operation identity returns its earlier result.",
  ],
  "inf:work:speed-note": [
    "recording the model selection",
    "the selection may already be recorded",
    "Read your task with tasks before continuing. That cannot confirm this record, so do not repeat it automatically.",
  ],
  "inf:work:github-write": [
    "changing your project where it lives",
    "the change may already be done",
    "Read the affected item where your project lives before asking for the change again.",
  ],
  "inf:work:prepare-change": [
    "preparing this change for review",
    "the review may already be ready",
    "Check your task with tasks before preparing it again.",
  ],
  "inf:work:open-change": [
    "offering this change",
    "it may already be offered",
    "Check your project's open changes before offering it again.",
  ],
  "inf:work:check-change": [
    "checking this change",
    "its results may already be recorded",
    "Check your task with tasks before checking the change again.",
  ],
  "inf:work:download-artifact": [
    "keeping these check files",
    "the files may already be kept",
    "Check your task's files before downloading them again.",
  ],
  "inf:work:job-exit": [
    "recording the command's result",
    "the result may already be recorded",
    "Check your task with tasks before recording it again.",
  ],
  "inf:work:browser-event": [
    "updating this task's browser",
    "the action may already have happened",
    "Check the task's browser before asking for the action again.",
  ],
  "inf:work:use-integration": [
    "running this integration's action",
    "it may already have run, or be kept as an ask",
    "Check your task with tasks and read what the action changes before calling it again.",
  ],
};

/** The operation's reachable check, shared by crash and unanswered-request recovery. */
export function changeRecoveryCheck(channel: WorkInvokeChannel): string {
  return (
    CHANGE_RECOVERY[channel]?.[2] ??
    "Read your task with tasks before continuing. Do not repeat the change automatically."
  );
}
