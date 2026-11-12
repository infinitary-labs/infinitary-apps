import { spawn } from "node:child_process";
import { ANTIGRAVITY_PROVIDER_ID } from "@shared/antigravity";
import { hostEnv } from "../hostEnv";
import type { PushedWindow } from "../quota/pushedQuota";
import { resolveAgyExecutable } from "./agyExecutable";
import { parseUsageReport } from "./usageReport";

/**
 * The Antigravity allowance, read only when the person asks for it
 * (INF-3776, the captain's approved plan; docs/antigravity-client.md, "The
 * allowance"). The program's own print-mode usage report
 * (`agy -p /usage --output-format json`) answers without starting a turn,
 * spending any of the plan or leaving a conversation behind, so it is the
 * one read: it runs when the person opens Subscriptions or presses Recheck
 * allowance, never on a timer, never while the account is signed out (a
 * signed-out program opens a browser to sign in) and with the program's
 * own automatic update switched off for the run. Nothing here reads the
 * program's saved sign-in or calls Google.
 */

/** How long the program may take to answer; its own limit, `--print-timeout`, is shorter. */
const REPORT_WAIT_MS = 30_000;

/** The program's own limit on the report, passed as `--print-timeout`. */
const PRINT_TIMEOUT = "20s";

/** More output than a usage report ever prints: the read stops there. */
const REPORT_OUTPUT_MAX_BYTES = 1024 * 1024;

/** How the read starts the program; a stand-in replaces it in tests. */
export type AgyUsageLaunch = (
  env: NodeJS.ProcessEnv,
) => { command: string; args: string[] } | undefined;

export const defaultAgyUsageLaunch: AgyUsageLaunch = (env) => {
  const command = resolveAgyExecutable(env);
  return command
    ? {
        command,
        args: ["-p", "/usage", "--output-format", "json", "--print-timeout", PRINT_TIMEOUT],
      }
    : undefined;
};

/**
 * The environment the report runs in: the host's, with the program's own
 * automatic update off, so a read never installs a new version, and its
 * account line hidden, so the person's address never reaches the output.
 */
export function usageEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, AGY_CLI_DISABLE_AUTO_UPDATE: "1", AGY_CLI_HIDE_ACCOUNT_INFO: "1" };
}

/** What one read found: the plan's windows, or why there are none. */
export type UsageRead =
  | { status: "ok"; windows: PushedWindow[] }
  | { status: "missing" }
  | { status: "unreadable"; detail: string };

/** Runs the program's usage report once and reads its windows. */
export async function readUsageReport(options: {
  launch?: AgyUsageLaunch;
  env?: NodeJS.ProcessEnv;
  waitMs?: number;
  now?: () => number;
}): Promise<UsageRead> {
  const env = usageEnv(options.env ?? hostEnv());
  const launch = (options.launch ?? defaultAgyUsageLaunch)(env);
  if (!launch) return { status: "missing" };
  const now = options.now ?? Date.now;
  const output = await new Promise<{ code: number | null; stdout: string } | Error>((resolve) => {
    const child = spawn(launch.command, launch.args, { env, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), options.waitMs ?? REPORT_WAIT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > REPORT_OUTPUT_MAX_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.once("error", (caught) => {
      clearTimeout(timer);
      resolve(caught);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
  });
  if (output instanceof Error) return { status: "unreadable", detail: output.message };
  if (output.code !== 0) return { status: "unreadable", detail: `exit ${output.code ?? "signal"}` };
  const windows = parseUsageReport(output.stdout, now());
  return windows ? { status: "ok", windows } : { status: "unreadable", detail: "no plan windows" };
}

export type AntigravityAllowanceDeps = {
  /** The connected Antigravity accounts, each with whether a session found it signed out. */
  accounts: () => { id: string; enabled: boolean; signedOut: boolean }[];
  /** Keeps one window's reading for the account (`PushedQuotaStore.record`). */
  record: (accountId: string, window: PushedWindow) => void;
  read?: () => Promise<UsageRead>;
};

/**
 * Reads the allowance on the person's press. The program keeps one
 * sign-in for the whole user, so one report answers for the one account
 * (`MACHINE_LOGINS`); a press while a read runs waits for that read.
 */
export class AntigravityAllowance {
  private inFlight: Promise<boolean> | undefined;

  constructor(private readonly deps: AntigravityAllowanceDeps) {}

  /**
   * Opening Subscriptions or pressing Recheck allowance: read now, once.
   * True when the read kept a new reading, so the allowance shown moves.
   */
  onPress(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    const account = this.deps
      .accounts()
      .find((candidate) => candidate.enabled && !candidate.signedOut);
    if (!account) return Promise.resolve(false);
    this.inFlight = (async () => {
      const read = await (this.deps.read ?? (() => readUsageReport({})))();
      if (read.status !== "ok") return false;
      for (const window of read.windows) this.deps.record(account.id, window);
      return true;
    })().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}

/** The vault accounts the allowance reads for. */
export function antigravityAccounts(
  list: () => { id: string; providerId: string; enabled: boolean }[],
  signedOut: (accountId: string) => boolean,
): () => { id: string; enabled: boolean; signedOut: boolean }[] {
  return () =>
    list()
      .filter((account) => account.providerId === ANTIGRAVITY_PROVIDER_ID)
      .map((account) => ({
        id: account.id,
        enabled: account.enabled,
        signedOut: signedOut(account.id),
      }));
}
