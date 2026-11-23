import { describe, expect, it } from "vitest";
import type { TaskRecord } from "../storage/taskRecordTypes";
import { type FeedbackHostDeps, homeFeedbackHost, systemVersion } from "./feedbackHost";
import { guardMatches } from "./guard";

/**
 * Intent: the approved /feedback plan's guard reads the computer's name as
 * the person writes it (the captain: "it should not send any personal
 * identifiable information"). A Mac's network name is held as name.local,
 * while a draft writes the bare name; both are refused.
 */
function deps(): FeedbackHostDeps {
  const none = () => [];
  return {
    repository: "infinitary-labs/infinitary-apps",
    app: { version: "0.8.6", channel: () => "alpha", install: () => "app", language: () => "en" },
    system: { name: "macOS", version: "26.1", chip: "arm64" },
    computerNames: () => ["Maria’s MacBook Pro", "Marias-MacBook-Pro.local"],
    devices: none,
    models: none,
    repos: none,
    forgeLogins: none,
    secretLabels: async () => [],
    integrations: none,
    task: () => undefined,
    policies: () => null,
    timeline: none,
    signedIn: () => true,
    login: () => null,
    getJson: async () => ({ status: 200, body: "{}" }),
    keep: () => "ask",
  };
}

describe("the identifiers the home holds for the guard", () => {
  it("holds a computer's network name bare as well", async () => {
    const held = await homeFeedbackHost(deps()).held();
    expect(guardMatches("It only happens on Marias-MacBook-Pro.", held)).toContainEqual({
      kind: "computer name",
      text: "Marias-MacBook-Pro",
    });
    expect(guardMatches("It only happens on Maria's MacBook Pro.", held)).toContainEqual({
      kind: "computer name",
      text: "Maria's MacBook Pro",
    });
  });
});

describe("the facts the home reads for a report", () => {
  it("carries a task's delivery, care and each check's state, never a check's name", () => {
    const record = {
      id: "task-1",
      key: "INF-812",
      kind: "work",
      status: "active",
      closedReason: null,
      createdAt: 0,
      startedAt: 0,
      shape: { kind: "work" },
      delivery: {
        ci: "red",
        checks: {
          headSha: "0".repeat(40),
          absenceDeclared: false,
          items: [
            { name: "Push · harbor-ledger build", state: "failure" },
            { name: "Push · harbor-ledger tests", state: "success" },
          ],
        },
      },
    } as unknown as TaskRecord;
    const facts = homeFeedbackHost({
      ...deps(),
      task: () => record,
      policies: () => ({ delivery: "queue-pr", care: "careful" }),
    }).diagnostics("INF-812");
    expect(facts).toMatchObject({
      system: { name: "macOS", release: "26.1" },
      task: { delivery: "queue-pr", care: "careful", ci: "red", checks: ["failure", "success"] },
    });
    expect(JSON.stringify(facts)).not.toContain("harbor-ledger");
  });

  it("names a kernel's version as the kernel's where the system's own is unknown", () => {
    expect(systemVersion("linux")).toMatch(/^kernel \d/);
  });
});
