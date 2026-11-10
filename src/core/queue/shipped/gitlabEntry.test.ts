import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import { hostEnv } from "../../hostEnv";
import { GITLAB_QUEUE_PART, shippedFiles } from "../shipped";
import { HELD, TOKEN_VARIABLE } from "./gitlab.mjs";

// Regression: the Secrets journey's bundled ESM app imported the GitLab
// module, whose entry guard then started a queue job and exited before the
// app opened. Exercise that import with the real bundler and shipped files,
// and keep the queue's explicit jobs refusing absent authority. No token,
// account, network or app home is used; scratchDir owns the files.
// Integration budget: bundling and the three Node starts measured 80 ms
// together; the default five-second budget covers this isolated work.
// Each child ends with the test's signal, not a second wall-clock limit.
const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL("./", import.meta.url));
const { build } = createRequire(require.resolve("vite"))("esbuild") as {
  build: (options: unknown) => Promise<unknown>;
};

const execute = promisify(execFile);
function run(root: string, args: string[], signal: AbortSignal) {
  return execute(process.execPath, args, {
    cwd: root,
    // Keep only executable lookup, never the real shell's queue authority.
    env: { PATH: hostEnv().PATH, HOME: root },
    signal,
    encoding: "utf8",
  });
}

it("imports the GitLab module from a bundled ESM app without starting a queue job", async ({
  signal,
}) => {
  // Match Linux's canonical temporary path. A symlinked Mac path makes the
  // faulty URL/argv comparison false and would conceal this regression.
  const root = realpathSync(scratchDir("infinitary-queue-import-"));
  const entry = join(root, "entry.mjs");
  await build({
    stdin: {
      contents: `import { HELD } from ${JSON.stringify(join(source, "gitlab.mjs"))}; console.log(JSON.stringify({ held: HELD }));`,
      loader: "js",
      resolveDir: source,
    },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: entry,
  });
  const result = await run(root, [entry], signal);
  expect(JSON.parse(result.stdout)).toEqual({ held: HELD });
  expect(result.stderr).toBe("");
});

it("runs the shipped GitLab job commands explicitly and refuses missing authority", async ({
  signal,
}) => {
  const root = realpathSync(scratchDir("infinitary-queue-entry-"));
  for (const file of shippedFiles(source, GITLAB_QUEUE_PART)) {
    const path = join(root, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.text);
  }
  const yaml = createRequire(require.resolve("electron-builder/package.json"))("js-yaml") as {
    load: (text: string) => Record<string, { script?: string[] }>;
  };
  const jobs = yaml.load(readFileSync(join(root, GITLAB_QUEUE_PART.queueFile), "utf8"));
  const commands = Object.values(jobs).flatMap((job) =>
    (job.script ?? []).filter((line) => line.startsWith("node ")),
  );
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    await expect(run(root, command.split(" ").slice(1), signal)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(TOKEN_VARIABLE),
      stdout: "",
    });
  }
});
