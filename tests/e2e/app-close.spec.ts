import { expect, test } from "@playwright/test";
import { closeApp, launchApp } from "./launch";

/**
 * Closing a launched app (tests/e2e/launch.ts, docs/e2e-contracts.md): a
 * journey's `finally` closes every app it launched, including one a step
 * already closed or one that quit by itself, and the step's own failure is
 * still the one reported. Playwright answers `app.process()` only while the
 * app is open, so a second close that asked again threw "Cannot read
 * properties of undefined (reading '_object')" and hid what really failed
 * (view.spec.ts in release run 37583396790).
 */

test("a step that closed its app and then failed reports its own failure after the cleanup closes it again", async () => {
  const launched = await launchApp();
  const child = launched.app.process();
  const failure = new Error("the step's own failure");
  const reported = await (async () => {
    try {
      await launched.close();
      throw failure;
    } finally {
      await launched.close();
      await closeApp(launched.app);
    }
  })().catch((error: unknown) => error);
  expect(reported).toBe(failure);
  expect(child.exitCode ?? child.signalCode).not.toBeNull();
});

test("an app that quit by itself closes without an error", async () => {
  const launched = await launchApp();
  const child = launched.app.process();
  const gone = new Promise<void>((resolve) => launched.app.once("close", () => resolve()));
  // The quit ends the process the call runs in, so its answer may never come.
  void launched.app.evaluate(({ app }) => app.quit()).catch(() => {});
  await gone;
  await launched.close();
  expect(child.exitCode ?? child.signalCode).not.toBeNull();
});
