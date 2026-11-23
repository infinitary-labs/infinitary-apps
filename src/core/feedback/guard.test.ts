import { describe, expect, it } from "vitest";
import { guardMatches, guardRefusal, type HeldIdentifier } from "./guard";

/**
 * Intent: the approved /feedback plan's guard - a draft holding an
 * identifier the host knows about the person, or a closed personal pattern,
 * is refused with each match and its kind named, so nothing personal is
 * published (the captain: "it should not send any personal identifiable
 * information"). The held list is shaped as the home reads it on a Mac with
 * one phone, one project and one connection.
 */
const HELD: HeldIdentifier[] = [
  { kind: "account name", value: "mtorres" },
  { kind: "home folder", value: "/Users/mtorres" },
  { kind: "computer name", value: "Marias-MacBook-Pro" },
  { kind: "device name", value: "Maria’s iPhone" },
  { kind: "sign-in", value: "mtorres-dev" },
  { kind: "project", value: "harbor-ledger" },
  { kind: "project folder", value: "/Users/mtorres/code/harbor-ledger" },
  { kind: "repository", value: "torres-labs/harbor-ledger" },
  { kind: "secret name", value: "STRIPE_LIVE_KEY" },
  { kind: "connection name", value: "Clinic Gmail" },
  // Infinitary's own names and a device's maker's name are never refused.
  { kind: "project", value: "infinitary" },
  { kind: "device name", value: "iPad" },
];

const REPORT =
  "When I reply under a merge card, the reply box loses focus after the first word and the next keys go to the window.";

describe("the feedback guard", () => {
  it("passes a report that names things by kind", () => {
    expect(guardMatches(REPORT, HELD)).toEqual([]);
    expect(
      guardMatches(
        "My clone of infinitary on a Mac shows the same thing in version 0.8.6, and on my iPad.",
        HELD,
      ),
    ).toEqual([]);
  });

  it.each([
    ["account name", "The crewmate wrote mtorres in the title.", "mtorres"],
    ["computer name", "It happens on marias-macbook-pro only.", "marias-macbook-pro"],
    ["device name", "Maria’s iPhone shows the card twice.", "Maria’s iPhone"],
    ["sign-in", "Signed in as mtorres-dev on GitHub.", "mtorres-dev"],
    ["project", "In harbor-ledger the checks never start.", "harbor-ledger"],
    ["repository", "Pushing to torres-labs/harbor-ledger fails.", "torres-labs/harbor-ledger"],
    ["secret name", "The task asked for STRIPE_LIVE_KEY twice.", "STRIPE_LIVE_KEY"],
    ["connection name", "The Clinic Gmail integration timed out.", "Clinic Gmail"],
  ] as const)("refuses a held %s", (kind, text, matched) => {
    expect(guardMatches(text, HELD)).toContainEqual({ kind, text: matched });
  });

  it("names a project folder before the account inside it", () => {
    const found = guardMatches(
      "The file at /Users/mtorres/code/harbor-ledger/README.md vanished.",
      HELD,
    );
    expect(found[0]).toEqual({ kind: "project folder", text: "/Users/mtorres/code/harbor-ledger" });
  });

  it("does not refuse a held value inside a longer word", () => {
    expect(guardMatches("The harbor-ledgers view is fine.", HELD)).toEqual([]);
  });

  it.each([
    ["email address", "Reach me at maria.torres@example.com about it.", "maria.torres@example.com"],
    ["home-folder path", "It wrote into /home/someone/notes today.", "/home/someone"],
    ["home-folder path", "It wrote into C:\\Users\\someone\\notes today.", "C:\\Users\\someone"],
    ["home-folder path", "Look at ~/Library/Logs/app.log for it.", "~/Library/Logs/app.log"],
    ["network address", "The phone pairs at 192.168.4.27 and then drops.", "192.168.4.27"],
    [
      "network address",
      "It listened on fe80::1c2b:3aff:fe4d:5e6f only.",
      "fe80::1c2b:3aff:fe4d:5e6f",
    ],
    ["key", "The log printed ghp_A1b2C3d4E5f6G7h8I9j0 in full.", "ghp_A1b2C3d4E5f6G7h8I9j0"],
    ["key", "It echoed sk-ant-api03-abcdefghijklmnop back.", "sk-ant-api03-abcdefghijklmnop"],
  ] as const)("refuses an %s", (kind, text, matched) => {
    expect(guardMatches(text, [])).toContainEqual({ kind, text: matched });
  });

  it("names each match and its kind in the refusal", () => {
    const refusal = guardRefusal(guardMatches("Signed in as mtorres-dev from 10.0.0.12.", HELD));
    expect(refusal).toContain("2 personal details");
    expect(refusal).toContain('- sign-in: "mtorres-dev"');
    expect(refusal).toContain('- network address: "10.0.0.12"');
  });
});
