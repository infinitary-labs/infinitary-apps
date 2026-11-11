import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { writeMockClaudeClient } from "../../e2e/mockClaudeClient";
import { scratchDir } from "../../helpers/scratchDirs";

import { leaveProgram } from "./program";

it("makes scratch state and intentionally leaves a program only when asked by the approved cleanup regression", async () => {
  expect(scratchDir("infinitary-fixture-scratch-")).toContain(tmpdir());
  const home = scratchDir("infinitary-fixture-home-");
  const stub = writeMockClaudeClient(home, {
    turns: { baseUrl: "http://127.0.0.1:9", client: process.execPath },
  });
  expect(dirname(stub), "immutable preparation is separate from HOME state").not.toBe(home);
  if (process.env.INFINITARY_FIXTURE_LEAK)
    mkdtempSync(join(tmpdir(), process.env.INFINITARY_FIXTURE_LEAK));

  await leaveProgram(home);
});
