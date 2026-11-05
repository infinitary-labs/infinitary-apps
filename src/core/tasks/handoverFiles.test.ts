import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor, crewmateHandoverDir } from "../paths";
import { openInMemoryDatabase } from "../storage/db";
import {
  deliverHandoverFile,
  keepHandoverFiles,
  keptHandoverFiles,
  verifyHandoverFiles,
} from "./handoverFiles";
import { seedTask } from "./seedTask";
import { TaskService } from "./taskService";
import { TaskTempFiles } from "./taskTemp";

/**
 * Files one task hands another (INF-992, direction B: "a second task can
 * hand files to the waiting task"), under the captain's words on it: "make
 * sure file content never gets printed or leaked because it's possible the
 * file can contain secrets". The transfer between two computers is
 * `placedCallbacks.test.ts`'s; this file owns the copies on one computer.
 */

const SECRET = `client_secret=${createHash("sha256").update("INF-992").digest("hex")}`;

function clientFile(): string {
  const file = join(scratchDir("infinitary-handover-source-"), "client secret.json");
  writeFileSync(file, `{"installed":{"${SECRET}"}}\n`);
  return file;
}

describe("files one task hands another", () => {
  it("keeps a verified private copy of a reported file and delivers it into a hand-over folder", async () => {
    const source = clientFile();
    const out = join(scratchDir("infinitary-handover-out-"), "handover-out");
    const [kept] = await keepHandoverFiles([source], out);
    const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
    expect(kept).toEqual({
      file: `${sha256.slice(0, 16)}-client_secret.json`,
      size: statSync(source).size,
      sha256,
    });
    const copy = join(out, kept?.file ?? "");
    expect(readFileSync(copy)).toEqual(readFileSync(source));
    expect(statSync(copy).mode & 0o777).toBe(0o600);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    await expect(verifyHandoverFiles(out, kept ? [kept] : [])).resolves.toBeUndefined();

    const [listed] = await keptHandoverFiles(out);
    const into = join(scratchDir("infinitary-handover-in-"), "temp", "handover");
    const delivered = await deliverHandoverFile(listed?.path ?? "", into, listed?.file ?? "");
    expect(delivered).toBe(join(into, kept?.file ?? ""));
    expect(readFileSync(delivered)).toEqual(readFileSync(source));
    expect(statSync(delivered).mode & 0o777).toBe(0o600);
  });

  it("refuses what is not one whole file, naming the path and never the content", async () => {
    const source = clientFile();
    const out = join(scratchDir("infinitary-handover-out-"), "handover-out");
    const empty = join(scratchDir("infinitary-handover-empty-"), "empty.txt");
    writeFileSync(empty, "");
    const refusals = await Promise.all(
      [["client secret.json"], [join(source, "..")], [`${source}.gone`], [empty]].map((paths) =>
        keepHandoverFiles(paths, out).then(
          () => "kept",
          (error: Error) => error.message,
        ),
      ),
    );
    expect(refusals).toEqual([
      "Hand on files by absolute path: client secret.json is not one.",
      `${join(source, "..")} is not a file; hand on files, never a folder.`,
      `There is no file at ${source}.gone to hand on.`,
      `${empty} is empty, so there is nothing to hand on.`,
    ]);
    // A copy that does not match what the report declared is refused, by name alone.
    const [kept] = await keepHandoverFiles([source], out);
    if (!kept) throw new Error("The file was not kept.");
    writeFileSync(join(out, kept.file), "changed");
    const refused = await verifyHandoverFiles(out, [kept]).catch((error: Error) => error.message);
    expect(refused).toBe(`${kept.file} did not arrive whole; report it again.`);
    expect(JSON.stringify(refusals) + refused).not.toContain(SECRET);
  });

  it("goes when its task closes, here or on another computer, and stays while it is live", async () => {
    const paths = appPathsFor(scratchDir("infinitary-handover-close-"));
    const tasks = new TaskService({ db: openInMemoryDatabase(), now: () => 1, strict: true });
    seedTask(tasks, { id: "t-here", title: "Find the W-9", status: "cancelled" });
    seedTask(tasks, { id: "t-there", title: "Find the client file", status: "cancelled" });
    tasks.placement.setDevice("t-there", "mac-mini");
    seedTask(tasks, { id: "t-live", title: "Find the log", status: "running" });
    for (const id of ["t-here", "t-there", "t-live"]) {
      mkdirSync(crewmateHandoverDir(paths, id), { recursive: true });
      await keepHandoverFiles([clientFile()], crewmateHandoverDir(paths, id));
    }
    const temp = new TaskTempFiles({
      paths,
      tasks,
      deleteInBackground: () => {},
      now: () => 2,
      removePlaced: async () => ({ status: "absent", bytes: 0 }),
    });
    await temp.sweep();
    expect(existsSync(crewmateHandoverDir(paths, "t-here"))).toBe(false);
    expect(existsSync(crewmateHandoverDir(paths, "t-there"))).toBe(false);
    expect(await keptHandoverFiles(crewmateHandoverDir(paths, "t-live"))).toHaveLength(1);
  });
});
