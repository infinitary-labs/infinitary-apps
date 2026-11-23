import { COMPUTER } from "@shared/deviceNames";
import type { DeviceView } from "@shared/devices";
import * as m from "@shared/i18n/messages.generated";
import type { InvokeResponse } from "@shared/ipc";
import type { NearbyMacsView } from "@shared/nearbyMacs";
import { addressAtPort, type RemoteLoginAddOptions, remoteLoginWords } from "@shared/remoteLogin";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  afterNextFrame,
  button,
  gone,
  held,
  LISTED_AT,
  openDevices,
  refusedAs,
  selectDevice,
  shown,
  unansweredOf,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Adding a computer by its address in Settings -> Devices (docs/devices.md,
 * "Adding a computer by its address", "Macs nearby", "The password, once";
 * design skill components/devices/AddAMac). The person types or picks the
 * address, says the check line is that computer, types its user's password
 * once when the key is not let in, and the row follows each step the home
 * says until it joins. A refusal keeps the address and says why; a Cancel
 * during a try ignores that try. Guardrail for restructuring the tab
 * (INF-2625's plan, the devices piece): the container's add flow, its
 * asides and the setup store are reached by no unit test.
 */

/** The address a pick fills in: this Mac's user at the nearby Mac's name. */
const USER = "kun";
const NEARBY_MAC = { name: "Mac Studio", at: "studio.local" } as const;
const PICKED = `${USER}@${NEARBY_MAC.at}`;
/** The check line a Mac's host key reads as. */
const CHECK_LINE = "ED25519 SHA256:4mF1o0bKqv3n2WZ5c9yTt2kq8hQe8nV7rS1aLm0pXcU";

const JOINED: DeviceView = {
  id: "studio",
  kind: "mac",
  name: NEARBY_MAC.name,
  pairedAt: LISTED_AT,
  user: USER,
  onThisMac: false,
  remoteLogin: PICKED,
  inReach: true,
  seenAt: LISTED_AT,
  connectedAt: LISTED_AT,
  tasks: 0,
  runs: [],
  ssh: { state: "connected" },
};

type AddAnswer = InvokeResponse<"inf:devices:add">;

test("adding a computer by its address follows each step, keeps a refused address, and ignores a cancelled try", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:list", []);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  const looks: ReturnType<typeof held<NearbyMacsView>>[] = [];
  bridge.answer("inf:devices:nearby", (watching) => {
    if (!watching) return { state: "off", user: null, macs: [] };
    const look = held<NearbyMacsView>();
    looks.push(look);
    return look.promise;
  });
  const adds: ReturnType<typeof held<AddAnswer>>[] = [];
  bridge.answer("inf:devices:add", () => {
    const add = held<AddAnswer>();
    adds.push(add);
    return add.promise;
  });
  const addRequests = () => bridge.requests("inf:devices:add");
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();

  const openAddress = async () => {
    await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
    return shown("[data-device-address-question]");
  };
  const field = () => document.querySelector<HTMLInputElement>("#device-remote-login");

  // Section: + A computer opens the address form at once, with the caret in its field and the
  // link and the command under it, each reached with Tab (INF-4926's plan, lead =
  // address-form-first).
  {
    const aside = await openAddress();
    expect(document.querySelector("[data-device-chooser]")).toBeNull();
    await expect.poll(() => document.activeElement).toBe(field());
    expect(aside.textContent).toContain(m.settingsDevicesAddressKeeps());
    const ways = aside.querySelector("[data-device-other-ways]") as HTMLElement;
    expect(ways.textContent).toContain(m.settingsDevicesAddOtherWays());
    const otherWays: [string, string][] = [
      [m.settingsDevicesAddByLink(), m.settingsDevicesAddByLinkWhen()],
      [m.settingsDevicesAddByCommand(), m.settingsDevicesAddByCommandWhen()],
    ];
    for (const [way, when] of otherWays) {
      const choice = button(ways, way);
      expect(choice.parentElement?.textContent).toContain(when);
      choice.focus();
      expect(document.activeElement).toBe(choice);
      expect(choice.tabIndex).toBe(0);
    }
    field()?.focus();
  }

  // Section: the address form looks for Macs nearby, and an older answer to the
  // look never covers a newer push.
  {
    const aside = document.querySelector("[data-device-address-question]") as HTMLElement;
    await expect.poll(() => bridge.requests("inf:devices:nearby")).toEqual([[true]]);
    bridge.push("inf:devices:nearby", { state: "looking", user: USER, macs: [NEARBY_MAC] });
    looks[0]?.resolve({ state: "looking", user: USER, macs: [] });
    const row = await shown(`[data-device-nearby-mac="${NEARBY_MAC.at}"]`);
    expect(row.textContent).toContain(NEARBY_MAC.name);
    expect(row.textContent).toContain(PICKED);
    // The older answer arrived after the push; once the window drew again, the list still holds the push.
    await afterNextFrame();
    expect(aside.querySelector(`[data-device-nearby-mac="${NEARBY_MAC.at}"]`)).not.toBeNull();
  }
  await userEvent.click(
    document.querySelector(`[data-device-nearby-mac="${NEARBY_MAC.at}"]`) as HTMLElement,
  );
  await expect.poll(() => field()?.value).toBe(PICKED);
  await expect.poll(() => document.activeElement).toBe(field());
  expect([field()?.selectionStart, field()?.selectionEnd]).toEqual([0, USER.length]);

  // Section: Add it with a port asks the check line first, and nothing is
  // sent; the address aside closes and the looking stops.
  const address = addressAtPort(PICKED, "2222") as string;
  {
    await userEvent.fill(
      document.querySelector(
        '[data-device-address-question] input[aria-label="Port"]',
      ) as HTMLElement,
      "2222",
    );
    const aside = document.querySelector("[data-device-address-question]") as HTMLElement;
    await userEvent.click(button(aside, "Add it"));
    expect(addRequests()).toEqual([[address, {}]]);
    adds[0]?.resolve({ asks: "confirm", address, line: CHECK_LINE });
    const confirm = await shown("[data-device-confirm-question]");
    await gone("[data-device-address-question]");
    expect(confirm.textContent).toContain(remoteLoginWords.confirmQuestion(address)[0]);
    expect(confirm.querySelector("[data-device-check-line]")?.textContent).toBe(CHECK_LINE);
    expect(document.querySelector("[data-device-adding]")).toBeNull();
    await expect.poll(() => bridge.requests("inf:devices:nearby").at(-1)).toEqual([false]);
  }

  // Section: Cancel on the check line goes back to the address, kept as typed.
  {
    const confirm = await shown("[data-device-confirm-question]");
    expect(document.activeElement).toBe(button(confirm, "Cancel"));
    await userEvent.click(button(confirm, "Cancel"));
    await shown("[data-device-address-question]");
    expect(field()?.value).toBe(PICKED);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-device-address-question] input[aria-label="Port"]',
      )?.value,
    ).toBe("2222");
    await userEvent.click(
      button(document.querySelector("[data-device-address-question]") as HTMLElement, "Add it"),
    );
    adds[1]?.resolve({ asks: "confirm", address, line: CHECK_LINE });
    await shown("[data-device-confirm-question]");
  }

  // Section: the yes reaches it with the key, then asks the user's password once.
  {
    const confirm = await shown("[data-device-confirm-question]");
    await userEvent.click(button(confirm, `This is the ${COMPUTER.one}`));
    expect(addRequests().at(-1)).toEqual([address, { confirm: CHECK_LINE }]);
    const adding = await shown(`[data-device-adding="${address}"]`);
    expect(adding.textContent).toContain(remoteLoginWords.reachingRow(address));
    adds[2]?.resolve({ asks: "password", address, user: USER });
    const password = await shown("[data-device-password-question]");
    await gone("[data-device-adding]");
    expect(password.textContent).toContain(remoteLoginWords.passwordQuestion(address)[0]);
    expect(button(password, "Add it").disabled).toBe(true);
  }

  // Section: Cancel on the password goes back to the address; asked again,
  // the password goes on one call, lets the key in, and the row follows the
  // setup until the computer joined.
  {
    await userEvent.click(button(await shown("[data-device-password-question]"), "Cancel"));
    await shown("[data-device-address-question]");
    expect(field()?.value).toBe(PICKED);
    await userEvent.click(
      button(document.querySelector("[data-device-address-question]") as HTMLElement, "Add it"),
    );
    adds[3]?.resolve({ asks: "password", address, user: USER });
    const password = await shown("[data-device-password-question]");
    const input = password.querySelector<HTMLInputElement>(
      'input[type="password"]',
    ) as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe(remoteLoginWords.passwordField(USER));
    await userEvent.fill(input, "correct horse");
    await userEvent.click(button(password, "Add it"));
    expect(addRequests().at(-1)).toEqual([address, { password: "correct horse" }]);
    await gone("[data-device-password-question]");
    const adding = await shown(`[data-device-adding="${address}"]`);
    expect(adding.textContent).toContain(remoteLoginWords.lettingInRow(address));
    bridge.push("inf:event", {
      type: "device_setup",
      address,
      doing: "add",
      stage: "setting-up",
      name: NEARBY_MAC.name,
      text: remoteLoginWords.settingUp(NEARBY_MAC.name),
      tone: "info",
    });
    await expect
      .poll(() => document.querySelector(`[data-device-adding="${address}"]`)?.textContent)
      .toContain(remoteLoginWords.settingUpRow(NEARBY_MAC.name));
    expect(document.querySelector(`[data-device-adding="${address}"]`)?.textContent).toContain(
      NEARBY_MAC.name,
    );
    bridge.push("inf:event", {
      type: "device_setup",
      address,
      doing: "add",
      stage: "setting-up",
      name: NEARBY_MAC.name,
      text: remoteLoginWords.sendingRow(NEARBY_MAC.name, 48 * 1024 * 1024),
      tone: "info",
      copy: { state: "sending", sent: 48 * 1024 * 1024 },
    });
    await expect
      .poll(() => document.querySelector(`[data-device-adding="${address}"]`)?.textContent)
      .toContain(remoteLoginWords.sendingRow(NEARBY_MAC.name, 48 * 1024 * 1024));
    const joined = { ...JOINED, remoteLogin: address };
    bridge.push("inf:devices", [joined]);
    adds[4]?.resolve(joined);
    await gone("[data-device-adding]");
    await selectDevice(joined.id);
    await shown(`[data-device-row="${joined.id}"]`);
  }

  // Section: a refusal keeps the address in the field and says why, with Try again.
  const far = "pat@far.local";
  const refusal = remoteLoginWords.refused("unreachable", { address: far });
  {
    const aside = await openAddress();
    expect(field()?.value).toBe("");
    await userEvent.fill(field() as HTMLInputElement, far);
    await userEvent.click(button(aside, "Add it"));
    adds[5]?.reject(refusedAs("inf:devices:add", refusal.join("\n")));
    await expect
      .poll(() =>
        [...document.querySelectorAll("[data-device-address-refusal]")].map(
          (line) => line.textContent,
        ),
      )
      .toEqual(refusal);
    expect(field()?.value).toBe(far);
    expect(document.querySelector(`[data-device-adding="${far}"]`)).toBeNull();
  }

  // Section: Cancel during Try again ignores that try's refusal.
  {
    const aside = await shown("[data-device-address-question]");
    await userEvent.click(button(aside, "Try again"));
    expect(addRequests().at(-1)).toEqual([far, {}]);
    await userEvent.click(button(aside, "Cancel"));
    await gone("[data-device-address-question]");
    adds[6]?.reject(refusedAs("inf:devices:add", refusal.join("\n")));
    await afterNextFrame();
    expect(document.querySelector("[data-device-address-question]")).toBeNull();
    expect(document.querySelector("[data-device-address-refusal]")).toBeNull();
  }

  // Section: a Mac whose user runs another first mate's work asks once, and
  // the yes adds it, leaving that one.
  {
    const aside = await openAddress();
    await userEvent.fill(field() as HTMLInputElement, far);
    await userEvent.click(button(aside, "Add it"));
    adds[7]?.resolve({ asks: "leave", address: far, name: "Mac mini" });
    const leave = await shown(`[data-device-leave-question="${far}"]`);
    await gone("[data-device-address-question]");
    for (const line of remoteLoginWords.leaveQuestion({ address: far, name: "Mac mini" }))
      expect(leave.textContent).toContain(line);
    expect(document.activeElement).toBe(button(leave, "Cancel"));
    await userEvent.click(button(leave, "Leave it and add"));
    const options: RemoteLoginAddOptions = { leave: true };
    expect(addRequests().at(-1)).toEqual([far, options]);
    await gone("[data-device-leave-question]");
    adds[8]?.resolve({ ...JOINED, id: "far", name: "Mac mini", remoteLogin: far });
    await gone("[data-device-adding]");
  }

  expect(adds).toHaveLength(9);
  expect(unansweredOf(bridge)).toEqual([]);
});
