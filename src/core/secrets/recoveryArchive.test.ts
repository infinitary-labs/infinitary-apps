import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearRecovery,
  openRecovery,
  type RecoveryContents,
  sealRecovery,
} from "./recoveryArchive";

// Intent: INF-1109's encrypted recovery with a separately held, independent key;
// neither a native root nor permissions may hitch a ride in the recovered data.
function contents(): RecoveryContents {
  return {
    format: 1,
    createdAt: 1700000000000,
    sourceHome: "fixture-home",
    values: [
      {
        ref: "calendar",
        label: "Planning calendar",
        discoverable: true,
        environment: "Personal",
        value: Buffer.from("ya29.invented-calendar-credential").toString("base64"),
      },
    ],
    history: [
      {
        request: "read-planning",
        intent: "planning",
        program: "Google Calendar",
        secrets: ["calendar"],
        reason: "Read planning events",
        requestedAt: 1699999999000,
        state: "completed",
        approval: "local",
      },
    ],
  };
}

describe("encrypted recovery archive", () => {
  it("round trips values and historical metadata only with its separate key", () => {
    const input = contents();
    const files = sealRecovery(input);
    expect(openRecovery(files.archive, files.key)).toEqual(input);
    expect(files.archive.includes(Buffer.from("ya29.invented-calendar-credential"))).toBe(false);
    expect(files.archive.includes(Buffer.from(input.values[0]?.value ?? ""))).toBe(false);
    expect(files.archive.includes(Buffer.from("Planning calendar"))).toBe(false);
    expect(files.archive.includes(files.key)).toBe(false);
    const another = sealRecovery(input);
    expect(openRecovery(files.archive, another.key)).toBeUndefined();
    expect(openRecovery(files.archive, randomBytes(32))).toBeUndefined();
    expect(openRecovery(files.archive, Buffer.alloc(0))).toBeUndefined();
    expect(openRecovery(files.archive, Buffer.alloc(33))).toBeUndefined();
  });

  it("refuses altered headers, authentication tags, ciphertext and truncation", () => {
    const files = sealRecovery(contents());
    // Walk every byte of the real output, rather than constructing a stand-in cipher.
    for (let offset = 0; offset < files.archive.length; offset += 1) {
      const changed = Buffer.from(files.archive);
      changed[offset] = (changed[offset] ?? 0) ^ 1;
      expect(openRecovery(changed, files.key), `changed byte ${offset}`).toBeUndefined();
    }
    expect(openRecovery(files.archive.subarray(0, -1), files.key)).toBeUndefined();
    expect(
      openRecovery(Buffer.concat([files.archive, Buffer.from("extra")]), files.key),
    ).toBeUndefined();
  });

  it("refuses ambiguous references and any permission fields instead of exporting them", () => {
    const duplicate = contents();
    const value = duplicate.values[0];
    if (!value) throw new Error("No fixture value.");
    duplicate.values.push({ ...value });
    expect(() => sealRecovery(duplicate)).toThrow("Repeated recovery reference.");
    const withAuthority = { ...contents(), rules: [{ effect: "allow" }], devices: ["phone"] };
    expect(() => sealRecovery(withAuthority)).toThrow("Invalid recovery contents.");
    expect(() =>
      sealRecovery({ ...contents(), root: "must-not-export" } as RecoveryContents),
    ).toThrow("Invalid recovery contents.");
    // INF-1109's revision: discovery links are gone, so no archive is written with them.
    const linked = contents();
    linked.values = linked.values.map((one) => ({
      ...one,
      links: [{ project: "planning", device: "local" }],
    }));
    expect(() => sealRecovery(linked)).toThrow("Invalid recovery contents.");
  });

  it("clears the decoded working copies without changing the independent archive", () => {
    const original = contents();
    const files = sealRecovery(original);
    const opened = openRecovery(files.archive, files.key);
    if (!opened) throw new Error("The fixture did not open.");
    const value = opened.values[0];
    clearRecovery(opened);
    expect(value?.value).toBe("");
    expect(opened.values).toEqual([]);
    expect(opened.history).toEqual([]);
    expect(openRecovery(files.archive, files.key)).toEqual(original);
  });
});
