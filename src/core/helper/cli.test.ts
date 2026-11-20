import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { OWN_IDENTITY } from "@shared/codeNames";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { serviceLabel } from "./background";
import { runCli } from "./cli";

/**
 * Review INF-4743 of INF-4260's piece 10: a Windows PC's work runs as a
 * Task Scheduler task that starts `work run` every minute whatever its
 * folder holds, where launchd and systemd start it only while a home is
 * joined. After a removal whose `schtasks /Delete` failed, Infinitary
 * started every minute for as long as the person was signed in. A run that
 * finds no home joined takes its task away. schtasks is a stand-in that
 * writes down what it was asked: no test registers a task.
 */
describe("the work's run on a Windows PC with no home joined", () => {
  it("takes its own Task Scheduler task away and ends", async () => {
    const dataDir = join(scratchDir("infinitary-cli-work-"), "work");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const asked: string[][] = [];
    const out = new PassThrough();
    const code = await runCli(["run"], {
      version: "0.8.2",
      place: {
        packaged: false,
        flavor: "dev",
        spelling: OWN_IDENTITY,
        dataDir,
        folderSpelling: OWN_IDENTITY,
        move: null,
        retired: false,
      },
      launcher: { executable: "C:\\Programs\\Infinitary\\Infinitary.exe", args: [] },
      serviceManager: {
        account: "DESKTOP-7Q2\\ada",
        schtasks: async (args) => {
          asked.push([...args]);
          return { ok: true, output: "SUCCESS" };
        },
      },
      backgroundEnv: {},
      env: {},
      stdin: new PassThrough(),
      stdout: out,
      stopSignal: () => new Promise(() => {}),
    });
    expect(code).toBe(1);
    expect(asked).toEqual([["/Delete", "/TN", serviceLabel("dev"), "/F"]]);
  });
});
