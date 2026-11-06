import { describe, expect, it } from "vitest";
import { readStandIns } from "./standIns";

/**
 * The stand-ins the app wiring reads, held in one module when the wiring was
 * split into its owners (INF-2625's plan), and the rule that module states
 * (src/core/standIns.ts): a packaged app reads none of them, whatever the
 * environment says, so a build anyone runs cannot be pointed anywhere else.
 * An unpackaged run reads each by its environment name, and drops what is
 * blank or out of range.
 */

/** Every stand-in this run can name, each set to a value the read keeps. */
const NAMED = {
  INFINITARY_EARLY_LAUNCH_MS: "2500",
  INFINITARY_INBOX_GRACE_MS: "40",
  INFINITARY_TASK_DELTA_ROWS: "0",
  INFINITARY_QUOTA_FIXTURE_DIR: " /fixtures/quota ",
  INFINITARY_CLAUDE_USAGE_URL: "http://127.0.0.1:9/claude",
  INFINITARY_GROK_USAGE_URL: "http://127.0.0.1:9/grok",
  INFINITARY_GROK_KEY_URL: "http://127.0.0.1:9/grok-key",
  INFINITARY_KIMI_USAGE_URL: "http://127.0.0.1:9/kimi",
  INFINITARY_COPILOT_USAGE_URL: "http://127.0.0.1:9/copilot",
  INFINITARY_STARTERS_URL: "http://127.0.0.1:9/starters.json",
  INFINITARY_CONNECTION_LOOPBACK_PORT: "40123",
  INFINITARY_STAND_IN_ADDRESSES: " 192.168.1.20 , ,fd00::20",
  INFINITARY_JOINS_FROM_ANOTHER_MAC: "1",
  INFINITARY_STAND_IN_NETWORK_NAME: "studio",
  INFINITARY_PUBLISHED_TAP: "example/tap",
  INFINITARY_SSH: "/stand-ins/ssh",
  INFINITARY_DNS_SD: "/stand-ins/dns-sd",
  INFINITARY_PRIVACY_LOG: "/stand-ins/log",
  INFINITARY_STAND_IN_INTEGRATION: "/stand-ins/events",
  INFINITARY_INBOX_LINK_DIR: "/stand-ins/bin",
  INFINITARY_JEV_URL: "http://127.0.0.1:9/jev",
  INFINITARY_OPENROUTER_DECISIONS_BASE_URL: "http://127.0.0.1:9/openrouter",
  INFINITARY_RELEASE_NOTES_DIR: "/stand-ins/notes",
};

describe("readStandIns", () => {
  it("reads nothing in a packaged app, whatever the environment names", () => {
    expect(readStandIns(true, NAMED)).toEqual({ joinsFromAnotherMac: false });
  });

  it("reads every stand-in an unpackaged run names, trimmed", () => {
    expect(readStandIns(false, NAMED)).toEqual({
      earlyLaunchMs: 2500,
      inboxGraceMs: 40,
      taskDeltaRows: 0,
      quotaFixtureDir: "/fixtures/quota",
      quotaEndpoints: {
        claudeUsageUrl: "http://127.0.0.1:9/claude",
        grokUsageUrl: "http://127.0.0.1:9/grok",
        grokKeyUrl: "http://127.0.0.1:9/grok-key",
        kimiUsageUrl: "http://127.0.0.1:9/kimi",
        copilotUsageUrl: "http://127.0.0.1:9/copilot",
      },
      startersUrl: "http://127.0.0.1:9/starters.json",
      loopbackPort: 40123,
      addresses: ["192.168.1.20", "fd00::20"],
      joinsFromAnotherMac: true,
      networkName: "studio",
      publishedTap: "example/tap",
      ssh: "/stand-ins/ssh",
      dnsSd: "/stand-ins/dns-sd",
      privacyLog: "/stand-ins/log",
      integrationDir: "/stand-ins/events",
      inboxLinkDir: "/stand-ins/bin",
      jevUrl: "http://127.0.0.1:9/jev",
      openRouterDecisionsBaseUrl: "http://127.0.0.1:9/openrouter",
      releaseNotesDir: "/stand-ins/notes",
    });
  });

  it("names nothing for a run that sets nothing", () => {
    const read = readStandIns(false, {});
    expect(read.joinsFromAnotherMac).toBe(false);
    expect(Object.values(read.quotaEndpoints ?? {}).filter(Boolean)).toEqual([]);
    expect(
      Object.entries(read).filter(
        ([name, value]) =>
          name !== "joinsFromAnotherMac" && name !== "quotaEndpoints" && value !== undefined,
      ),
    ).toEqual([]);
  });

  it("drops a blank text, a number out of range and a join that is not 1", () => {
    const read = readStandIns(false, {
      INFINITARY_EARLY_LAUNCH_MS: "0",
      INFINITARY_INBOX_GRACE_MS: "soon",
      INFINITARY_TASK_DELTA_ROWS: "-1",
      INFINITARY_CONNECTION_LOOPBACK_PORT: "65536",
      INFINITARY_STAND_IN_ADDRESSES: " , ",
      INFINITARY_JOINS_FROM_ANOTHER_MAC: "true",
      INFINITARY_SSH: "   ",
      INFINITARY_RELEASE_NOTES_DIR: "",
    });
    expect(read).not.toHaveProperty("earlyLaunchMs");
    expect(read).not.toHaveProperty("inboxGraceMs");
    expect(read).not.toHaveProperty("taskDeltaRows");
    expect(read).not.toHaveProperty("loopbackPort");
    expect(read).not.toHaveProperty("addresses");
    expect(read.joinsFromAnotherMac).toBe(false);
    expect(read.ssh).toBeUndefined();
    expect(read.releaseNotesDir).toBeUndefined();
  });
});
