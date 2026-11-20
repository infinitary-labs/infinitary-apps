import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "@playwright/test";

// Leaves evidence in its run's directory, then holds the run open until
// tests/run-evidence-playwright.test.ts creates the release file.
test("leaves its evidence and holds the run", async () => {
  writeFileSync(test.info().outputPath("evidence.txt"), "held");
  appendFileSync(process.env.INFINITARY_FIXTURE_LOG as string, "held\n");
  while (!existsSync(process.env.INFINITARY_FIXTURE_RELEASE as string)) await sleep(50);
});
