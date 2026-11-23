import { describe, expect, it } from "vitest";
import { CONNECTION_PORT } from "./connection";
import { type HomeAtStarted, homeAtRefusalLines, homeConnectLines } from "./homeAt";
import * as m from "./i18n/messages.generated";

/**
 * INF-6207's approved plan, part 2, "Stops": every stop says what stopped
 * it and what to try, ending at setting it up with commands where asking
 * again cannot help, and a stop after the first mate started there says it
 * keeps running.
 */

const STARTED: HomeAtStarted = {
  started: true,
  address: "sam@studio",
  name: "studio",
  lingerOff: false,
  waitsForLogin: false,
  private: true,
};

describe("a stop's words", () => {
  it("sends the person to the commands where asking again cannot help", () => {
    for (const refused of ["root", "no-systemd", "not-started"] as const)
      expect(homeAtRefusalLines({ refused, step: "look", name: "studio" }, "sam@studio")).toEqual([
        expect.stringContaining("studio"),
        m.devicesHomeCommandsInstead(),
      ]);
    // Where Remote Login's own words would send the person to add it with a command,
    // this screen's two ways stand instead.
    const [, then] = homeAtRefusalLines(
      { refused: "unreachable", step: "key", reach: { step: "key", port: 22 } },
      "sam@studio",
    );
    expect(then).toContain(m.devicesHomeOrCommands());
    expect(homeAtRefusalLines({ refused: "password-off", step: "sign-in" }, "sam@studio")[1]).toBe(
      m.devicesHomeOrCommands(),
    );
  });

  it("says the first mate keeps running when Cancel came after it started", () => {
    expect(
      homeAtRefusalLines({ refused: "cancelled", step: "start", running: true }, "sam@studio")[0],
    ).toBe(m.devicesHomeKeepsRunning({ computer: "sam@studio" }));
    expect(homeAtRefusalLines({ refused: "cancelled", step: "send" }, "sam@studio")[0]).toBe(
      m.devicesHomeCancelled({ computer: "sam@studio" }),
    );
  });
});

describe("connecting from here after it started", () => {
  it("names no private address first, then a firewall with its one command, then its port", () => {
    expect(homeConnectLines({ ...STARTED, private: false }, "studio").lines[0]).toBe(
      m.devicesHomeNoPrivate({ computer: "studio" }),
    );
    const firewall = homeConnectLines(
      { ...STARTED, firewall: { name: "ufw", port: CONNECTION_PORT } },
      "studio",
    );
    expect(firewall.lines[0]).toBe(m.devicesHomeFirewall({ computer: "studio" }));
    expect(firewall.way).toContain(String(CONNECTION_PORT));
    expect(homeConnectLines(STARTED, "studio").lines[0]).toBe(
      m.devicesHomeUnreachable({ computer: "studio", port: String(CONNECTION_PORT) }),
    );
  });
});
