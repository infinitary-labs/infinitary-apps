import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shellWord } from "../../src/core/devices/shellWord";
import { scratchDir } from "./scratchDirs";

/**
 * This Mac's own privacy log from INF-1169's whole-disk search on
 * 2026-10-24 (`tests/fixtures/privacy-log/`, docs/macos-privacy.md): the
 * app-data request whose lines a stand-in prints.
 */
const REQUEST = readFileSync(
  new URL("../fixtures/privacy-log/whole-disk-search.ndjson", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.includes("msgID=4855.321,"));

/** The pids that log names, which the stand-in replaces with its own. */
const LOGGED_APP = "pid=58701";
const LOGGED_CREWMATE = "pid=35236";

function line(kind: string): string {
  const found = REQUEST.find((text) => text.includes(`"AUTHREQ_${kind}:`));
  if (!found) throw new Error(`The privacy log fixture has no ${kind} line`);
  return found;
}

/**
 * A stand-in for macOS's log reader (`INFINITARY_PRIVACY_LOG`,
 * docs/macos-privacy.md), so a journey never reads this Mac's own privacy
 * log. It prints nothing until `ask(dir)`: then it moves into `dir`, as a
 * crewmate's command works in its working copy, and prints the request's
 * context and attribution lines with the app as responsible (its parent)
 * and itself as the process that reached the data, as tccd does while a
 * dialog is up. `answer` prints the result line macOS writes once a person
 * answers. It then waits until the app stops it.
 */
export function standInPrivacyLog(): {
  program: string;
  ask: (dir: string) => Promise<void>;
  answer: (value: "allowed" | "refused") => Promise<void>;
} {
  const dir = scratchDir("infinitary-privacy-log-");
  const program = join(dir, "log");
  const asked = join(dir, "ask");
  const answered = join(dir, "answer");
  execFileSync("/usr/bin/mkfifo", [asked, answered]);
  const [before, after] = line("ATTRIBUTION").split(LOGGED_APP);
  const [middle, rest] = (after ?? "").split(LOGGED_CREWMATE);
  if (!before || !middle || !rest) throw new Error("The attribution line names no pids");
  const result = line("RESULT");
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      `read dir < ${shellWord(asked)}`,
      'cd "$dir" || exit 1',
      `printf '%s\\n' ${shellWord(line("CTX"))}`,
      `printf '%s%s%s%s%s\\n' ${shellWord(before)} "pid=$PPID" ${shellWord(middle)} "pid=$$" ${shellWord(rest)}`,
      `read value < ${shellWord(answered)}`,
      `printf '%s%s%s\\n' ${shellWord(result.split("authValue=2")[0] ?? "")} "authValue=$value" ${shellWord(result.split("authValue=2")[1] ?? "")}`,
      // It waits as the log reader does, until the app stops it.
      `read never < ${shellWord(asked)}`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return {
    program,
    ask: (folder) => writeFile(asked, `${folder}\n`),
    answer: (value) => writeFile(answered, `${value === "allowed" ? 2 : 0}\n`),
  };
}
