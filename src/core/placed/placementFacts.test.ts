import { placementSnapshotSchema } from "@shared/placement";
import { describe, expect, it } from "vitest";
import { windowsMachineIdentity } from "./placementFacts";

/**
 * INF-4650: a task on a Windows PC waited on "physical computer could not be
 * identified", since the app read no identity there. Every account on the PC
 * reads the one MachineGuid Windows wrote at install, and this is how
 * `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` prints it,
 * line endings included. The GUIDs stand in for two PCs' own.
 */
const regAnswer = (guid: string) =>
  `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${guid}\r\n\r\n`;

describe("a Windows PC's physical computer", () => {
  it("is its MachineGuid as reg prints it, one identity per PC in the form a start saves", () => {
    const identity = windowsMachineIdentity(regAnswer("5b1f3c9e-7a2d-4e68-b0c4-9d8e2f1a6c37"));
    expect(placementSnapshotSchema.shape.physicalComputerId.safeParse(identity).success).toBe(true);
    expect(windowsMachineIdentity(regAnswer("e8a40d6b-2c97-41f3-8b5e-0f6a7d3c9b12"))).not.toBe(
      identity,
    );
  });
});
