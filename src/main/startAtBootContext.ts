import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { systemSystemctl } from "@core/helper/background";
import { appLauncher } from "@core/helper/launcher";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import { findOnPath } from "@core/userBin";
import { runLabelOf } from "@shared/codeNames";
import { SETTING_PREFIXES, settingFrom } from "@shared/envSettings";
import { app } from "electron";
import { BOOT_WORDS, type BootResult, bootAsked, helpWords, runStartAtBoot } from "./startAtBoot";
import { packagedFlavor, readPackageJsonAt } from "./userDataDir";

/**
 * What `start-at-boot` and `help` read of this app and this user (./startAtBoot.ts).
 * A development run may stand in its own systemctl and loginctl, so a test
 * never sets up a real service, and the service it writes carries the
 * settings that chose its data folder; an installed app reads neither.
 */
const CARRIED = [
  ...["USER_DATA_DIR", "FOLDER_SPELLING"].flatMap((name) =>
    SETTING_PREFIXES.map((prefix) => `${prefix}${name}`),
  ),
  "PI_OFFLINE",
];

export async function answerBootCommand(
  asked: { boot: string[] | null; help: string[] | null },
  dataDir: string,
): Promise<BootResult> {
  const env = process.env;
  const launcher = appLauncher({
    packaged: app.isPackaged,
    platform: hostPlatform(),
    execPath: process.execPath,
    appDir: app.getAppPath(),
    resourcesDir: process.resourcesPath,
    env,
  });
  if (asked.help) {
    const answer = helpWords(asked.help, launcher);
    const text = `${answer.lines.join("\n")}\n`;
    return answer.code === 0
      ? { code: 0, out: text, error: "" }
      : { code: answer.code, out: "", error: text };
  }
  const words = bootAsked(asked.boot ?? []);
  if (!words) return { code: 2, out: "", error: `${BOOT_WORDS.usage.join("\n")}\n` };
  const program = (name: "SYSTEMCTL" | "LOGINCTL", command: string) => {
    const path = app.isPackaged ? undefined : settingFrom(env, name)?.trim();
    const found = path || findOnPath(command, hostEnv());
    return found ? systemSystemctl(found) : null;
  };
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const flavor = app.isPackaged ? packagedFlavor(readPackageJsonAt(app.getAppPath())) : "dev";
  return runStartAtBoot(words, {
    platform: hostPlatform(),
    user: userInfo().username,
    homeDir: homedir(),
    unitsDir: join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "systemd", "user"),
    daemonsDir: "/Library/LaunchDaemons",
    label: runLabelOf(flavor),
    launcher,
    dataDir,
    env: app.isPackaged
      ? {}
      : Object.fromEntries(
          CARRIED.flatMap((name) => {
            const value = env[name];
            return value ? [[name, value]] : [];
          }),
        ),
    cwd: process.cwd(),
    systemctl: program("SYSTEMCTL", "systemctl"),
    loginctl: program("LOGINCTL", "loginctl"),
  });
}
