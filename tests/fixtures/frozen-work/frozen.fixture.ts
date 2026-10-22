import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// Work a quiet Mac finishes at once, frozen the way a starved Mac freezes it:
// longer than the test's 500 ms limit and vitest's one-second wait.
it("finishes work the Mac froze past the test's limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "infinitary-frozen-work-"));
  const file = join(dir, "done");
  try {
    const child = spawn(
      process.execPath,
      ["-e", `require("node:fs").writeFileSync(${JSON.stringify(file)}, "done")`],
      { stdio: "ignore" },
    );
    await new Promise((resolve) => child.once("spawn", resolve));
    child.kill("SIGSTOP");
    setTimeout(() => child.kill("SIGCONT"), 1_500);
    await vi.waitFor(() => expect(existsSync(file)).toBe(true));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 500);
