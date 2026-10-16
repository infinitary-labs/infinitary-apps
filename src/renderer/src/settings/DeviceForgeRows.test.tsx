import type { DeviceSignIns } from "@shared/signIns";
import { describe, expect, it } from "vitest";
import { deviceForgeRows, deviceForgeRowView } from "./DeviceForgeRows";

/**
 * Settings -> Projects, "Where your projects live", for each computer that
 * runs work (design skill components/devices/SignInOnAMac, "GitHub on
 * another device"): a row per computer and host, its words, and the code to
 * read in the aside under it.
 */

const GITHUB = { host: "github.com", name: "GitHub" };

function computer(over: Partial<DeviceSignIns> & Pick<DeviceSignIns, "deviceId">): DeviceSignIns {
  return {
    name: "Mac mini",
    onThisMac: false,
    inReach: true,
    signIns: { providers: [], accounts: [], quota: null, forges: { signIns: [], hosts: [GITHUB] } },
    ...over,
  };
}

describe("a computer's own GitHub row", () => {
  it("reads 'GitHub · login' over where it runs and what it does, in its health's tone", () => {
    const signedIn = (state: "ok" | "needs_reauth" | "unavailable") =>
      deviceForgeRows([
        computer({
          deviceId: "builder",
          name: "This Mac",
          user: "builder",
          onThisMac: true,
          signIns: {
            providers: [],
            accounts: [],
            quota: null,
            forges: {
              signIns: [{ host: "github.com", name: "GitHub", login: "octo", state, since: 1 }],
              hosts: [GITHUB],
            },
          },
        }),
      ])[0];
    const ok = signedIn("ok");
    expect(ok && deviceForgeRowView(ok)).toEqual({
      tone: "ok",
      label: "signed in",
      title: "GitHub · octo",
      line: "Running as Builder · clones and pushes its own work",
      reauth: false,
    });
    const refused = signedIn("needs_reauth");
    expect(refused && deviceForgeRowView(refused)).toMatchObject({ tone: "danger", reauth: true });
    const away = signedIn("unavailable");
    expect(away && deviceForgeRowView(away)).toMatchObject({
      tone: "ring",
      label: "signed in · could not reach GitHub",
    });
  });

  it("says a computer is out of reach, and draws nothing for one that never said its hosts", () => {
    const rows = deviceForgeRows([
      computer({ deviceId: "mini", inReach: false }),
      computer({ deviceId: "older", signIns: { providers: [], accounts: [], quota: null } }),
      computer({ deviceId: "silent", signIns: null }),
    ]);
    expect(rows.map((row) => row.deviceId)).toEqual(["mini"]);
    expect(rows[0] && deviceForgeRowView(rows[0]).line).toBe(
      "not signed in to GitHub · out of reach",
    );
  });

  it("says a computer whose connection is being made is connecting", () => {
    const [row] = deviceForgeRows([
      computer({ deviceId: "mini", inReach: false, connecting: true }),
    ]);
    expect(row && deviceForgeRowView(row).line).toBe("not signed in to GitHub · connecting");
  });
});
