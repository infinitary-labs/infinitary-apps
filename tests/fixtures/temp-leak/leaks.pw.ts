import { test } from "@playwright/test";
import { scratchDir } from "../../helpers/scratchDirs";
import { leaveProgram } from "./program";

test("approved cleanup regression: a daemon must not survive its journey run", async () => {
  await leaveProgram(scratchDir("infinitary-journey-daemon-"));
});
