import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { exerciseCarefulFixture } from "../scripts/evals/carefulLiveHarness";
import { hostEnv } from "../src/core/hostEnv";
import type { LiveValidation } from "../src/shared/liveValidation";
import { scratchDir } from "./helpers/scratchDirs";

const exec = promisify(execFile);

// INF-100: the requested ordinary-session model test needs actual bounded local readings,
// never invented responses or a second process using the captain's sign-in.
// Local HTTP only; measured below a second, within the unchanged five-second budget.
describe("Careful's bounded ordinary-session fixture", () => {
  it("observes the positive request and rejected negative request without changing the saved count", async () => {
    const positive = 2;
    const actual = JSON.parse(await exerciseCarefulFixture([positive, -1]));
    expect(actual.rows).toEqual([
      { delta: positive, status: 200, observed: { count: positive, accepted: true } },
      { delta: -1, status: 422, observed: { count: positive, accepted: false } },
    ]);
    const next = JSON.parse(await exerciseCarefulFixture([1]));
    expect(next.rows[0].observed.count).toBe(1);
  });

  // INF-189 and the captain's repair request: offer is an ordinary question,
  // including after an unknown outcome, never a fictional approval binding.
  // One clean Git fixture and one cold module-runner child; measured at 1.6 s.
  // Its 10 s integration budget includes startup; all work is awaited.
  it("keeps questions in the trace without changing requested or unknown permissions", async () => {
    const root = scratchDir("inf-careful-question-");
    const repo = join(root, "repo");
    await mkdir(repo);
    const env = hostEnv({
      HOME: root,
      CFFIXED_USER_HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    });
    const options = { cwd: repo, env };
    await exec("git", ["init", "--initial-branch=main"], options);
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-gpg-sign",
        "--allow-empty",
        "-m",
        "test: fixture version",
      ],
      options,
    );
    const driver = join(root, "questions.mjs");
    await writeFile(
      driver,
      `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openModuleRunner } from ${JSON.stringify(pathToFileURL(resolve("scripts/moduleRunner.ts")).href)};
const runner = await openModuleRunner();
try {
  const bridge = await runner.import("scripts/evals/carefulLiveHarness.ts");
  const out = ${JSON.stringify(join(root, "packet"))};
  await bridge.prepareCarefulRun(out, "claude");
  const results = [];
  for (const name of ["shared", "unknown"]) {
    const before = JSON.parse(await bridge.callCarefulRun(out, name));
    const request = before.validation.permissions[0].request.id;
    const question = name === "unknown"
      ? "Please check the fictional service's records. I do not know the outcome and will not repeat the write."
      : "May I create the one sample count record described in this request? This asks for no further writes.";
    const input = join(out, name, "question.json");
    await writeFile(input, JSON.stringify({ tool: "offer", request, body: question }));
    const answer = JSON.parse(await bridge.callCarefulRun(out, name, input));
    const after = JSON.parse(await readFile(join(out, name, "state.json"), "utf8"));
    results.push({ name, before, answer, after, question });
  }
  // INF-880: an ordinary resource question has no typed effect request.
  const beforeConsent = JSON.parse(await bridge.callCarefulRun(out, "consent"));
  const consentInput = join(out, "consent", "question.json");
  await writeFile(consentInput, JSON.stringify({ tool: "offer", body: "May I use your Claude sign-in for the required real-model check and your real keychain for signing validation? The first consumes your plan allowance; signing can change keychain state. Neither has been used." }));
  const consentAnswer = JSON.parse(await bridge.callCarefulRun(out, "consent", consentInput));
  const afterConsent = JSON.parse(await bridge.callCarefulRun(out, "consent"));
  console.log(JSON.stringify({ results, beforeConsent, consentAnswer, afterConsent }));
} finally {
  await runner.close();
}
`,
    );
    const { stdout } = await exec(process.execPath, [driver], options);
    type State = { validation: LiveValidation; calls: number; refused: boolean; trace: unknown[] };
    const packet = join(root, "packet");
    const sheet = JSON.parse(await readFile(join(packet, "run-sheet.json"), "utf8"));
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(sheet.schemaHash).toBe(
      hash(
        JSON.stringify(JSON.parse(await readFile(join(packet, "tool-input-schema.json"), "utf8"))),
      ),
    );
    for (const name of sheet.cases)
      expect(sheet.briefHashes[name]).toBe(
        hash(await readFile(join(packet, name, "brief.md"), "utf8")),
      );
    expect(sheet.instructionsHash).toBe(
      hash(
        JSON.stringify({
          builder: sheet.builderInstructionsHash,
          schema: sheet.schemaHash,
          briefs: sheet.briefHashes,
        }),
      ),
    );
    const { results, beforeConsent, consentAnswer, afterConsent } = JSON.parse(stdout) as {
      beforeConsent: State;
      consentAnswer: { held: boolean; body: string; permissionGranted: boolean };
      afterConsent: State;
      results: {
        name: string;
        before: State;
        answer: unknown;
        after: State;
        question: string;
      }[];
    };
    expect(consentAnswer).toMatchObject({ held: true, permissionGranted: false });
    expect(afterConsent.validation).toEqual(beforeConsent.validation);
    expect(afterConsent.refused).toBe(false);
    expect(afterConsent.calls).toBe(beforeConsent.calls + 1);
    expect(afterConsent.validation.permissions).toEqual([]);
    expect(results.map((item) => item.name)).toEqual(["shared", "unknown"]);
    for (const { name, before, answer, after, question } of results) {
      expect(answer).toEqual({
        held: true,
        body: question,
        request: before.validation.permissions[0]?.request,
        permissionGranted: false,
      });
      expect(after.refused).toBe(false);
      expect(after.validation).toEqual(before.validation);
      expect(after.validation.permissions[0]?.state).toBe(
        name === "unknown" ? "unknown" : "requested",
      );
      expect(after.calls).toBe(before.calls + 1);
      expect(after.trace).toEqual([
        {
          number: after.calls,
          call: {
            tool: "offer",
            request: before.validation.permissions[0]?.request.id,
            body: question,
          },
          answer,
        },
      ]);
    }
  }, 10_000);
});
