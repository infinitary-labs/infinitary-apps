import { COMPUTER } from "@shared/deviceNames";
import { type DeviceInvite, type DeviceInviteRequest, deviceJoinedLine } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { PANEL_WORDS, WAYS_WORDS } from "../../src/renderer/src/settings/devicesWords";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  afterNextFrame,
  button,
  clipboard,
  gone,
  openDevices,
  problemLine,
  refusedAs,
  shown,
  unansweredOf,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The link panel in Settings -> Devices (docs/devices.md, "The link"; design
 * skill components/devices/DevicesTab): a link or a command exists only
 * after the person's own click, one at a time, and lives in the panel alone.
 * It copies, counts down, stops, turns to a joined note when a device uses
 * it, and reads as expired once its thirty minutes pass. Guardrail for
 * restructuring the tab (INF-2625's plan, the devices piece): the panel's
 * store and the container's link actions are reached by no unit test.
 */

/** A link the home makes, in the shape `PAIRING_LINK_PREFIX` opens. */
const linkOf = (n: number) =>
  `infinitary://join?as=mac&at=192.168.1.20%3A47623&key=${"K".repeat(43)}&code=${String(n).repeat(43)}`;

/** The command for another user on this Mac carries the link after the app's own `work join`. */
const userCommandOf = (link: string) =>
  `'/Applications/Infinitary.app/Contents/MacOS/Infinitary' work join '${link}'`;

const THIRTY_MINUTES = 30 * 60_000;

test("the link panel makes, copies, stops, joins and expires one link at a time", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  const copies = clipboard();
  bridge.answer("inf:devices:list", []);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:stop", { ok: true });
  // + A computer opens the address form, which looks for computers nearby while it is open.
  bridge.answer("inf:devices:nearby", (watching: boolean) => ({
    state: watching ? "looking" : "off",
    user: watching ? "kun" : null,
    macs: [],
  }));
  let made = 0;
  /** How long the next link lives from when the home makes it; the home's own is thirty minutes. */
  let lives = THIRTY_MINUTES;
  let refuseNext: string | null = null;
  bridge.answer("inf:devices:invite", (request: DeviceInviteRequest): DeviceInvite => {
    if (refuseNext) {
      const reason = refuseNext;
      refuseNext = null;
      throw refusedAs("inf:devices:invite", reason);
    }
    made += 1;
    const link = linkOf(made);
    const expiresAt = Date.now() + lives;
    lives = THIRTY_MINUTES;
    if (request.command === "another-user")
      return {
        id: `link-${made}`,
        link,
        kind: request.kind,
        expiresAt,
        command: { for: "another-user", text: userCommandOf(link) },
      };
    if (request.command === "another-mac")
      return {
        id: `link-${made}`,
        link,
        kind: request.kind,
        expiresAt,
        command: {
          for: "another-mac",
          text: `sh -c "$(curl -fsSL http://192.168.1.20:47623/join)" '${link}'`,
        },
      };
    return { id: `link-${made}`, link, kind: request.kind, expiresAt };
  });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();

  // Section: + A computer, then a link to paste there under its address form, opens the panel with it.
  {
    await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
    const ways = await shown("[data-device-other-ways]");
    await userEvent.click(button(ways, m.settingsDevicesAddByLink()));
    const panel = await shown('[data-panel-state="open"]');
    await gone("[data-device-address-question]");
    expect(bridge.requests("inf:devices:invite")).toEqual([[{ kind: "mac" }]]);
    expect(panel.getAttribute("data-panel-holds")).toBe("link");
    expect(panel.querySelector("[data-device-link]")?.textContent).toBe(linkOf(1));
    expect(panel.textContent).toContain(PANEL_WORDS.link.label);
    expect(panel.textContent).toMatch(/works once · (?:30:00|29:\d\d) left/);
  }

  // Section: Copy writes the link, reads Copied, and reads Copy link again.
  {
    const panel = await shown('[data-panel-state="open"]');
    await userEvent.click(button(panel, PANEL_WORDS.link.copy));
    expect(copies.written).toEqual([linkOf(1)]);
    await expect.poll(() => button(panel, "Copied").textContent).toBe("Copied");
    await expect
      .poll(() => panel.querySelector(".fm-devices-panel-line button")?.textContent, {
        timeout: 4000,
      })
      .toBe(PANEL_WORDS.link.copy);
  }

  // Section: a refused copy says to copy it by hand, and keeps the link on screen.
  {
    const panel = await shown('[data-panel-state="open"]');
    copies.refuse();
    await userEvent.click(button(panel, PANEL_WORDS.link.copy));
    await expect
      .poll(() => panel.querySelector('[role="alert"]')?.textContent)
      .toBe("Could not copy the link. Select it and copy it yourself.");
    expect(panel.querySelector("[data-device-link]")?.textContent).toBe(linkOf(1));
  }

  // Section: a new one closes the one it replaces first: A phone stops link 1.
  {
    await userEvent.click(devices.querySelector('[data-device-add="phone"]') as HTMLElement);
    await expect
      .poll(
        () => document.querySelector('[data-panel-state="open"] [data-device-link]')?.textContent,
      )
      .toBe(linkOf(2));
    expect(bridge.requests("inf:devices:stop")).toEqual([["link-1"]]);
    expect(bridge.requests("inf:devices:invite").at(-1)).toEqual([{ kind: "mac", phone: true }]);
    const panel = document.querySelector('[data-panel-state="open"]') as HTMLElement;
    expect(panel.textContent).toContain(PANEL_WORDS.phone.label);
  }

  // Section: Stop it closes the link at the home, and the panel goes.
  {
    const panel = await shown('[data-panel-state="open"]');
    await userEvent.click(button(panel, "Stop it"));
    await gone("[data-panel-state]");
    expect(bridge.requests("inf:devices:stop")).toEqual([["link-1"], ["link-2"]]);
  }

  // Section: another user's command turns to the joined note when that user
  // joins, and the note goes once that user signs in to a subscription.
  {
    await userEvent.click(devices.querySelector('[data-device-add="user"]') as HTMLElement);
    const panel = await shown('[data-panel-state="open"]');
    expect(bridge.requests("inf:devices:invite").at(-1)).toEqual([
      { kind: "work", command: "another-user" },
    ]);
    expect(panel.getAttribute("data-panel-holds")).toBe("command");
    expect(panel.querySelector("[data-device-link]")?.textContent).toBe(userCommandOf(linkOf(3)));
    const joined = {
      type: "device_joined",
      deviceId: "builder",
      name: "MacBook Pro",
      kind: "work",
      user: "builder",
      onThisMac: true,
    } as const;
    bridge.push("inf:event", joined);
    const note = await shown('[data-panel-state="joined"]');
    expect(note.textContent).toContain(deviceJoinedLine(joined));
    expect(note.textContent).toContain(
      "Give it a project in Projects when you want it to run work.",
    );
    bridge.push("inf:event", {
      type: "device_signed_in",
      deviceId: "mini",
      who: "Mac mini",
      provider: "Codex",
    });
    await afterNextFrame();
    expect(document.querySelector('[data-panel-state="joined"]')).not.toBeNull();
    bridge.push("inf:event", {
      type: "device_signed_in",
      deviceId: "builder",
      who: "builder",
      provider: "Codex",
    });
    await gone("[data-panel-state]");
  }

  // Section: Done puts away a joined note of a Mac that found this one again.
  {
    await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
    await userEvent.click(
      button(await shown("[data-device-other-ways]"), m.settingsDevicesAddByCommand()),
    );
    await shown('[data-panel-state="open"]');
    expect(bridge.requests("inf:devices:invite").at(-1)).toEqual([
      { kind: "mac", command: "another-mac" },
    ]);
    const again = {
      type: "device_joined",
      deviceId: "mini",
      name: "Mac mini",
      kind: "mac",
      again: true,
    } as const;
    bridge.push("inf:event", again);
    const note = await shown('[data-panel-state="joined"]');
    expect(note.textContent).toContain(deviceJoinedLine(again));
    expect(note.textContent).not.toContain("Give it a project");
    await userEvent.click(button(note, "Done"));
    await gone("[data-panel-state]");
  }

  // Section: a link that runs out reads as expired, and Make a new one makes
  // the same kind again.
  {
    // A link whose thirty minutes ran out before the panel reads it: the
    // panel compares its end with the clock as it opens, so no time passes.
    lives = -THIRTY_MINUTES;
    await userEvent.click(devices.querySelector('[data-device-add="phone"]') as HTMLElement);
    const expired = await shown('[data-panel-state="expired"]');
    expect(expired.textContent).toContain("The link expired before any phone used it.");
    expect(expired.textContent).toContain("Make a new one when the phone is ready.");
    const before = bridge.requests("inf:devices:invite").length;
    await userEvent.click(button(expired, "Make a new one"));
    await shown('[data-panel-state="open"]');
    expect(bridge.requests("inf:devices:invite").slice(before)).toEqual([
      [{ kind: "mac", phone: true }],
    ]);
  }

  // Section: Copy a command under where devices find this computer makes
  // one, copies it, and opens the panel already reading Copied.
  {
    const ways = await shown("[data-device-ways]");
    await userEvent.click(button(ways, WAYS_WORDS.copyCommand));
    await expect
      .poll(() => bridge.requests("inf:devices:invite").at(-1))
      .toEqual([{ kind: "mac", command: "another-mac" }]);
    const panel = await shown('[data-panel-state="open"][data-panel-holds="command"]');
    expect(copies.written.at(-1)).toBe(panel.querySelector("[data-device-link]")?.textContent);
    expect(button(panel, "Copied").textContent).toBe("Copied");
    expect(panel.textContent).toContain(PANEL_WORDS.command.label);
  }
  refuseNext = `Could not make a link: ${COMPUTER.one} has no address on any network.`;
  await userEvent.click(devices.querySelector('[data-device-add="phone"]') as HTMLElement);
  await expect
    .poll(problemLine)
    .toBe(`Could not make a link: ${COMPUTER.one} has no address on any network.`);

  expect(unansweredOf(bridge)).toEqual([]);
});
