import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { beforeAll, expect, it } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { disposableCustody } from "../../../tests/helpers/disposableCustody";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { hostEnv } from "../hostEnv";
import { hostPlatform } from "../platform";
import { ProtectedSecrets } from "../secrets/protected";
import { SECRETS_COMMAND, SecretRequests } from "../secrets/requests";
import { forkChildProcess } from "../sql/forkChildProcess";
import { findWindowsGit } from "../windowsGit";
import { AxiChannel } from "./channel";

let entry: string;
beforeAll(async () => {
  entry = await bundleAxiProcess();
}, 60_000);

it("checks, requests and cancels from the task command's own working folder", async () => {
  const cwd = realpathSync(scratchDir("secret-task-command-"));
  const program = realpathSync(process.execPath);
  const backend = await ProtectedSecrets.open({
    dir: scratchDir("secret-command-owner-"),
    custody: disposableCustody(),
    initialize: true,
    environment: () => ({ PATH: dirname(program) }),
  });
  await backend.putSecret("example", "Example", Buffer.from("invented"), { discoverable: true });
  const owner = new SecretRequests(backend);
  const host = hostEnv();
  const shell = hostPlatform() === "win32" ? (await findWindowsGit(host))?.bash : "/bin/sh";
  if (!shell) throw new Error("The Windows task shell needs Git Bash.");
  const binDir = resolve(__dirname, "../../../resources/axi-bin");
  const channel = await AxiChannel.open({
    spawner: forkChildProcess(entry),
    binDir,
    version: "1.0.0-test",
    keysDir: scratchDir("secret-command-channel-"),
  });
  try {
    const grant = channel.grant("folder-test", { secrets: owner });
    const run = async (...args: string[]) => {
      const { stdout } = await promisify(execFile)(
        shell,
        [join(binDir, SECRETS_COMMAND).replaceAll("\\", "/"), ...args],
        {
          cwd,
          env: { PATH: host.PATH, SystemRoot: host.SystemRoot, HOME: cwd, ...grant.env },
        },
      );
      return decode(stdout);
    };
    const env = JSON.stringify({ EXAMPLE: "example" });
    for (const executable of [basename(program), program]) {
      expect(await run("check", "--env", env, "--", executable)).toMatchObject({
        check: { decision: "ask", folder: cwd, program },
      });
    }
    expect(owner.receipts()).toEqual([]);
    const waiting = await run(
      "inject",
      "--env",
      env,
      "--reason",
      "Check task folder",
      "--id",
      "example",
      "--",
      program,
    );
    const [receipt] = owner.receipts();
    expect(waiting).toMatchObject({ receipt: { request: receipt.request, state: "waiting" } });
    expect(await run("cancel", receipt.request)).toMatchObject({
      receipt: { request: receipt.request, state: "cancelled" },
    });
  } finally {
    channel.close();
  }
});
