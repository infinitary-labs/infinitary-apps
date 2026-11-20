import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFrameSchema, homeFrameSchema } from "@shared/connection";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "@shared/ipc";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_CHANGES,
  contractChange,
  contractChangeFiles,
  contractChangesDir,
  listsChange,
  protocolVersionOf,
  readContractChanges,
  viewFloorAgrees,
  viewsDeclaration,
} from "./contractChanges";

/**
 * One named file per contract change, and a version that moves only on a
 * break (INF-519, the captain's choices: features wait by name, the minor
 * stays as it is until the next major, and a major types its number once,
 * in its file name). Read from the real folder, and from its file list with
 * one change added or a major replaced, as a pull request would.
 */
describe("the contract's changes by name", () => {
  it("names one major in this build's folder, and the version is the one it allows", () => {
    expect(
      PROTOCOL_VERSION,
      "Only a major moves PROTOCOL_VERSION; a minor change adds a file (src/shared/contract-changes/README.md).",
    ).toBe(protocolVersionOf(CONTRACT_CHANGES));
    // Each name its hello and its welcome list reaches the other side whole.
    const hello = clientFrameSchema.parse({
      t: "hello",
      protocolVersion: PROTOCOL_VERSION,
      changes: CONTRACT_CHANGES.names,
    });
    expect(hello).toMatchObject({ changes: CONTRACT_CHANGES.names });
    const welcome = homeFrameSchema.parse({
      t: "welcome",
      protocolVersion: PROTOCOL_VERSION,
      epoch: "e",
      seq: 0,
      catchUp: "reload",
      access: "full",
      changes: CONTRACT_CHANGES.names,
    });
    expect(welcome).toMatchObject({ changes: CONTRACT_CHANGES.names });
  });

  // INF-1109's conflict-required update: these additions reached main before the
  // Secrets major, so they belong to that major, not optional advertised features.
  it("absorbs the intervening main capabilities into the Secrets major", () => {
    for (const name of [
      "card-continues",
      "inbox-integration",
      "project-folders",
      "remote-change-lines",
      // The required update onto main after PR #493 brought seven more.
      "fetch-ubuntu-package",
      "landed-time-retired",
      "longer-join-command",
      "native-scene-observations",
      "project-repo-kind",
      "report-check-back",
      "report-merge-completion",
      // The required update onto main after PR #549 brought one more.
      "started-by-command-control",
      // The required update onto main after its attachment hand-over brought three more.
      "card-seen-snapshot",
      "complete-integration-actions",
      "empty-source-files",
      // The required update onto main after PR #587 brought one more.
      "placement-inherited",
      // The required update onto main after its operations major 12 brought two more.
      "task-timeline-reading",
      "work-task-history-field",
      // The required update onto main after its journey timing repair brought one more.
      "background-job-named",
      // The required update onto main after its late-picture repair brought one more.
      "mac-update-channels",
      // The required update for main's resource, card and first-release additions.
      "card-answered-by",
      "card-asked-line",
      "first-release-reports",
      "forge-start-problem",
      "heavy-run-line",
      "linux-automatic-startup",
      "task-resource-observations",
      "work-reply-interim",
      // The required update for main's check facts and offer-based readiness.
      "check-declarations",
      "check-facts-and-crew-verdict",
      "merge-offer-readiness",
      // The conflict-required update brings the view contract and two additive home interfaces.
      "forge-github-cli",
      "last-turn-previous",
      "view-floor",
      // The required update after PR #806 includes completed-operation observations.
      "tool-observations",
      // Major 14 includes every addition since queue delivery.
      "after-merge-steps",
      "answer-stuck-reads",
      "card-leave",
      "card-origin-line",
      "card-reply-interim",
      "checked-out-branch",
      "conversation-folds",
      "files-there",
      "note-done",
      "open-change-branch",
      "panel-arrangement",
      "panel-integrations",
      "phone-diagnostics",
      "project-queue-facts",
      "queue-choice-waits",
      "shared-cards",
      "task-pull-requests",
      "thread-sign-off",
      "update-checked-at",
      // INF-3042: these additions also precede the Secrets major.
      "crewmate-programs",
      "firstmate-folding",
      "frame-parts",
      "gitlab-queue-token",
      "integration-task-allow",
      "shipped-queue",
      // INF-3206: the conflict update must also absorb these additions from main.
      "custom-api-address-exception",
      "ended-cards",
      "keep-cards-maximized",
      "review-covers",
      "stall-card-backlog",
      "task-run-null-review",
      // The next conflict-required update also belongs to the same pending major.
      "check-queue-answer",
      "computer-github-cli",
      // The requested main update for the one-device phone route precedes this major too.
      "card-allows",
      "cost-limit",
      "record-close-done",
      "report-captain-words",
      "task-browser-private-sites",
      // Major 16 removes the team queue's contract surface and includes every addition since the Secrets major.
      "activity-said-here",
      "after-merge-holds",
      "allowance-opened",
      "app-events",
      "automation-event-screen",
      "automation-run-found",
      "batch-gate",
      "batch-host-queue",
      "board-without-closed",
      "browser-from-any-view",
      "card-annotations",
      "card-app-parts",
      "card-data",
      "card-files",
      "card-logs",
      "card-put-off",
      "claude-access",
      "computer-readings-live",
      "custom-token-command",
      "decision-uses",
      "devices-from-a-view",
      "every-view-asks",
      "feed-said-here",
      "feed-said",
      "font-choice",
      "fork-contributions",
      "fork-review-source",
      "from-the-command",
      "inbox-old-name-use",
      "keep-going-on-credits",
      "keyboard-tmux-preset",
      "language-choice",
      "left-behind",
      "live-validation-table",
      "merge-card-since-seen",
      "messages-while-reading",
      "model-choice-turns",
      "own-batches",
      "own-window",
      "panel-command-asks",
      "panels-in-every-window",
      "panels-on-the-phone",
      "provider-stuck",
      "quota-credits",
      "remote-sign-in-flows",
      "replay-newest-lists",
      "secret-approval-task",
      "secrets-app-sign-in",
      "secrets-last-task",
      "secrets-phone-switch",
      "secrets-question-in-place",
      "secrets-shown",
      "secrets-start-over",
      "show-merge-card",
      "sign-in-return",
      "story-map",
      "story-part",
      "streamed-events-live",
      "task-closed-parts",
      "task-keys",
      "task-pin",
      "task-stops",
    ]) {
      expect(CONTRACT_CHANGES.names).not.toContain(name);
      expect(() => contractChange(name)).toThrow(`No contract change is named ${name}`);
    }
  });

  it("adds a minor change's name and moves no version", () => {
    const files = contractChangeFiles();
    const added = readContractChanges([...files, "plan-label-limits.md"]);
    expect(added.names).toEqual([...CONTRACT_CHANGES.names, "plan-label-limits"]);
    expect(protocolVersionOf(added)).toBe(PROTOCOL_VERSION);
  });

  it("makes the next major's file the version's major, at its first minor", () => {
    // A major removes the major file before it and every minor file.
    const next = readContractChanges([`major-${CONTRACT_CHANGES.major + 1}.md`]);
    expect(next).toEqual({ major: CONTRACT_CHANGES.major + 1, names: [] });
    expect(protocolVersionOf(next)).toBe(`${CONTRACT_CHANGES.major + 1}.0.0`);
  });

  it("refuses a folder with no major file, two at once, or a file not named for a change", () => {
    const files = contractChangeFiles();
    const minors = files.filter((file) => !file.startsWith("major-"));
    expect(() => readContractChanges(minors)).toThrow("no major file");
    // Two majors merged at once, each with its own number.
    expect(() => readContractChanges([...files, `major-${CONTRACT_CHANGES.major + 1}.md`])).toThrow(
      "2 major files",
    );
    expect(() => readContractChanges([...files, "10-2.md"])).toThrow("10-2.md");
    expect(() => readContractChanges([...files, "Story_Around.md"])).toThrow("Story_Around.md");
  });

  it("refuses a wait for a change no file has", () => {
    // A folder at the next minor change, as a pull request would leave it.
    const folder = readContractChanges([
      `major-${CONTRACT_CHANGES.major}.md`,
      "plan-label-limits.md",
    ]);
    expect(contractChange("plan-label-limits", folder)).toBe("plan-label-limits");
    expect(() => contractChange("story-around", folder)).toThrow(
      "No contract change is named story-around",
    );
    for (const name of CONTRACT_CHANGES.names) expect(contractChange(name)).toBe(name);
  });

  it("gives a side that listed nothing no change", () => {
    const folder = readContractChanges([
      `major-${CONTRACT_CHANGES.major}.md`,
      "plan-label-limits.md",
      "story-around.md",
    ]);
    const limits = contractChange("plan-label-limits", folder);
    expect(listsChange(["plan-label-limits", "story-around"], limits)).toBe(true);
    expect(listsChange(["story-around"], limits)).toBe(false);
    expect(listsChange([], limits)).toBe(false);
    expect(listsChange(undefined, limits)).toBe(false);
    expect(listsChange(null, limits)).toBe(false);
  });

  // INF-1649 (the captain's direction A): a floor for every view, moved only by a major that breaks views.
  it("holds the view floor to what the current major's file says it did to views", () => {
    const text = readFileSync(
      join(contractChangesDir(), `major-${CONTRACT_CHANGES.major}.md`),
      "utf8",
    );
    const views = viewsDeclaration(text);
    expect(
      viewFloorAgrees(CONTRACT_CHANGES.major, views, VIEW_FLOOR),
      `major-${CONTRACT_CHANGES.major}.md says "Views: ${views}.", so VIEW_FLOOR (src/shared/ipc.ts) is ${views === "break" ? "that major" : "below it"}`,
    ).toBe(true);
  });

  it("refuses a major's file that does not say once whether views break", () => {
    expect(viewsDeclaration("# Major 13\n\nA field went.\nViews: break.\n")).toBe("break");
    expect(() => viewsDeclaration("# Major 13\n\nA field went.\n")).toThrow("Views: keep.");
    expect(() => viewsDeclaration("Views: keep.\nViews: break.\n")).toThrow("Views: keep.");
    // A major that breaks views is the floor; one that keeps them leaves it below.
    expect(viewFloorAgrees(13, "break", 13)).toBe(true);
    expect(viewFloorAgrees(13, "break", 11)).toBe(false);
    expect(viewFloorAgrees(13, "keep", 11)).toBe(true);
    expect(viewFloorAgrees(13, "keep", 13)).toBe(false);
  });
});
