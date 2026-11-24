import { CONNECTION_PORT } from "@shared/connection";
import type { HomeAtAnswer } from "@shared/homeAt";
import * as m from "@shared/i18n/messages.generated";
import type { JoinAtAnswer } from "@shared/joinByAddress";
import { NEARBY_OFF } from "@shared/nearbyMacs";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "./bridge";
import { button, gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * INF-6207's approved plan, part 2: the welcome screen's Another computer
 * sets the first mate up on that computer over SSH, driven by keys as a
 * person does. The first mate here answers each step of the setup in turn;
 * the steps follow its progress, a stop offers Ask again, Set it up with
 * commands and Back, and Join by its address offers to set it up from here
 * when Infinitary is not open there.
 */

const LINE = "ED25519 SHA256:Zm9yIGEgdGVzdCBvbmx5LCBub3QgYSByZWFsIGtleQ";

/** Answers handed out in order, each call taking the next; a function waits on the test. */
function inTurn<T>(answers: (T | (() => Promise<T>))[]) {
  return async () => {
    const next = answers.shift();
    if (next === undefined) throw new Error("No answer left");
    return typeof next === "function" ? (next as () => Promise<T>)() : next;
  };
}

const states = () =>
  [...document.querySelectorAll<HTMLElement>("[data-home-step]")].map(
    (row) => `${row.dataset.homeStep}:${row.dataset.state}`,
  );

test("Another computer sets the first mate up there over SSH, step by step, from the keyboard", async () => {
  let sent = (_answer: HomeAtAnswer) => {};
  const homeAt: (HomeAtAnswer | (() => Promise<HomeAtAnswer>))[] = [
    { asks: "confirm", address: "sam@studio", line: LINE },
    () =>
      new Promise((resolve) => {
        sent = resolve;
      }),
    {
      started: true,
      address: "sam@studio",
      name: "studio",
      lingerOff: false,
      waitsForLogin: false,
      private: true,
    },
  ];
  const joinAt: JoinAtAnswer[] = [
    { refused: "not-open" },
    { asks: "join", runsWork: false, alsoPrivate: false },
    // One already running's Join by its address, later: the key line, then nothing open there.
    { asks: "confirm", address: "sam@studio", line: LINE },
    { refused: "not-open" },
  ];
  const bridge = fakeBridge({
    ...freshHome(),
    "inf:devices:home-at": inTurn(homeAt),
    "inf:devices:join-at": inTurn(joinAt),
    "inf:devices:join-held": { ok: false, refused: "unreachable" },
    "inf:devices:nearby": NEARBY_OFF,
  });
  await openSize();
  await openWindow(bridge);

  // Section: the address form, with the commands one press away.
  (await shown('[data-gate-choice="another"]')).focus();
  await userEvent.keyboard("{Enter}");
  const field = (await shown("#home-address")) as HTMLInputElement;
  expect(document.activeElement).toBe(field);
  expect((await shown("[data-home-at]")).textContent).toContain(m.devicesHomeAddressHead());
  await userEvent.keyboard("sam@studio{Enter}");

  // Section: its key line first, Cancel holding the caret, the yes one Shift+Tab away.
  const key = await shown("[data-home-key]");
  expect(key.querySelector("[data-home-key-line]")?.textContent).toBe(LINE);
  expect(document.activeElement).toBe(button(key, m.devicesJoinCancel()));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Enter}");
  expect(bridge.requests("inf:devices:home-at")[1]).toEqual(["sam@studio", { confirm: LINE }]);

  // Section: the steps follow the first mate's progress, the copy's megabytes beside Send.
  await shown("[data-home-steps]");
  bridge.push("inf:events", [
    {
      type: "device_setup",
      address: "sam@studio",
      doing: "add",
      stage: "setting-up",
      name: "studio",
      text: "Sending Infinitary to studio: 42 MB sent.",
      tone: "info",
      copy: { state: "sending", sent: 42_000_000 },
    },
  ]);
  await expect
    .poll(states)
    .toEqual([
      "key:done",
      "sign-in:done",
      "look:done",
      "send:current",
      "start:next",
      "connect:next",
      "sign-up:next",
    ]);
  expect(document.querySelector('[data-home-step="send"]')?.textContent).toContain(
    m.devicesHomeSentMb({ mb: "42" }),
  );

  // Section: a stop marks its step, says what to try, and keeps nothing changed there.
  sent({ refused: "unreachable", step: "send", name: "studio", reach: { step: "send" } });
  const stopped = await shown("[data-home-stopped]");
  expect(states()[3]).toBe("send:stopped");
  expect(stopped.querySelector("[data-home-left]")?.textContent).toBe(
    m.devicesHomeLeftNothing({ count: 3, computer: "studio" }),
  );
  const askAgain = button(stopped, m.devicesHomeAskAgain());
  expect(document.activeElement).toBe(askAgain);
  button(stopped, m.devicesHomeCommands());
  button(stopped, m.devicesHomeBack());

  // Section: asked again, it starts there, waits for the first mate there to open, then joins.
  await userEvent.keyboard("{Enter}");
  // It asks again two seconds after the first mate there was not open yet.
  const stop = '[data-home-steps="connect"] [data-home-stopped]';
  await expect.poll(() => document.querySelector(stop), { timeout: 5_000 }).not.toBeNull();
  const unreached = await shown(stop);
  expect(bridge.requests("inf:devices:join-at").map(([at]) => at)).toEqual([
    "sam@studio",
    "sam@studio",
  ]);
  expect(bridge.requests("inf:devices:join-held")).toEqual([["join"]]);
  expect(unreached.textContent).toContain(
    m.devicesHomeUnreachable({ computer: "studio", port: String(CONNECTION_PORT) }),
  );
  expect(unreached.querySelector("[data-home-left]")?.textContent).toBe(
    m.devicesHomeLeftRunning({ count: 1, computer: "studio" }),
  );

  // Section: Set it up with commands opens the commands route.
  await userEvent.click(button(unreached, m.devicesHomeCommands()));
  await shown("[data-gate-commands]");
  await gone("[data-home-at]");

  // Section: One already running's Join by its address, with nothing open there, offers to set it up from here.
  await userEvent.click(await shown('[data-gate-back="another"]'));
  await userEvent.click(await shown('[data-gate-choice="running"]'));
  await userEvent.click(await shown("[data-join-address-chip]"));
  await userEvent.type(await shown("#join-address"), "sam@studio{Enter}");
  await userEvent.click(button(await shown("[data-join-key]"), "This is the computer"));
  const notOpen = await shown('[data-join-refused="not-open"]');
  expect(notOpen.textContent).toBe(m.devicesHomeNotOpen({ address: "sam@studio" }));
  await userEvent.click(await shown("[data-join-set-up-from]"));
  expect(((await shown("#home-address")) as HTMLInputElement).value).toBe("sam@studio");
  expect(unansweredOf(bridge)).toEqual([]);
});
