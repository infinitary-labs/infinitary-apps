import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { RUN_INSTALLER_SCRIPT } from "@core/update/windowsInstall";
import { describe, expect, it } from "vitest";
import { restartOnWindows } from "./windowsRestart";

/**
 * A Windows reset starts the app again only once this program ended (the
 * approved plan: "the Windows restart through the updater's wait-then-start
 * helper"), so the next start finds the folder free to rename aside.
 */

function windows(exitCode: number) {
  const asked: { command: readonly string[]; script: string }[] = [];
  const fake = ((
    _program: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ) => {
    const encoded = options.env.INFINITARY_UPDATE_HAND_OVER ?? "";
    asked.push({ command: args, script: Buffer.from(encoded, "base64").toString("utf16le") });
    const child = new EventEmitter();
    setImmediate(() => child.emit("exit", exitCode));
    return child;
  }) as unknown as typeof spawn;
  return { asked, fake };
}

describe("restarting after a reset on Windows", () => {
  it("hands Windows a script that waits for this program, then starts the app with its words", async () => {
    const at = windows(0);
    const started = await restartOnWindows(
      {
        pid: 4242,
        executable: "C:\\Users\\someone\\AppData\\Local\\Programs\\Infinitary\\Infinitary.exe",
        args: ["--user-data-dir=C:\\Data Folder"],
      },
      at.fake,
    );
    expect(started).toBe(true);
    const [{ command, script }] = at.asked as [(typeof at.asked)[number]];
    expect(command.at(-1)).toBe(RUN_INSTALLER_SCRIPT);
    const lines = script.split("\n");
    expect(lines[0]).toContain("Get-Process -Id 4242");
    expect(lines[1]).toContain("WaitForExit");
    expect(lines[2]).toBe(
      "Start-Process -FilePath 'C:\\Users\\someone\\AppData\\Local\\Programs\\Infinitary\\Infinitary.exe' -ArgumentList @('\"--user-data-dir=C:\\Data Folder\"')",
    );
  });

  it("answers false when Windows refused to start it, so the app relaunches itself", async () => {
    expect(
      await restartOnWindows(
        { pid: 1, executable: "C:\\Infinitary.exe", args: [] },
        windows(1).fake,
      ),
    ).toBe(false);
  });
});
