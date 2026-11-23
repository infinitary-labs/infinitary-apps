import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { claimedPort } from "./helpers/claimedPort";
import { loadYamlFile } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * Release run 43797927228 lost seven of its eight Linux package checks at
 * actions/checkout: GitHub answered "Repository not found." to every job's
 * token for about three minutes, past the action's own three tries in about
 * 40 seconds. Every checkout of main's check and of a release is followed by
 * a wait for GitHub to take the token again, then the same checkout once more
 * (docs/testing.md, "GitHub refusing a job's token";
 * tests/workflow-hygiene.test.ts holds every checkout to it). These run that
 * wait as a runner does, against a stand-in for GitHub's git address.
 */

type Step = { name?: string; env?: Record<string, string>; run?: string };
const main = loadYamlFile(".github/workflows/main.yml") as {
  jobs: { sort: { steps: Step[] } };
};
const wait = main.jobs.sort.steps.find(
  (step) => step.name === "Wait until GitHub takes the job's token",
);
const TOKEN = "ghs_standInJobToken0123456789";
const REPOSITORY = "owner/project";

/**
 * GitHub's git address as checkout's first fetch reads it: each answer of
 * `refusals` in turn, "Repository not found." for a 404 as GitHub words it,
 * then the refs.
 */
async function standIn(refusals: number[]) {
  const asked: { url: string; authorization: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    asked.push({ url: request.url ?? "", authorization: request.headers.authorization });
    const refused = refusals[asked.length - 1];
    if (refused !== undefined) {
      response.writeHead(refused).end(refused === 404 ? "Repository not found." : "");
      return;
    }
    response
      .writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement" })
      .end("001e# service=git-upload-pack\n0000");
  });
  const port = await claimedPort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}`,
    asked,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("the wait after a refused checkout", () => {
  let folder: string;
  let server: Awaited<ReturnType<typeof standIn>> | undefined;
  let curlArgs: string;
  let bin: string;

  beforeEach(() => {
    folder = scratchDir("infinitary-checkout-patience-");
    // curl as the step finds it on the PATH, recording the command line it
    // was given before it runs the real one.
    const real = spawnSync("bash", ["-c", "command -v curl"], {
      env: hostEnv(),
      encoding: "utf8",
    }).stdout.trim();
    expect(real).not.toBe("");
    bin = join(folder, "bin");
    curlArgs = join(folder, "curl-args");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "curl"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${curlArgs}'\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(bin, "curl"), 0o755);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * The step as a runner runs it, beside the test, since the stand-in
   * answering it listens in this process: `bash -e` with no shell named, or
   * `bash -eo pipefail` with `shell: bash`.
   */
  function runWait(serverUrl: string, env: Record<string, string>, pipefail = false) {
    const args = [
      "--noprofile",
      "--norc",
      pipefail ? "-eo" : "-e",
      ...(pipefail ? ["pipefail"] : []),
    ];
    const child = spawn("bash", [...args, "-c", wait?.run ?? ""], {
      cwd: folder,
      env: {
        ...hostEnv(),
        PATH: `${bin}${delimiter}${hostEnv().PATH ?? ""}`,
        GITHUB_SERVER_URL: serverUrl,
        GITHUB_REPOSITORY: REPOSITORY,
        TOKEN,
        // It asks every 15 seconds on a runner.
        CHECKOUT_PAUSE_SECONDS: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stdout, stderr }));
      },
    );
  }

  function expectAskedAsCheckout(asked: { url: string; authorization: string | undefined }[]) {
    const basic = `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`;
    for (const request of asked)
      expect(request).toEqual({
        url: `/${REPOSITORY}/info/refs?service=git-upload-pack`,
        authorization: basic,
      });
    // The token reached curl on its input, never on its command line.
    expect(readFileSync(curlArgs, "utf8")).not.toContain(TOKEN);
  }

  it("is the step every checkout of main's check and a release waits with", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(wait?.env).toEqual({ TOKEN: "${{ github.token }}" });
  });

  for (const pipefail of [false, true])
    it(`waits while GitHub refuses the job's token, then lets the checkout try again (${pipefail ? "bash -eo pipefail" : "bash -e"})`, async () => {
      server = await standIn([404, 503, 401]);
      const result = await runWait(server.url, {}, pipefail);
      expect(result.status, result.stderr).toBe(0);
      expect(server.asked).toHaveLength(4);
      expectAskedAsCheckout(server.asked);
      const lines = result.stdout.trim().split("\n");
      expect(lines.map((line) => line.replace(/after \d+s/, "after Ns"))).toEqual([
        "GitHub answered 404 to the job's token after Ns; asking again in 0s",
        "GitHub answered 503 to the job's token after Ns; asking again in 0s",
        "GitHub answered 401 to the job's token after Ns; asking again in 0s",
      ]);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
    });

  it("lets the checkout try again at once when GitHub takes the token, as after a missing commit", async () => {
    server = await standIn([]);
    const result = await runWait(server.url, {});
    expect([result.status, result.stdout, result.stderr]).toEqual([0, "", ""]);
    expect(server.asked).toHaveLength(1);
    expectAskedAsCheckout(server.asked);
  });

  it("leaves the last word to the checkout once its patience is spent", async () => {
    server = await standIn(Array.from({ length: 100 }, () => 404));
    const result = await runWait(server.url, { CHECKOUT_PATIENCE_SECONDS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(server.asked).toHaveLength(1);
    expect(result.stdout.trim()).toMatch(
      /^::warning title=GitHub still refuses the job's token::It answered 404 after \d+s; the checkout tries once more\.$/,
    );
  });

  it("waits for a host that does not answer as for a refusal", async () => {
    // A loopback port nothing listens on: every connection is refused.
    const nothing = `http://127.0.0.1:${await claimedPort()}`;
    const result = await runWait(nothing, { CHECKOUT_PATIENCE_SECONDS: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(
      /^::warning title=GitHub still refuses the job's token::It answered 000 after \d+s; the checkout tries once more\.$/,
    );
    expect(existsSync(curlArgs)).toBe(true);
  });
});
