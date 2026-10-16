import { appendFileSync, writeFileSync } from "node:fs";
import { test } from "@playwright/test";

// Leaves evidence in its run's directory and finishes at once.
test("leaves its evidence", async () => {
  writeFileSync(test.info().outputPath("evidence.txt"), "quick");
  appendFileSync(process.env.INFINITARY_FIXTURE_LOG as string, "quick\n");
});
