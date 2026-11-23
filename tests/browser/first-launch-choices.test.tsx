import * as m from "@shared/i18n/messages.generated";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import {
  GATE_CHOICES,
  GATE_COMMANDS,
  gateChoiceWords,
  gateMoveLater,
  gateWhere,
} from "../../src/renderer/src/app/firstRunGateWords";
import { fakeBridge } from "./bridge";
import { button, clipboard, gone, shown, unansweredOf } from "./devicesTab";
import { freshHome } from "./freshHome";
import { openSize, openWindow } from "./window";

/**
 * The first launch asks where the first mate lives before anything opens
 * (captain's approval of INF-6207: ask first, three equal choices, the
 * move-later line; docs/first-launch.md). Driven by keys as a person does:
 * the arrows move between the choices and Enter opens one. Another computer
 * lists the commands to run there and ends at One already running's paste
 * box; Where I live comes back to the three choices.
 */

const CHOICES = "[data-gate-choices]";

test("the welcome asks where the first mate lives, and each choice opens its own way in", async () => {
  const bridge = fakeBridge(freshHome());
  const copied = clipboard();
  await openSize();
  await openWindow(bridge);

  // Section: three equal choices under the question, the move line under them, nothing open.
  const row = await shown(CHOICES);
  const gate = document.querySelector<HTMLElement>('[data-first-run-gate="open"]') as HTMLElement;
  expect(gate.querySelector("[data-gate-where]")?.textContent).toBe(gateWhere());
  const cards = [...row.querySelectorAll<HTMLButtonElement>("[data-gate-choice]")];
  expect(cards.map((card) => card.textContent)).toEqual(
    GATE_CHOICES.map((choice) => {
      const words = gateChoiceWords(choice);
      return `${words.name}${words.line}`;
    }),
  );
  const widths = cards.map((card) => Math.round(card.getBoundingClientRect().width));
  expect(new Set(widths).size, `equal widths ${widths.join(", ")}`).toBe(1);
  expect(gate.querySelector("[data-gate-later]")?.textContent).toBe(gateMoveLater());
  expect(gate.querySelector("[data-connect-provider]")).toBeNull();
  expect(gate.querySelector("[data-join-another-mac]")).toBeNull();
  cards[0]?.focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(document.activeElement).toBe(cards[1]);
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  expect(document.activeElement).toBe(cards[0]);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(cards[2]);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(cards[1]);
  await userEvent.keyboard("{Enter}");

  // Section: Another computer lists the commands to run there, each with its Copy.
  {
    const commands = await shown("[data-gate-commands]");
    await gone(CHOICES);
    const lines = [...commands.querySelectorAll<HTMLElement>("[data-gate-command]")];
    expect(lines.map((line) => line.querySelector("code")?.textContent)).toEqual([
      GATE_COMMANDS.start,
      GATE_COMMANDS.link,
    ]);
    await userEvent.click(button(lines[1] as HTMLElement, m.devicesJoinSetUpCopy()));
    expect(copied.written).toEqual([GATE_COMMANDS.link]);
  }

  // Section: its last step opens One already running at its paste box; Cancel shows that choice's chips.
  {
    await userEvent.click(await shown("[data-gate-paste]"));
    const paste = await shown('[data-join-another-mac="paste"]');
    await gone("[data-gate-commands]");
    expect(paste.textContent).toContain(m.devicesJoinPasteSub());
    await userEvent.click(button(paste, m.devicesJoinCancel()));
    await shown('[data-join-another-mac="closed"]');
    await shown("[data-join-chip]");
  }
  await userEvent.click(await shown('[data-gate-back="running"]'));
  await shown(CHOICES);
  await gone("[data-join-another-mac]");
  await userEvent.click(await shown('[data-gate-choice="here"]'));
  await expect
    .poll(() => gate.querySelectorAll("[data-connect-provider]").length)
    .toBeGreaterThan(0);
  await gone("[data-join-another-mac]");
  await userEvent.click(await shown('[data-gate-back="here"]'));
  await shown(CHOICES);
  expect(unansweredOf(bridge)).toEqual([]);
});
