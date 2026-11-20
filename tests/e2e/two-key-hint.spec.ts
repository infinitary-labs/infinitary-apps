import { expect, test } from "@playwright/test";
import { KEYBOARD_COMMANDS } from "../../src/shared/keyboard";
import { keyWords } from "./desktop";
import { launchApp } from "./launch";
import { heroShot } from "./pictures";
import { promptInput } from "./prompt";
import {
  commandSearch,
  endRecording,
  focusOn,
  keyboardSettings,
  pressWindowKey,
  runFromSearch,
  startRecording,
} from "./windowKeys";

/**
 * Accepted layers plan, piece 3 (docs/keyboard.md, "Two-key shortcuts"): a
 * person records a plain first key and an arrow as a second key, and the
 * next-keys hint shows at once at the bottom of the window, listing each
 * next key with its command, with no timed wait; Escape or an unlisted key
 * ends it. Real app, hermetic home and the mock provider, no card or shared resource;
 * completion is the hint's own entries, then the screen each key leads to.
 */
test("a plain first key shows its next keys at once, an arrow finishes a pair, and Escape or another key ends it", async () => {
  test.setTimeout(120_000);
  const launched = await launchApp({ withMockProvider: true });
  const { app, page } = launched;
  const keyboard = keyboardSettings(page);
  const prompt = promptInput(page);
  const hint = page.getByRole("status", { name: "Next keys", exact: true });
  const settingsShown = page.locator('[data-screen-label="Settings"]');
  const search = commandSearch(page);
  /** Focus off every field, as the main message's Escape leaves it once plain keys are in use. */
  const leaveTyping = async () => {
    await focusOn(prompt);
    await pressWindowKey(app, "Escape");
    await expect(prompt).not.toBeFocused();
  };
  const pressG = async () => {
    await pressWindowKey(app, "g");
    await expect(hint).toBeVisible();
  };
  try {
    await test.step("records G S for Open Settings and G → beside ⌘K for Search commands", async () => {
      await runFromSearch(app, page, "settings.keyboard");
      await startRecording(page, "settings.open");
      await pressWindowKey(app, "g");
      await pressWindowKey(app, "s");
      await expect(keyboard.verdict("settings.open")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter");
      await expect(keyboard.keys("settings.open").locator("kbd")).toHaveText([
        keyWords({ key: "g" }),
        keyWords({ key: "s" }),
      ]);
      await startRecording(page, "commands.search");
      await pressWindowKey(app, "g");
      await pressWindowKey(app, "Right");
      await expect(keyboard.verdict("commands.search")).toHaveAttribute(
        "data-keyboard-verdict",
        "free",
      );
      await endRecording(app, page, "Enter", ["shift"]);
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(settingsShown).toHaveCount(0);
    });

    await test.step("in the main message G only types: no hint shows", async () => {
      await focusOn(prompt);
      await pressWindowKey(app, "g");
      await expect(hint).toHaveCount(0);
    });

    await test.step("outside typing G shows each next key and its command at once", async () => {
      await leaveTyping();
      await pressG();
      await expect(hint.locator("kbd").first()).toHaveText(keyWords({ key: "g" }));
      const searchEntry = hint.locator('[data-next-key="commands.search"]');
      const settingsEntry = hint.locator('[data-next-key="settings.open"]');
      await expect(searchEntry).toHaveText(
        `${keyWords({ key: "ArrowRight" })}${KEYBOARD_COMMANDS["commands.search"].label}`,
      );
      await expect(settingsEntry).toHaveText(
        `${keyWords({ key: "s" })}${KEYBOARD_COMMANDS["settings.open"].label}`,
      );
      await heroShot(app, page, {
        region: hint,
        name: "two-key-hint",
        dir: test.info().outputPath("hero"),
      });
    });

    await test.step("the arrow finishes G → and opens command search", async () => {
      await pressWindowKey(app, "Right");
      await expect(search.dialog).toBeVisible();
      await expect(hint).toHaveCount(0);
      await pressWindowKey(app, "Escape");
      await expect(search.dialog).toHaveCount(0);
    });

    await test.step("Escape and an unlisted key end the hint and run nothing", async () => {
      await leaveTyping();
      await pressG();
      await pressWindowKey(app, "Escape");
      await expect(hint).toHaveCount(0);
      await pressWindowKey(app, "s");
      await expect(settingsShown).toHaveCount(0);
      // Each plain key's offer settles before the next first key.
      await leaveTyping();
      await pressG();
      await pressWindowKey(app, "x");
      await expect(hint).toHaveCount(0);
      await pressWindowKey(app, "s");
      await expect(settingsShown).toHaveCount(0);
    });

    await test.step("G S opens Settings", async () => {
      await leaveTyping();
      await pressG();
      await pressWindowKey(app, "s");
      await expect(settingsShown).toBeVisible();
      await expect(hint).toHaveCount(0);
    });
  } finally {
    await launched.close();
  }
});
