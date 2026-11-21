import { type DeviceView, deviceLabel } from "@shared/devices";
import type { InvokeResponse } from "@shared/ipc";
import { remoteLoginWords } from "@shared/remoteLogin";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { useShellStore } from "../../src/renderer/src/app/store";
import { removeLines } from "../../src/renderer/src/settings/devicesWords";
import { fakeBridge } from "./bridge";
import {
  ADDRESSES,
  AIR,
  afterNextFrame,
  button,
  gone,
  held,
  MINI,
  openDevices,
  problemLine,
  refusedAs,
  rowAction,
  STUDIO,
  selectDevice,
  shown,
  unansweredOf,
} from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * A computer's row in Settings -> Devices (docs/devices.md, "Updating",
 * "Changing its address", "Through the home's SSH", "Remove"; design skill
 * components/devices/DevicesTab): Update, with its password asked once even
 * beside the address question; Change address and Remove from the row's ⋯
 * menu; Try again; Keep it; a card's Remove that lands here; and the problem line, where a "could
 * not reach" refusal goes once that computer answers again at the address
 * tried while every other refusal stays. Guardrail for restructuring the
 * tab (INF-2625's plan, the devices piece): the container's row actions and
 * its refusal state are reached by no unit test.
 */

type UpdateAnswer = InvokeResponse<"inf:devices:update">;
type MoveAnswer = InvokeResponse<"inf:devices:change-address">;

const row = (id: string) => document.querySelector<HTMLElement>(`[data-device-row="${id}"]`);

test("a computer's row updates, moves, tries again and removes, and a reach refusal goes once it answers", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  let listed: DeviceView[] = [AIR, MINI, STUDIO];
  bridge.answer("inf:devices:list", () => listed);
  bridge.answer("inf:devices:addresses", ADDRESSES);
  bridge.answer("inf:devices:sign-ins", []);
  bridge.answer("inf:devices:nearby", (watching) => ({
    state: watching ? "looking" : "off",
    user: null,
    macs: [],
  }));
  const updates: ReturnType<typeof held<UpdateAnswer>>[] = [];
  bridge.answer("inf:devices:update", () => {
    const update = held<UpdateAnswer>();
    updates.push(update);
    return update.promise;
  });
  const moves: ReturnType<typeof held<MoveAnswer>>[] = [];
  bridge.answer("inf:devices:change-address", () => {
    const move = held<MoveAnswer>();
    moves.push(move);
    return move.promise;
  });
  let refuseTry: string | null = null;
  bridge.answer("inf:devices:try-again", () => {
    if (refuseTry) throw refusedAs("inf:devices:try-again", refuseTry);
    return { tried: 1 };
  });
  let refuseRemove: string | null = null;
  bridge.answer("inf:devices:remove", (id, when) => {
    if (refuseRemove) throw refusedAs("inf:devices:remove", refuseRemove);
    const device = listed.find((each) => each.id === id) as DeviceView;
    if (when === "when-back") {
      listed = listed.map((each) => (each.id === id ? { ...each, removal: "when-back" } : each));
      return { ...device, removal: "when-back" };
    }
    listed = listed.filter((each) => each.id !== id);
    return device;
  });
  bridge.answer("inf:devices:keep", (id) => {
    listed = listed.map((each) => {
      if (each.id !== id) return each;
      const { removal: _, ...kept } = each;
      return kept;
    });
    return listed.find((each) => each.id === id) as DeviceView;
  });
  await openSize();
  await openWindow(bridge);
  const devices = await openDevices();
  const mini = deviceLabel(MINI);
  const studio = deviceLabel(STUDIO);
  for (const device of [AIR, MINI, STUDIO]) await shown(`[data-device-select="${device.id}"]`);
  expect(row("this-mac")).not.toBeNull();
  await selectDevice("mini");

  // Section: Update asks the user's password beside an open address question,
  // and Cancel on it leaves that question open.
  {
    await userEvent.click(devices.querySelector('[data-device-add="mac"]') as HTMLElement);
    await userEvent.click(button(await shown("[data-device-chooser]"), "By its address"));
    await shown("[data-device-address-question]");
    await userEvent.click(button(row("mini") as HTMLElement, `Update ${mini}`));
    expect(bridge.requests("inf:devices:update")).toEqual([["mini", {}]]);
    const question = {
      asks: "password",
      for: "update",
      deviceId: "mini",
      address: "sam@mini.local",
      user: "sam",
    } as const;
    updates[0]?.resolve(question);
    const password = await shown('[data-device-password-question="sam@mini.local"]');
    expect(password.textContent).toContain(
      remoteLoginWords.passwordUpdateQuestion("sam@mini.local")[0],
    );
    expect(button(password, "Update").disabled).toBe(true);
    expect(document.querySelector("[data-device-address-question]")).not.toBeNull();
    await userEvent.click(button(password, "Cancel"));
    await gone("[data-device-password-question]");
    expect(document.querySelector("[data-device-address-question]")).not.toBeNull();
    await userEvent.click(
      button(document.querySelector("[data-device-address-question]") as HTMLElement, "Cancel"),
    );
    await gone("[data-device-address-question]");
  }

  // Section: the password goes on the update's one call, and the row follows
  // the update's count until the computer runs this version.
  {
    await userEvent.click(button(row("mini") as HTMLElement, `Update ${mini}`));
    updates[1]?.resolve({
      asks: "password",
      for: "update",
      deviceId: "mini",
      address: "sam@mini.local",
      user: "sam",
    });
    const password = await shown('[data-device-password-question="sam@mini.local"]');
    await userEvent.fill(
      password.querySelector('input[type="password"]') as HTMLElement,
      "correct horse",
    );
    await userEvent.click(button(password, "Update"));
    expect(bridge.requests("inf:devices:update").at(-1)).toEqual([
      "mini",
      { password: "correct horse" },
    ]);
    await gone("[data-device-password-question]");
    await expect.poll(() => row("mini")?.textContent).toContain(remoteLoginWords.updatingRow(MINI));
    expect(row("mini")?.querySelector(`[aria-label="Update ${mini}"]`)).toBeNull();
    const sent = 96 * 1024 * 1024;
    bridge.push("inf:event", {
      type: "device_update",
      deviceId: "mini",
      name: MINI.name,
      stage: "updating",
      text: remoteLoginWords.sendingRow(mini, sent),
      tone: "info",
      copy: { state: "sending", sent },
    });
    await expect
      .poll(() => row("mini")?.textContent)
      .toContain(remoteLoginWords.sendingRow(mini, sent));
    const { otherVersion: _, ...current } = MINI;
    listed = [AIR, current, STUDIO];
    bridge.push("inf:devices", listed);
    updates[2]?.resolve(current);
    await expect
      .poll(() => row("mini")?.textContent)
      .not.toContain(remoteLoginWords.sendingRow(mini, sent));
    expect(row("mini")?.querySelector(`[aria-label="Update ${mini}"]`)).toBeNull();
    // Back on the older version for the refusals that follow.
    listed = [AIR, MINI, STUDIO];
    bridge.push("inf:devices", listed);
    await shown(`[data-device-row="mini"] [aria-label="Update ${mini}"]`);
  }

  // Section: an update that could not reach it says so, and the line goes
  // once that computer's connection began after it.
  {
    const lines = remoteLoginWords.refused("unreachable", {
      address: "sam@mini.local",
      doing: "update",
    });
    await userEvent.click(button(row("mini") as HTMLElement, `Update ${mini}`));
    updates[3]?.resolve({ refused: "unreachable", lines });
    await expect.poll(problemLine).toBe(lines.join("\n"));
    // A list that says nothing newer keeps the line.
    bridge.push("inf:devices", listed);
    await afterNextFrame();
    expect(problemLine()).toBe(lines.join("\n"));
    listed = [AIR, { ...MINI, connectedAt: Date.now() + 1 }, STUDIO];
    bridge.push("inf:devices", listed);
    await expect.poll(problemLine).toBeNull();
  }

  // Section: any other refusal stays when the computer answers again.
  {
    const lines = remoteLoginWords.refused("key-refused", {
      address: "sam@mini.local",
      doing: "update",
    });
    await userEvent.click(button(row("mini") as HTMLElement, `Update ${mini}`));
    updates[4]?.resolve({ refused: "key-refused", lines });
    await expect.poll(problemLine).toBe(lines.join("\n"));
    listed = [AIR, { ...MINI, connectedAt: Date.now() + 1 }, STUDIO];
    bridge.push("inf:devices", listed);
    await afterNextFrame();
    expect(problemLine()).toBe(lines.join("\n"));
  }

  // Section: Change address asks the new address in place of the row, and
  // the row says where this computer looks while it does; the person's next
  // action clears the line before.
  const moved = "sam@mini-2.local";
  {
    await userEvent.click(await rowAction("mini", "address"));
    expect(problemLine()).not.toBeNull();
    const form = await shown('[data-device-address-change="mini"]');
    const input = form.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("sam@mini.local");
    expect(button(form, "Change it").disabled).toBe(true);
    await userEvent.fill(input, moved);
    await userEvent.click(button(form, "Change it"));
    expect(bridge.requests("inf:devices:change-address")).toEqual([["mini", moved]]);
    await gone("[data-device-address-change]");
    await expect.poll(problemLine).toBeNull();
    await expect
      .poll(() => row("mini")?.textContent)
      .toContain(remoteLoginWords.reachingRow(moved));
  }

  // Section: a move that could not reach the new address says so; the line
  // stays while the computer answers at the old address, and goes once it
  // answers at the new one.
  {
    const lines = remoteLoginWords.refused("unreachable", { address: moved, doing: "address" });
    moves[0]?.resolve({ refused: "unreachable", lines });
    await expect.poll(problemLine).toBe(lines.join("\n"));
    await expect
      .poll(() => row("mini")?.textContent)
      .not.toContain(remoteLoginWords.reachingRow(moved));
    listed = [AIR, { ...MINI, connectedAt: Date.now() + 1 }, STUDIO];
    bridge.push("inf:devices", listed);
    await afterNextFrame();
    expect(problemLine()).toBe(lines.join("\n"));
    listed = [AIR, { ...MINI, remoteLogin: moved, connectedAt: Date.now() + 1 }, STUDIO];
    bridge.push("inf:devices", listed);
    await expect.poll(problemLine).toBeNull();
  }
  await selectDevice("studio");
  await userEvent.click(button(row("studio") as HTMLElement, `Try again to reach ${studio}`));
  expect(bridge.requests("inf:devices:try-again")).toEqual([["studio"]]);
  await afterNextFrame();
  expect(problemLine()).toBeNull();
  refuseTry = "Could not try again: the connection is already being made.";
  await userEvent.click(button(row("studio") as HTMLElement, `Try again to reach ${studio}`));
  await expect.poll(problemLine).toBe(refuseTry);
  refuseTry = null;

  // Section: Remove asks in place with Keep it focused, and removes a
  // computer in reach at once.
  {
    await selectDevice("air");
    await userEvent.click(await rowAction("air", "remove"));
    const question = await shown('[data-device-removing="air"]');
    for (const line of removeLines(AIR)) expect(question.textContent).toContain(line);
    expect(document.activeElement).toBe(button(question, "Keep it"));
    await userEvent.click(button(question, "Remove"));
    expect(bridge.requests("inf:devices:remove").at(-1)?.[0]).toBe("air");
    expect(bridge.requests("inf:devices:remove").at(-1)?.[1]).toBeUndefined();
    await gone('[data-device-select="air"]');
  }

  // Section: a computer out of reach asks whether to wait for it; Remove when
  // it is back waits, and Keep it takes that wait back.
  {
    await selectDevice("studio");
    await userEvent.click(await rowAction("studio", "remove"));
    const question = await shown('[data-device-removing="studio"]');
    expect(button(question, "Remove now")).toBeTruthy();
    await userEvent.click(button(question, "Remove when it is back"));
    expect(bridge.requests("inf:devices:remove").at(-1)).toEqual(["studio", "when-back"]);
    const waiting = await shown('[data-device-row="studio"][data-removal="when-back"]');
    await userEvent.click(button(waiting, "Keep it"));
    expect(bridge.requests("inf:devices:keep")).toEqual([["studio"]]);
    await gone('[data-device-row="studio"][data-removal]');
  }
  // Section: Keep it closes Remove's question, and focus goes back to the ⋯
  // that opened it, on the row that stands again.
  {
    await selectDevice("mini");
    await userEvent.click(await rowAction("mini", "remove"));
    await userEvent.click(button(await shown('[data-device-removing="mini"]'), "Keep it"));
    const back = await shown('[data-device-row="mini"]');
    await expect
      .poll(() => document.activeElement)
      .toBe(back.querySelector('.fm-devices-more [aria-haspopup="menu"]'));
  }
  refuseRemove = "Could not remove this device: its work is still coming back.";
  await selectDevice("mini");

  await userEvent.click(await rowAction("mini", "remove"));
  await userEvent.click(button(await shown('[data-device-removing="mini"]'), "Remove"));
  await expect.poll(problemLine).toBe(refuseRemove);
  await shown('[data-device-row="mini"]');
  refuseRemove = null;

  // Section: a card's Remove for a computer out of reach lands here asking how.
  {
    const before = bridge.requests("inf:devices:remove").length;
    useShellStore.setState({ pendingDeviceArrival: { remove: "studio" } });
    const question = await shown('[data-device-removing="studio"]');
    expect(useShellStore.getState().pendingDeviceArrival).toBeNull();
    expect(bridge.requests("inf:devices:remove")).toHaveLength(before);
    await userEvent.click(button(question, "Keep it"));
    await shown('[data-device-row="studio"]');
  }

  expect(unansweredOf(bridge)).toEqual([]);
});
