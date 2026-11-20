import * as m from "@shared/i18n/messages.generated";
import type { SetUpHere } from "@shared/joinByAddress";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { type Answers, fakeBridge } from "./bridge";
import { button, clipboard, gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * Set up from your first mate's computer, at the first launch (INF-4931's plan, round 3; design
 * skill components/devices/JoinAnotherMac): a Mac or an x64 Linux computer leads with a third
 * chip whose aside shows the address to type on the first mate's computer, its private network
 * address first, whether Remote Login is on here, and the line to compare there; a Windows PC
 * keeps the two chips it had. The window asks the shell to follow along while the gate is up.
 */

/** What this computer reads of itself, as `freshHome` gives a Mac on a private network. */
function hereOf(answers: Answers): SetUpHere {
  return answers["inf:devices:set-up-here"] as SetUpHere;
}

test("a Mac leads with set up from the first mate's computer, its private address first", async () => {
  const home = freshHome();
  const here = hereOf(home);
  const bridge = fakeBridge(home);
  const copied = clipboard();
  await openSize();
  await openWindow(bridge);

  // Section: three chips on their own line, the new one first.
  {
    const group = await shown('[data-join-another-mac="closed"]');
    // The chip comes once this computer has read itself.
    await shown("[data-join-set-up-chip]");
    const chips = [...group.querySelectorAll<HTMLButtonElement>(".fm-connect-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      m.devicesJoinSetUpChip(),
      m.devicesJoinPasteChip(),
      m.devicesJoinAddressChip(),
    ]);
    expect(group.querySelector("[data-join-chips-alone]")).not.toBeNull();
    // The chip came from the quick read alone: no account, address or key is read while closed.
    const reads = bridge.requests("inf:devices:set-up-here");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(([details]) => details === false)).toBe(true);
    // The window asks to follow along while its first launch is up.
    await expect.poll(() => bridge.requests("inf:devices:follow-added").length).toBeGreaterThan(0);
  }

  // Section: the aside shows the private network address first, then the local name, each with Copy.
  {
    await userEvent.click(await shown("[data-join-set-up-chip]"));
    const aside = await shown("[data-join-set-up]");
    expect(aside.textContent).toContain(m.devicesJoinSetUpHead());
    expect(bridge.requests("inf:devices:set-up-here").at(-1)).toEqual([true]);
    const addresses = [...aside.querySelectorAll<HTMLElement>("[data-join-set-up-address]")];
    expect(addresses.map((line) => line.querySelector("code")?.textContent)).toEqual([
      `${here.user}@${here.privateAddress}`,
      `${here.user}@${here.localName}`,
    ]);
    expect(aside.textContent).toContain(m.devicesJoinSetUpPrivate());
    expect(aside.textContent).toContain(m.devicesJoinSetUpLocal());
    // Focus lands on the first address's Copy, which copies it.
    const copy = button(addresses[0] as HTMLElement, m.devicesJoinSetUpCopy());
    await expect.poll(() => document.activeElement).toBe(copy);
    await userEvent.click(copy);
    expect(copied.written).toEqual([`${here.user}@${here.privateAddress}`]);
    // A refused copy says so, so the person copies it themselves.
    copied.refuse();
    await userEvent.click(button(addresses[1] as HTMLElement, m.devicesJoinSetUpCopy()));
    expect((await shown("[role=alert]")).textContent).toContain(m.devicesJoinSetUpCopyFailed());
    // Remote Login is on here, with the line its first mate's computer asks about.
    expect(aside.querySelector('[data-join-remote-login="on"]')?.textContent).toBe(
      m.devicesJoinSetUpOn(),
    );
    // The line is the key the private network address answered with, and says so.
    expect(aside.querySelector("[data-join-set-up-line]")?.textContent).toBe(here.line);
    expect(aside.textContent).toContain(
      m.devicesJoinSetUpCompare({ address: `${here.user}@${here.lineAt}` }),
    );
    expect(aside.textContent).toContain(m.devicesJoinSetUpWaiting());
    await userEvent.click(button(aside, m.devicesJoinCancel()));
    await gone("[data-join-set-up]");
  }

  // Section: Remote Login off says so, with Open Sharing settings, and no line to compare.
  {
    bridge.answer("inf:devices:set-up-here", {
      ...here,
      remoteLogin: "off",
      line: null,
      lineAt: null,
    });
    await userEvent.click(await shown("[data-join-set-up-chip]"));
    const state = await shown('[data-join-remote-login="off"]');
    expect(state.textContent).toContain(m.devicesJoinSetUpOff());
    expect(document.querySelector("[data-join-set-up-line]")).toBeNull();
    await userEvent.click(button(state, m.devicesJoinSetUpOpenSharing()));
    await expect.poll(() => bridge.requests("inf:devices:open-sharing")).toEqual([[]]);
  }

  expect(unansweredOf(bridge)).toEqual([]);
});
