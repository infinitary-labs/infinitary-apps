import { spawn } from "node:child_process";
import { powerShellWord } from "@core/devices/joinCommand";
import { hostEnv } from "@core/hostEnv";
import { windowsPowerShell } from "@core/storage/ownerOnly";
import { RUN_INSTALLER_SCRIPT } from "@core/update/windowsInstall";

/** How long the hand-over waits for this program to end before it starts the app anyway. */
const EXIT_WAIT_S = 120;

/**
 * The script that starts the app again once this program has ended
 * (docs/reset.md, "Before it quits"): Windows keeps a folder a running
 * program holds, so the next start, which renames the folder aside, waits
 * for this one to end, as an update's hand-over does. Each argument is one
 * word of the new program's command line.
 */
export function windowsRestartScript(values: {
  pid: number;
  executable: string;
  args: readonly string[];
}): string {
  const words = values.args.map((arg) => powerShellWord(/[\s"]/.test(arg) ? `"${arg}"` : arg));
  // i18n-exempt: a PowerShell script Windows runs, never shown to a person
  return [
    `$old = Get-Process -Id ${values.pid} -ErrorAction SilentlyContinue`,
    `if ($old) { $old.WaitForExit(${EXIT_WAIT_S * 1000}) | Out-Null }`,
    words.length
      ? `Start-Process -FilePath ${powerShellWord(values.executable)} -ArgumentList @(${words.join(", ")})`
      : `Start-Process -FilePath ${powerShellWord(values.executable)}`,
  ].join("\n");
}

/**
 * Asks Windows' own process service to start the app again once this program
 * ends, through the update's starter (`RUN_INSTALLER_SCRIPT`), so the
 * hand-over outlives this program. True once Windows started it; false
 * leaves the restart to the app's own relaunch.
 */
export function restartOnWindows(
  values: { pid: number; executable: string; args: readonly string[] },
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  return new Promise((resolve) => {
    const env = hostEnv();
    try {
      const child = spawnImpl(
        windowsPowerShell(env),
        ["-NoProfile", "-NonInteractive", "-Command", RUN_INSTALLER_SCRIPT],
        {
          env: {
            ...env,
            INFINITARY_UPDATE_HAND_OVER: Buffer.from(
              windowsRestartScript(values),
              "utf16le",
            ).toString("base64"),
          },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
