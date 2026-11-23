import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockModelsJson } from "../../tests/e2e/mockModels";
import { type MockProviderServer, startMockProvider } from "../../tests/e2e/mockProvider";
import {
  AT_FIRST_LAUNCH,
  fakeHost,
  serveConnection,
  waitFor,
} from "../../tests/helpers/bootedCore";
import { connectClient } from "../../tests/helpers/connectionClient";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import type { startConnection } from "./connection/connection";
import { claimLink } from "./devices/dial";
import { type Core, startCore } from "./index";
import { FEEDBACK_REQUEST_NOTE } from "./orchestrator/wakes";
import { catalogRefreshesSettled } from "./pi/modelRuntime";
import { seedTask } from "./tasks/seedTask";

/**
 * Intent: the approved /feedback plan's intake - a message that starts with
 * /feedback, typed in the main message box or a task's crewmate tab, on the
 * desktop or a paired phone, reaches the first mate as a feedback request,
 * never the task's crewmate. The whole core over its real connection; the
 * first mate's model is the stand-in, read only for what it was served.
 */
describe("a /feedback message reaches the first mate from every message box", () => {
  let userDataDir: string;
  let core: Core;
  let mock: MockProviderServer;
  let connection: ReturnType<typeof startConnection>;
  let at: string;

  const offline = process.env.PI_OFFLINE;

  beforeAll(async () => {
    process.env.PI_OFFLINE = "1";
    userDataDir = scratchDir("infinitary-core-feedback-");
    mock = await startMockProvider();
    mkdirSync(join(userDataDir, "auth"), { recursive: true, mode: 0o700 });
    writeFileSync(join(userDataDir, "auth", "models.json"), mockModelsJson(mock.port));
    core = await startCore(fakeHost(userDataDir).host);
    ({ connection, at } = await serveConnection(core));
  }, 120_000);

  afterAll(async () => {
    await connection?.close();
    await core?.dispose();
    await catalogRefreshesSettled();
    await mock?.close();
    rmSync(userDataDir, { recursive: true, force: true });
    if (offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = offline;
  }, 30_000);

  /** The first mate's requests after `from` that carry `words`, once its turn has ended. */
  async function servedAfter(from: number, words: string): Promise<string[]> {
    let found: string[] = [];
    await waitFor(() => {
      found = mock
        .requestBodies()
        .slice(from)
        .filter((body) => body.includes(words));
      return found.length > 0 && !core.services.firstmate.isBusy();
    }, 60_000);
    return found;
  }

  // The note as served: the runbook guide names its marker too, so the whole line is read.
  const note = FEEDBACK_REQUEST_NOTE;

  it("serves an ordinary message without the feedback note, and a /feedback one with it", async () => {
    const plain = mock.requestBodies().length;
    await core.dispatch("inf:converse", ["the build looks slow today"]);
    const ordinary = await servedAfter(plain, "the build looks slow today");
    expect(ordinary.some((body) => body.includes(note))).toBe(false);

    const typed = "/Feedback the merge card never showed its checks";
    const before = mock.requestBodies().length;
    await core.dispatch("inf:converse", [typed]);
    const served = await servedAfter(before, typed);
    expect(served.some((body) => body.includes(note))).toBe(true);
  }, 120_000);

  it("sends a phone's /feedback in a task's crewmate tab to the first mate, not the crewmate", async () => {
    seedTask(core.services.tasks, {
      id: "feedback-intake-task",
      title: "Speed up the build",
      status: "completed",
    });
    const { link } = await core.dispatch("inf:devices:invite", [{ kind: "mac", at }]);
    await connection.settled();
    const grant = await claimLink(link, { ...AT_FIRST_LAUNCH, name: "iPhone" });
    const phone = await connectClient(grant, { system: { system: "ios" } });
    try {
      // An ordinary line to a closed task is refused: it would be the crewmate's.
      const refused = await phone.invoke("inf:task:steer", [
        "feedback-intake-task",
        "please try again",
      ]);
      expect(refused).not.toEqual({ ok: true });

      const typed = "/feedback the crewmate tab lost my words";
      const before = mock.requestBodies().length;
      expect(await phone.invoke("inf:task:steer", ["feedback-intake-task", typed])).toEqual({
        ok: true,
      });
      const served = await servedAfter(before, typed);
      expect(served.some((body) => body.includes(note))).toBe(true);
    } finally {
      await core.dispatch("inf:devices:remove", [grant.deviceId]);
      await phone.closed;
    }
  }, 120_000);
});
