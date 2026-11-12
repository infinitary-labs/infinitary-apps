import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  ANTIGRAVITY_CHIP_INSTALL_NOTE,
  ANTIGRAVITY_MISSING_TEXT,
  ANTIGRAVITY_PROVIDER_ID,
} from "@shared/antigravity";
import { CLIENT_MISSING } from "@shared/claudeClient";
import {
  type AccountBackend,
  type AccountBinding,
  type AccountLoginRequest,
  type AccountRef,
  type AccountStatus,
  type LogoutOutcome,
  statusFromHealth,
} from "../accounts/accountBackend";
import type { CredentialHealth, RenewalOutcome } from "../accounts/credentialHealth";
import { hostEnv } from "../hostEnv";
import { resolveAgyExecutable } from "./agyExecutable";

/**
 * The account backend for a Google AI plan run through the Antigravity
 * program the person installed (INF-3776, the captain's approved plan;
 * docs/antigravity-client.md). The program holds the person's Google
 * sign-in and is the only thing that reads it: signing in runs the
 * program's own `agy acp --login`, and Infinitary never reads, copies or
 * refreshes what it saves, never calls Google itself and never switches the
 * program's sign-in.
 *
 * The program keeps one sign-in for the whole user, so the vault keeps one
 * account for it (`MACHINE_LOGINS`). Nothing here asks Google whether that
 * sign-in still holds: a session that meets the protocol's sign-in error
 * records the typed `signed_out` cut-off, which withholds the account until
 * the row's Sign in runs the program's login again (docs/quota.md, "Typed
 * cut-offs").
 */

/** How long the program's own sign-in may take, a browser page included. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export const ANTIGRAVITY_LOGIN_WORDS = {
  opening: "Opening Google in your browser to sign in to Antigravity...",
  finish: "Finish signing in with your browser, then come back here.",
  code: "Paste the code the page shows once you have signed in.",
  unfinished: "The Antigravity sign-in did not finish. Try again.",
  timedOut: "The Antigravity sign-in took too long. Try again.",
  keyRefused: "A Google AI plan signs in through Antigravity, not with a key.",
} as const;

/** How the backend starts the program's sign-in; a stand-in replaces it in tests. */
export type AgyLoginLaunch = (
  env: NodeJS.ProcessEnv,
) => { command: string; args: string[] } | undefined;

export const defaultAgyLoginLaunch: AgyLoginLaunch = (env) => {
  const command = resolveAgyExecutable(env);
  return command ? { command, args: ["acp", "--login"] } : undefined;
};

export type AntigravityAuthBackendOptions = {
  /** Where the program is and how its sign-in starts; the installed `agy` by default. */
  launch?: AgyLoginLaunch;
  /** The environment the program runs in; the host's by default. */
  env?: () => NodeJS.ProcessEnv;
  loginTimeoutMs?: number;
};

export class AntigravityAuthBackend implements AccountBackend {
  readonly id = "antigravity" as const;
  private readonly launch: AgyLoginLaunch;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly loginTimeoutMs: number;

  constructor(options: AntigravityAuthBackendOptions = {}) {
    this.launch = options.launch ?? defaultAgyLoginLaunch;
    this.env = options.env ?? (() => hostEnv());
    this.loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  private installed(): boolean {
    return this.launch(this.env()) !== undefined;
  }

  /** A Google AI plan signs in through the program; there is no key to paste here. */
  authTypes(providerId: string): ("oauth" | "api_key")[] {
    return providerId === ANTIGRAVITY_PROVIDER_ID && this.installed() ? ["oauth"] : [];
  }

  /** No program on this computer: the chip stays, disabled, and says so. */
  unavailable(): { note: string; detail: string } | undefined {
    return this.installed()
      ? undefined
      : { note: ANTIGRAVITY_CHIP_INSTALL_NOTE, detail: ANTIGRAVITY_MISSING_TEXT };
  }

  /**
   * Runs the program's own sign-in (`agy acp --login`). The program opens
   * no browser: it prints Google's sign-in link and waits on its stdin for
   * the code Google's page shows after the person signs in. So the link
   * opens in the browser and goes to the sign-in's aside, and the code
   * comes back as the answer to one prompt, written to the program's stdin.
   * The program's exit says whether it signed in; stopping the sign-in
   * stops the program.
   */
  async login(request: AccountLoginRequest): Promise<void> {
    if (request.type !== "oauth") throw new Error(ANTIGRAVITY_LOGIN_WORDS.keyRefused);
    const env = this.env();
    const launch = this.launch(env);
    if (!launch) throw new Error(ANTIGRAVITY_MISSING_TEXT);
    const { bridge } = request;
    const where = { providerId: request.providerId, accountId: request.accountId };
    bridge.notify({ ...where, kind: "progress", message: ANTIGRAVITY_LOGIN_WORDS.opening });
    const child = spawn(launch.command, launch.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let asked = false;
    let timedOut = false;
    let cancelled = false;
    const stop = () => stopChild(child);
    bridge.signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, this.loginTimeoutMs);
    timer.unref?.();
    // The program may exit while the code is being written; its exit says how it went.
    child.stdin?.on("error", () => {});
    const read = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (asked) return;
      const link = signInLink(output);
      if (!link) return;
      asked = true;
      bridge.openExternal(link).catch(() => {});
      bridge.notify({
        ...where,
        kind: "auth_url",
        message: ANTIGRAVITY_LOGIN_WORDS.finish,
        url: link,
      });
      bridge
        .prompt({
          promptId: randomUUID(),
          ...where,
          kind: "manual_code",
          message: ANTIGRAVITY_LOGIN_WORDS.code,
          placeholder: "paste the code",
        })
        .then(
          (code) => {
            if (code.trim() && child.stdin?.writable) child.stdin.write(`${code.trim()}\n`);
          },
          () => {
            // The person left the code prompt: the sign-in ends here, not at the timeout.
            cancelled = true;
            stop();
          },
        );
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }).finally(() => {
      clearTimeout(timer);
      bridge.signal?.removeEventListener("abort", stop);
    });
    if (code === 0) return;
    if (bridge.signal?.aborted || cancelled) throw new Error("The sign-in was stopped.");
    if (timedOut) throw new Error(ANTIGRAVITY_LOGIN_WORDS.timedOut);
    throw new Error(ANTIGRAVITY_LOGIN_WORDS.unfinished);
  }

  /**
   * Unbinds only. The program's sign-in is the person's own Antigravity's,
   * which their terminal and Google's own apps use too, so removing the
   * account never signs the program out.
   */
  async logout(_account: AccountRef): Promise<LogoutOutcome> {
    return { login: "kept" };
  }

  /**
   * The program on this computer is the one fact read here: nothing asks
   * Google, and a sign-out is learned only from a session's typed refusal.
   * No program is a fact beside the sign-in, never a sign-out.
   */
  async health(_account: AccountRef): Promise<CredentialHealth> {
    if (!this.installed()) {
      return { state: "degraded", reason: CLIENT_MISSING, detail: ANTIGRAVITY_MISSING_TEXT };
    }
    return { state: "healthy", authType: "oauth" };
  }

  /** The program renews its own sign-in; the app has nothing to renew. */
  async renew(): Promise<RenewalOutcome> {
    return { outcome: "unsupported" };
  }

  async status(account: AccountRef): Promise<AccountStatus> {
    return statusFromHealth(await this.health(account));
  }

  binding(_account: AccountRef): AccountBinding {
    return { via: "antigravity-login" };
  }
}

/**
 * The first web link the program printed whole (followed by a space or a
 * line end, so a link split across two reads is never opened cut short)
 * that is not its own page on this computer.
 */
export function signInLink(output: string): string | undefined {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+(?=\s)/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") continue;
      return match[0];
    } catch {
      // Not a link; keep looking.
    }
  }
  return undefined;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}
