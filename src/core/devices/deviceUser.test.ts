import { describe, expect, it } from "vitest";
import { readWhoamiSid, thisDeviceUser } from "./deviceUser";

/**
 * Who a computer joins a home as (docs/devices.md, "Joining"; INF-4260 piece
 * 9): a Windows PC once sent Node's user number, -1, which no home took.
 */

/** What `whoami /user /fo csv /nh` prints on Windows 11 for a local user whose name has a space. */
const WHOAMI = '"desktop-7qk2m1\\kun chen","S-1-5-21-3623811015-3361044348-30300820-1001"\r\n';

describe("the user a computer joins as", () => {
  it("joins from Windows by its security identifier, under the name with its space", async () => {
    const user = await thisDeviceUser({
      platform: "win32",
      user: () => ({ username: "Kun Chen", uid: -1 }),
      whoami: async () => WHOAMI,
    });
    expect(user).toEqual({ name: "Kun Chen", sid: "S-1-5-21-3623811015-3361044348-30300820-1001" });
  });

  it("does not join from Windows when its identifier cannot be read", async () => {
    const user = () => ({ username: "Kun Chen", uid: -1 });
    expect(await thisDeviceUser({ platform: "win32", user, whoami: async () => null })).toBeNull();
    expect(readWhoamiSid("ERROR: Access is denied.\r\n")).toBeNull();
  });

  it("joins from a Mac or Linux by the number of the user it runs as", async () => {
    const user = await thisDeviceUser({
      platform: "darwin",
      user: () => ({ username: "sam", uid: 501 }),
      getuid: () => 502,
      whoami: async () => {
        throw new Error("a Mac never asks whoami");
      },
    });
    expect(user).toEqual({ name: "sam", uid: 502 });
  });
});
