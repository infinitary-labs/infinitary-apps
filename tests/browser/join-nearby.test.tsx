import { nearbyMacsWords } from "@shared/nearbyMacs";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { button, gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The first launch's Join by its address lists Macs nearby as Settings ->
 * Devices does (docs/devices.md, "Macs nearby"; design skill
 * components/devices/JoinAnotherMac): it looks while the aside is open, lists
 * what the home pushes, fills the address from a pick with the account above
 * it, and stops looking once the aside closes. Guardrail for restructuring
 * Settings -> Devices (INF-2625's plan, the devices piece), whose nearby list
 * and looking this aside shares.
 */

const STUDIO = { name: "Mac Studio", at: "studio.local" } as const;

test("join by its address looks for Macs nearby while open, fills a pick, and stops when closed", async () => {
  const home = freshHome();
  const bridge = fakeBridge(home);
  bridge.answer("inf:devices:nearby", (watching) => ({
    state: watching ? "looking" : "off",
    user: watching ? "kun" : null,
    macs: [],
  }));
  await openSize();
  await openWindow(bridge);
  await userEvent.click(await shown("[data-join-address-chip]"));
  await shown("[data-join-address]");
  await expect.poll(() => bridge.requests("inf:devices:nearby")).toEqual([[true]]);
  bridge.push("inf:devices:nearby", { state: "looking", user: "kun", macs: [] });
  await shown("[data-device-nearby-looking]");

  // Section: a pushed Mac is listed at the account above it, and a pick fills the address.
  {
    bridge.push("inf:devices:nearby", { state: "looking", user: "kun", macs: [STUDIO] });
    const row = await shown(`[data-device-nearby-mac="${STUDIO.at}"]`);
    expect(row.textContent).toContain(STUDIO.name);
    expect(row.textContent).toContain(`kun@${STUDIO.at}`);
    await userEvent.click(row);
    await expect
      .poll(() => document.querySelector<HTMLInputElement>("#join-address")?.value)
      .toBe(`kun@${STUDIO.at}`);
  }

  // Section: macOS not allowing the local network says so, with how to allow it.
  {
    bridge.push("inf:devices:nearby", { state: "not-allowed", user: "kun", macs: [] });
    const note = await shown("[data-device-nearby-not-allowed]");
    for (const line of nearbyMacsWords.notAllowed) expect(note.textContent).toContain(line);
  }
  await userEvent.click(
    button(document.querySelector("[data-join-address]") as HTMLElement, "Cancel"),
  );
  await gone("[data-join-address]");
  await expect.poll(() => bridge.requests("inf:devices:nearby").at(-1)).toEqual([false]);
  expect(document.querySelector("[data-device-nearby]")).toBeNull();

  expect(unansweredOf(bridge)).toEqual([]);
});
