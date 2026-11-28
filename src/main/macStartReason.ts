import { execFile } from "node:child_process";
import { hostEnv } from "@core/hostEnv";

export type MacStartReason = { kind: "reason"; text: string } | { kind: "unreadable" } | null;

/** Read only launchd's failure for this account's job after this start was requested. */
export function macStartReasonFromLog(
  output: string,
  uid: number,
  label: string,
  startedAt: number,
): MacStartReason {
  // i18n-exempt: macOS's fixed log-store refusal is an input signature.
  if (output.includes("Could not open local log store: Operation not permitted"))
    return { kind: "unreadable" };
  const identity = `gui/${uid}/${label}`;
  let reason: string | null = null;
  for (const line of output.split("\n")) {
    const match =
      /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+.*?launchd\[.*?\]\s+\[(.*?)\]\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, timestamp, subsystem, message] = match;
    if (!timestamp || !subsystem || !message) continue;
    const at = Date.parse(timestamp.replace(" ", "T"));
    if (!Number.isFinite(at) || at < startedAt) continue;
    const containsIdentity = (text: string, value: string) => {
      const index = text.indexOf(value);
      return index >= 0 && !/[\w.-]/.test(text[index + value.length] ?? "");
    };
    const accountSubsystem = subsystem === `gui/${uid}` || subsystem.startsWith(`gui/${uid} `);
    if (
      !containsIdentity(subsystem, identity) &&
      !containsIdentity(message, identity) &&
      !(accountSubsystem && containsIdentity(message, label))
    )
      continue;
    if (
      /^(Service could not initialize:|Could not find and\/or execute program specified by service:)/.test(
        message,
      )
    )
      reason = message;
  }
  return reason ? { kind: "reason", text: reason } : null;
}

export function readMacStartReason(
  uid: number,
  label: string,
  startedAt: number,
): Promise<MacStartReason> {
  const seconds = Math.max(1, Math.ceil((Date.now() - startedAt) / 1000) + 1);
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/log",
      [
        "show",
        "--last",
        `${seconds}s`,
        "--style",
        "compact",
        "--predicate",
        // i18n-exempt: this is a macOS log predicate, not displayed text.
        `process == "launchd" AND (subsystem CONTAINS ${JSON.stringify(label)} OR eventMessage CONTAINS ${JSON.stringify(label)})`,
      ],
      { env: hostEnv(), timeout: 15_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const result = macStartReasonFromLog(`${stdout}\n${stderr}`, uid, label, startedAt);
        resolve(error && result?.kind !== "unreadable" ? null : result);
      },
    );
  });
}
