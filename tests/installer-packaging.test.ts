import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { notarizationRunner } from "../scripts/installer-notarize.ts";
import { hostEnv } from "../src/core/hostEnv";
import { scratchDir } from "./helpers/scratchDirs";

const require = createRequire(import.meta.url);
const builderRoot = dirname(
  require.resolve("app-builder-lib/package.json", { paths: [require.resolve("electron-builder")] }),
);
const { validateSchema } = require(join(builderRoot, "out/util/config/schemaValidator.js"));
const schema = require(join(builderRoot, "scheme.json"));

// INF-816: exercise the actual build commands up to the packager boundary.
// The stand-in packager stops before any signing; no Apple credential is used.
it.each(["build-installer-fixtures.sh", "build-mac-dmg.sh"])(
  "%s disables the packager's duplicate notarization",
  (script) => {
    const root = scratchDir("inf-installer-packaging-");
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const fixtures = join(root, "tests/fixtures/installed-updates");
    for (const folder of [scripts, bin, fixtures]) mkdirSync(folder, { recursive: true });
    copyFileSync(join("scripts", script), join(scripts, script));
    copyFileSync("tests/fixtures/installed-updates/versions.json", join(fixtures, "versions.json"));
    // Environment admission has its own behavioral tests. Bypass only that
    // boundary in this throwaway script copy, never on an actual signing run.
    writeFileSync(join(scripts, "installer-environment.ts"), "// No signing in this fixture.\n");
    const calls = join(root, "packager-args");
    writeFileSync(
      join(bin, "pnpm"),
      '#!/bin/bash\nprintf "%s\\n" "$@" > "$PACKAGER_ARGS"\nexit 73\n',
      { mode: 0o755 },
    );
    const app = join(root, "Infinitary.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    const versions = JSON.parse(readFileSync(join(fixtures, "versions.json"), "utf8"));
    const env = {
      ...hostEnv(),
      PATH: `${bin}:${hostEnv().PATH}`,
      PACKAGER_ARGS: calls,
      RUNNER_TEMP: root,
      INSTALLER_FIXTURES: join(root, "fixtures"),
      INSTALLER_EVIDENCE: join(root, "evidence"),
      CSC_KEYCHAIN: join(root, "unused.keychain"),
      APPLE_API_KEY: join(root, "unused.p8"),
      APPLE_API_KEY_ID: "unused",
      APPLE_API_ISSUER: "unused",
      SIGN_IDENTITY: "unused",
    };
    const args =
      script === "build-mac-dmg.sh" ? [app, versions.alphaBefore, env.INSTALLER_FIXTURES] : [];
    expect(() =>
      execFileSync("bash", [join(scripts, script), ...args], { cwd: root, env, stdio: "pipe" }),
    ).toThrow();
    const recorded = readFileSync(calls, "utf8").trim().split("\n");
    const override = recorded.find((argument) => argument.startsWith("-c.mac.notarize="));
    expect(override).toBeDefined();
    const config = { mac: { notarize: override?.split("=")[1] } };
    // The installed packager's own schema coercion must produce a boolean,
    // not the truthy string that would leave its automatic notarization on.
    validateSchema(schema, config);
    expect(config.mac.notarize).toBe(false);
    console.log(JSON.stringify({ script, packagerNotarization: config.mac.notarize }));
    expect(
      recorded.slice(recorded.indexOf("--publish"), recorded.indexOf("--publish") + 2),
    ).toEqual(["--publish", "never"]);
    expect(recorded).toContain(`-c.extraMetadata.version=${versions.alphaBefore}`);
  },
);

// INF-643 run 39874845604: a submit cannot share the short status deadline.
// Replay the real early output from run 39712112107/job 119605613318 in a
// local child that cannot finish until its output reaches the observer.
// No Apple program or credential is involved; the existing 5 s cohort budget holds.
const received = "Submission ID received\n  id: 1c958e60-ed9e-4947-9324-fb5519463ba9\n";

/** The upload stand-in: it finishes when the test writes `finish`, or leaves when its folder goes. */
function uploadStandIn(root: string): string {
  const script = join(root, "upload.mjs");
  writeFileSync(
    script,
    `import { existsSync } from 'node:fs';
import { join } from 'node:path';
const root = ${JSON.stringify(root)};
// It reads its folder rather than watching it: under a busy file-change indexer
// a watch event can arrive seconds past the test budget. A test that ends before writing
// finish still removes this folder, and the stand-in leaves with it (INF-2570).
const poll = setInterval(() => {
  if (!existsSync(root)) return clearInterval(poll);
  if (!existsSync(join(root, 'finish'))) return;
  clearInterval(poll);
  process.stdout.write('Successfully uploaded file\\n');
}, 100);
process.stdout.write(${JSON.stringify(received)});
`,
  );
  return script;
}

it.each(["complete", "journal-refused"] as const)(
  "streams upload output before process exit and handles %s without leaking the child",
  async (outcome) => {
    const root = scratchDir("inf-notary-process-");
    const script = uploadStandIn(root);
    let child: ReturnType<typeof spawn> | undefined;
    onTestFinished(() => {
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    const run = notarizationRunner(hostEnv(), (_command, _args, options) => {
      expect(options.timeout).toBeUndefined();
      const upload = spawn(process.execPath, [script], options);
      child = upload;
      return upload;
    });
    const journalError = new Error("The submission journal could not be saved");
    let observed = "";
    let receivedBeforeExit = false;
    const completed = run("/usr/bin/xcrun", ["notarytool", "submit", "fixture.dmg"], (chunk) => {
      observed += chunk;
      if (receivedBeforeExit || !observed.includes(received)) return;
      receivedBeforeExit = true;
      expect(child?.exitCode).toBeNull();
      if (outcome === "journal-refused") throw journalError;
      writeFileSync(join(root, "finish"), "finish");
    });
    if (outcome === "journal-refused") {
      await expect(completed).rejects.toBe(journalError);
      expect(child?.signalCode).toBe("SIGKILL");
    } else {
      await expect(completed).resolves.toMatchObject({
        status: 0,
        stdout: `${received}Successfully uploaded file\n`,
      });
      expect(child?.exitCode).toBe(0);
    }
    console.log(JSON.stringify({ outcome, receivedBeforeExit }));
  },
);

// INF-2570: a stand-in left waiting for a finish that never came kept an
// 8-processor, 7.8 GiB load reservation booked for six hours after its test ended.
it("the upload stand-in exits once its scratch folder is removed", async () => {
  const root = scratchDir("inf-notary-orphan-");
  const child = spawn(process.execPath, [uploadStandIn(root)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let output = "";
  await new Promise<void>((resolve) =>
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes(received)) resolve();
    }),
  );
  expect(child.exitCode).toBeNull();
  rmSync(root, { recursive: true, force: true });
  expect(await exited).toBe(0);
  expect(output).toBe(received);
});

it.each([
  "scripts/installer-environment.ts",
  "scripts/installer-notarize.ts",
  "scripts/installer-reuse.ts",
  "scripts/installer-feed-server.mjs",
])("%s refuses outside Actions before any verification effect", (script) => {
  expect(() =>
    execFileSync(process.execPath, [script], {
      env: { ...hostEnv(), GITHUB_ACTIONS: "false" },
      stdio: "pipe",
    }),
  ).toThrow("requires a disposable Actions Mac");
});
