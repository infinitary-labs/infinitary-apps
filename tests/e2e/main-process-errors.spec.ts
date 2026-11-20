import { expect, test } from "@playwright/test";
import { launchApp } from "./launch";

// What the handlers write is processErrors.test.ts's; here the app keeps
// answering after its main process throws and rejects unhandled.
test("main-process exceptions do not block the app", async () => {
  const launched = await launchApp();

  try {
    await launched.app.evaluate(
      () =>
        new Promise<void>((done) => {
          setTimeout(() => {
            void Promise.reject(new Error("e2e unhandled rejection probe"));
          }, 0);
          setTimeout(() => {
            throw new Error("e2e uncaught exception probe");
          }, 0);
          // Timers run in order: this one runs after both probes have thrown.
          setTimeout(done, 0);
        }),
    );

    await expect
      .poll(() => launched.page.evaluate(() => window.infinitary.app.healthcheck()))
      .toMatchObject({ ok: true });
  } finally {
    await launched.close();
  }
});
