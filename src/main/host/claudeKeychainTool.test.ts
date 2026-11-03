import { describe, expect, it } from "vitest";
import {
  appleToolMayRead,
  type ClaudeAclEntry,
  readClaudeThroughTrustedTool,
  toolMayReadClaudeItem,
} from "./claudeKeychainTool";

const STORE = "/tmp/test.keychain-db";
const ITEM = `keychain: "${STORE}"
version: 512
class: "genp"
attributes:
    "acct"<blob>="someone"
    "svce"<blob>="Claude Code-credentials"
access: 5 entries
    entry 0:
        authorizations (6): decrypt derive export_clear export_wrapped mac sign
        don't-require-password
        description: Claude Code-credentials
        applications (2):
            0: /Applications/Firstmate 3000.app (OK)
            1: /usr/bin/security (OK)
    entry 1:
        authorizations (1): partition_id
        don't-require-password
        description: apple-tool:
        applications: <null>
`;

// The XML plist returned as hex by SecACLCopyContents (not dump-keychain text).
function encodedPartitions(partitions: string[]): string {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Partitions</key><array>${partitions.map((value) => `<string>${value}</string>`).join("")}</array></dict></plist>`).toString(
    "hex",
  );
}

describe("Claude's trusted Apple-tool read", () => {
  it("requires the same item to trust the tool and have the Apple-tool partition", () => {
    expect(toolMayReadClaudeItem(ITEM, "someone")).toBe(true);
    expect(toolMayReadClaudeItem(ITEM.split("    entry 1:")[0] ?? "", "someone")).toBe(true);
    expect(toolMayReadClaudeItem(ITEM, "different")).toBe(false);
    expect(toolMayReadClaudeItem(ITEM + ITEM, "someone")).toBe(false);
    expect(
      toolMayReadClaudeItem(ITEM.replace("/usr/bin/security (OK)", "Other.app (OK)"), "someone"),
    ).toBe(false);
    expect(toolMayReadClaudeItem(ITEM.replace("apple-tool:", "teamid:OTHER"), "someone")).toBe(
      false,
    );
    expect(
      toolMayReadClaudeItem(ITEM.replace("don't-require-password", "require-password"), "someone"),
    ).toBe(false);
  });

  it("judges the grant from the one item, and refuses any other partition", () => {
    const decrypt: ClaudeAclEntry = {
      authorizations: ["sign", "mac", "export_wrapped", "export_clear", "derive", "decrypt"],
      requirePassword: false,
      description: "Claude Code-credentials",
      applicationPaths: ["/usr/bin/security"],
    };
    const partition = (description: string): ClaudeAclEntry => ({
      authorizations: ["partition_id"],
      requirePassword: false,
      description,
      applicationPaths: [],
    });
    expect(appleToolMayRead([decrypt])).toBe(true);
    expect(appleToolMayRead([decrypt, partition(encodedPartitions(["apple-tool:"]))])).toBe(true);
    expect(appleToolMayRead([decrypt, partition(encodedPartitions(["teamid:OTHER"]))])).toBe(false);
    expect(
      appleToolMayRead([
        decrypt,
        partition(encodedPartitions(["apple-tool:"])),
        partition(encodedPartitions(["apple-tool:"])),
      ]),
    ).toBe(false);
    for (const description of [
      "apple-tool:",
      encodedPartitions(["apple-tool:", "teamid:OTHER"]),
      encodedPartitions([]),
      encodedPartitions(["apple-tool:", "apple-tool:"]),
      Buffer.from(
        '<plist version="1.0"><dict></dict><key>Partitions</key><array><string>apple-tool:</string></array></plist>',
      ).toString("hex"),
      "not hex",
      "0",
      encodedPartitions(["apple-tool:"]).slice(0, -2),
      Buffer.from(
        '<plist version="1.0"><dict><key>Partitions</key><array><string>apple-tool:</string></array></dict>',
      ).toString("hex"),
      Buffer.from(
        '<plist version="1.0"><dict><array><key>Partitions</key><string>apple-tool:</string></array></dict></plist>',
      ).toString("hex"),
    ]) {
      expect(appleToolMayRead([decrypt, partition(description)]), description).toBe(false);
    }
    expect(appleToolMayRead([{ ...decrypt, requirePassword: true }])).toBe(false);
    expect(appleToolMayRead([{ ...decrypt, applicationPaths: ["/Applications/Other.app"] }])).toBe(
      false,
    );
    expect(
      appleToolMayRead([{ ...decrypt, authorizations: [...decrypt.authorizations, "encrypt"] }]),
    ).toBe(false);
  });

  it("reads the value only, and never lists the other saved passwords", async () => {
    const calls: string[][] = [];
    const run = (args: string[]) => {
      calls.push(args);
      if (args[0] === "dump-keychain") throw new Error("the read listed the keychain");
      return " dummy \n";
    };
    expect(await readClaudeThroughTrustedTool("someone", STORE, async (args) => run(args))).toEqual(
      { kind: "value", value: " dummy " },
    );
    expect(calls).toEqual([
      ["find-generic-password", "-a", "someone", "-s", "Claude Code-credentials", "-w", STORE],
    ]);
  });

  it("INF-2321: decodes Apple's hexadecimal output for a multiline Claude credential", async () => {
    const credential = JSON.stringify(
      { claudeAiOauth: { accessToken: "not-a-real-credential" } },
      null,
      2,
    );
    expect(
      await readClaudeThroughTrustedTool(
        "someone",
        STORE,
        async () => `${Buffer.from(credential).toString("hex")}\n`,
      ),
    ).toEqual({ kind: "value", value: credential });
  });

  it("reports a tool that ran out of time as incomplete, not refused", async () => {
    const run = async () => {
      throw Object.assign(new Error("Command failed"), { killed: true });
    };
    expect(await readClaudeThroughTrustedTool("someone", STORE, run)).toEqual({
      kind: "incomplete",
    });
  });
});
