import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";

/** Drive the startup ordering explicitly, without depending on a loaded Mac. */
test("idle wait requires a drawn character after the opening greet", async () => {
  const launched = await launchApp();
  const { page } = launched;
  try {
    await page.setContent('<canvas role="img" aria-label="First mate - idle" hidden></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="img"]');
      if (!canvas) throw new Error("Missing character fixture");
      const read = canvas.toDataURL.bind(canvas);
      canvas.toDataURL = (...args) => {
        canvas.dataset.read = canvas.getAttribute("aria-label") ?? "";
        return read(...args);
      };
    });
    const character = page.getByRole("img", { name: /^First mate - /, includeHidden: true });
    let resolved = false;
    const idle = waitForFirstmateIdle(page).then(() => {
      resolved = true;
    });
    // The helper has read the undrawn idle, but must still be waiting.
    await expect(character).toHaveAttribute("data-read", "First mate - idle");
    expect(resolved).toBe(false);
    await character.evaluate((node) => {
      const canvas = node as HTMLCanvasElement;
      canvas.setAttribute("aria-label", "First mate - greet");
      canvas.getContext("2d")?.fillRect(0, 0, 10, 10);
    });
    await expect(character).toHaveAttribute("data-read", "First mate - greet");
    expect(resolved).toBe(false);
    await character.evaluate((canvas) => canvas.setAttribute("aria-label", "First mate - idle"));
    await idle;
    expect(resolved).toBe(true);
    await test.info().attach("idle-order", {
      body: "Undrawn idle: waiting. Drawn greet: waiting. Drawn idle (hidden canvas): resolved.",
      contentType: "text/plain",
    });
  } finally {
    await launched.close();
  }
});
