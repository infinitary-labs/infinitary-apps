import { awayWord, type DeviceView } from "@shared/devices";
import { expect, test } from "vitest";
import { fakeBridge } from "./bridge";
import { seededHome, subscribed } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The stage names a work computer that is being updated, or whose connection
 * is being made, with the word every other surface uses (`awayWord`), in the
 * quiet color of its name; only out of reach for no such reason warns
 * (docs/devices.md, "Updating"; docs/crew-orbits.md).
 */

const MINI_BASE: DeviceView = {
  id: "mini",
  kind: "mac",
  name: "Mac mini",
  pairedAt: 1_700_000_000_000,
  onThisMac: false,
  inReach: false,
  seenAt: 1_700_000_100_000,
  tasks: 1,
  runs: [],
};

const cluster = () => document.querySelector<HTMLElement>('[data-computer-cluster="mini"]');
const reachable = () => cluster()?.getAttribute("data-computer-reachable") ?? null;
const away = () => cluster()?.querySelector<HTMLElement>("span + span") ?? null;
const said = () => away()?.textContent?.toLowerCase() ?? null;
const color = (el: Element | null | undefined) => (el ? getComputedStyle(el).color : null);
/** The warn token as the page resolves it, read off a probe so no color is typed here. */
function warnColor(): string {
  const probe = document.createElement("span");
  probe.style.color = "var(--warn)";
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

test("the stage names a computer being updated, or connecting, by the word every other surface uses, without the warning color", async () => {
  const bridge = fakeBridge(subscribed(await seededHome({ deviceId: "mini" })));
  let listed: DeviceView[] = [{ ...MINI_BASE, updating: true }];
  bridge.answer("inf:devices:list", () => listed);
  await openSize();
  await openWindow(bridge);
  await expect
    .poll(() => cluster() !== null, {
      message: "the Mac mini's cluster was never drawn",
      timeout: 30_000,
    })
    .toBe(true);
  const warn = warnColor();
  const name = () => color(cluster()?.querySelector("span"));

  await expect.poll(said, { message: "updating" }).toBe(awayWord(false, true));
  expect(color(away()), "updating is quiet").toBe(name());
  expect(color(away()), "updating does not warn").not.toBe(warn);

  // Back in reach between cases, so each push is seen to reach the stage.
  listed = [{ ...MINI_BASE, inReach: true }];
  bridge.push("inf:devices", listed);
  await expect.poll(reachable).toBe("true");

  listed = [{ ...MINI_BASE, ssh: { state: "connecting" } }];
  bridge.push("inf:devices", listed);
  await expect.poll(reachable).toBe("false");
  await expect.poll(said, { message: "connecting" }).toBe(awayWord(true));
  expect(color(away()), "connecting is quiet").toBe(name());

  listed = [{ ...MINI_BASE, inReach: true }];
  bridge.push("inf:devices", listed);
  await expect.poll(reachable).toBe("true");

  listed = [{ ...MINI_BASE }];
  bridge.push("inf:devices", listed);
  await expect.poll(reachable).toBe("false");
  await expect.poll(said, { message: "out of reach" }).toBe(awayWord(false));
  expect(color(away()), "out of reach warns").toBe(warn);
});
