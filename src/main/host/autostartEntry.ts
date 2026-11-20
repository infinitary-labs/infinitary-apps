import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Start at login on a Linux desktop (docs/architecture.md, "Desktop platform
 * facts"): an XDG autostart entry, `<config>/autostart/<name>.desktop`,
 * which the desktops the app supports start when the person signs in. The
 * config folder is `$XDG_CONFIG_HOME` (Electron's `appData` there), so an
 * isolated run writes into its own throwaway folder, never the person's.
 */
export type AutostartEntry = {
  /** `$XDG_CONFIG_HOME`, or `~/.config`. */
  configDir: string;
  /** The entry's file name without `.desktop`: one per flavor, as userData is. */
  name: string;
  /** The program and its arguments that start this app. */
  exec: readonly string[];
};

export function autostartPath(entry: Pick<AutostartEntry, "configDir" | "name">): string {
  return join(entry.configDir, "autostart", `${entry.name}.desktop`);
}

/**
 * Whether the entry starts the app at login. An entry a desktop's own
 * settings turned off (`Hidden=true`, or GNOME's
 * `X-GNOME-Autostart-enabled=false`) does not, and neither does none.
 */
export function readAutostart(entry: Pick<AutostartEntry, "configDir" | "name">): boolean {
  let text: string;
  try {
    text = readFileSync(autostartPath(entry), "utf8");
  } catch {
    return false;
  }
  return (
    !/^\s*Hidden\s*=\s*true\s*$/im.test(text) &&
    !/^\s*X-GNOME-Autostart-enabled\s*=\s*false\s*$/im.test(text)
  );
}

/** Writes the entry, or removes it; a failure throws, so Settings says it did not change. */
export function writeAutostart(entry: AutostartEntry, enabled: boolean): void {
  const path = autostartPath(entry);
  if (!enabled) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(join(entry.configDir, "autostart"), { recursive: true });
  writeFileSync(path, desktopEntry(entry.exec), { mode: 0o644 });
}

/** The entry's text (the freedesktop.org Desktop Entry Specification). */
export function desktopEntry(exec: readonly string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Infinitary",
    `Exec=${exec.map(execArgument).join(" ").replace(/\\/g, "\\\\")}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/**
 * One argument of `Exec`: `%` doubled, as it starts a field code; quoted
 * when it holds a space or another reserved character, with `"`, `` ` ``,
 * `$` and `\` escaped inside the quotes. `desktopEntry` then doubles every
 * backslash, because the value is a string whose own escapes come first.
 */
function execArgument(argument: string): string {
  const plain = argument.replace(/%/g, "%%");
  if (!/[\s"'\\><~|&;$*?#()`]/.test(plain)) return plain;
  return `"${plain.replace(/(["`$\\])/g, "\\$1")}"`;
}
