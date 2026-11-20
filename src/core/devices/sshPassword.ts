import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteLoginRefusal } from "@shared/remoteLogin";
import { cutTextEnd } from "@shared/textCut";
import { FAR_SYSTEMS } from "./farSystems";
import { SSH_FAILED, SSH_OPTIONS, type SshProgram, sshArguments, sshEnv } from "./ssh";
import { sshRefusal } from "./sshRefusal";

/**
 * Letting Firstmate's own key in on a Mac that did not let the captain's in,
 * with that user's password, typed once (docs/devices.md, "The password,
 * once"). The password goes only to the Mac whose check line the captain
 * confirmed: the run checks the remembered key alone, and SSH checks it
 * before it signs in, so a Mac that answers unlike it never sees the
 * password. The password is never in an argument, the environment or a file:
 * SSH asks for it through a small program of Firstmate's (`SSH_ASKPASS`),
 * which says so on SSH's own notes with a word only this run knows, then
 * reads it from SSH's input, which it shares, and hands it straight to SSH.
 * Firstmate writes it there once, only when that program asks, and only
 * before SSH has signed in, then ends that input. The remote command is a
 * fixed script that adds the public half to that user's `authorized_keys`.
 */

/** How a Mac lets a user sign in with a password, as SSH names it. */
export type PasswordMethod = "password" | "keyboard-interactive";

/**
 * The password methods that Mac offered after it refused the key, read from
 * SSH's own `-v` note; `[]` when it offers none, null when SSH said nothing.
 */
export function passwordMethods(stderr: string): PasswordMethod[] | null {
  const said = [...stderr.matchAll(/Authentications that can continue: (\S+)/g)].at(-1)?.[1];
  if (said === undefined) return null;
  const offered = said.split(",");
  return (["password", "keyboard-interactive"] as const).filter((method) =>
    offered.includes(method),
  );
}

/**
 * The options of the one run that types the password: `SSH_OPTIONS` asking
 * nothing but the password, once, with one method, its own connection (no
 * shared one, no proxy) and no key or agent offered.
 */
export function passwordSshOptions(methods: readonly PasswordMethod[] | null): string[] {
  const preferred = methods?.includes("password")
    ? "password"
    : methods?.length
      ? methods[0]
      : "password,keyboard-interactive";
  return [
    ...SSH_OPTIONS.map((option) => (option === "BatchMode=yes" ? "BatchMode=no" : option)),
    "-o",
    "ControlPath=none",
    "-o",
    "ProxyCommand=none",
    "-o",
    "ProxyJump=none",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "GSSAPIAuthentication=no",
    "-o",
    "HostbasedAuthentication=no",
    "-o",
    "IdentityAgent=none",
    "-o",
    `PreferredAuthentications=${preferred}`,
    "-o",
    "PasswordAuthentication=yes",
    "-o",
    "KbdInteractiveAuthentication=yes",
    "-o",
    "NumberOfPasswordPrompts=1",
  ];
}

/**
 * Adds `$1`, Firstmate's public key line, to that user's `authorized_keys`
 * once, making the folder and the file only that user may change. A system
 * Firstmate is set up on over SSH only (`FAR_SYSTEMS`): anything else is said
 * and nothing is written.
 */
const PLACE = [
  `case "$(uname -s 2>/dev/null)" in ${FAR_SYSTEMS.map((far) => far.uname).join("|")}) ;; *) printf 'infinitary:other-system\\n'; exit 0 ;; esac`,
  "umask 077",
  'S="$HOME/.ssh"',
  'F="$S/authorized_keys"',
  'mkdir -p "$S" || exit 3',
  'chmod go-w "$S" 2>/dev/null',
  'touch "$F" || exit 3',
  'chmod go-w "$F" 2>/dev/null',
  'if ! grep -qxF -- "$1" "$F"; then',
  '  if [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ]; then printf \'\\n\' >> "$F" || exit 3; fi',
  '  printf \'%s\\n\' "$1" >> "$F" || exit 3',
  "fi",
  "printf 'infinitary:placed\\n'",
].join("\n");

/** SSH's own note that it signed in; nothing is typed after it. */
const SIGNED_IN = /^Authenticated to /;

const PLACE_TIMEOUT_MS = 90_000;

export type PlaceKeyOutcome =
  | "placed"
  /** That Mac did not take the password. */
  | "wrong"
  /** That Mac never asked for one: it lets no one in with a password. */
  | "off"
  /** A system Firstmate is not set up on over SSH. */
  | "other-system"
  | { refusal: RemoteLoginRefusal };

export type PlaceKeyOptions = {
  ssh: SshProgram;
  address: string;
  /** The remembered check (`hostTrustSshOptions`): a password goes only to that Mac. */
  trusted: readonly string[];
  methods: readonly PasswordMethod[] | null;
  /** Firstmate's public key line. */
  publicLine: string;
  /** Zeroed once written, or once the run ends without asking. */
  password: Buffer;
  timeoutMs?: number;
};

/** Places Firstmate's own key there with the password, typed at most once. */
export async function placeOwnKey(options: PlaceKeyOptions): Promise<PlaceKeyOutcome> {
  const { password } = options;
  if (options.trusted.length === 0) {
    password.fill(0);
    return { refusal: "host-unknown" };
  }
  const nonce = randomBytes(16).toString("hex");
  const folder = mkdtempSync(join(tmpdir(), "infinitary-p-"));
  try {
    chmodSync(folder, 0o700);
    const askpass = join(folder, "askpass");
    // The shell's own read and printf: the password is never a process's argument.
    writeFileSync(
      askpass,
      [
        "#!/bin/sh",
        `printf 'infinitary:askpass=%s\\n' '${nonce}' >&2`,
        "IFS= read -r P || exit 1",
        "printf '%s\\n' \"$P\"",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    chmodSync(askpass, 0o700);
    const args = sshArguments(
      options.ssh,
      options.address,
      ["/bin/sh", "-c", PLACE, "firstmate", options.publicLine],
      [...passwordSshOptions(options.methods), ...options.trusted],
    );
    const env = { ...sshEnv(), SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" };
    const ran = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      typed: boolean;
    }>((resolve) => {
      const child = spawn(options.ssh.program, args, { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let held = "";
      let typed = false;
      let signedIn = false;
      const input = child.stdin;
      input?.on("error", () => {});
      const letGo = () => {
        password.fill(0);
        if (input && !input.writableEnded) input.end();
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = keepEnd(stdout + chunk.toString("utf8"));
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = keepEnd(stderr + text);
        held += text;
        for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
          const line = held.slice(0, at).trim();
          held = held.slice(at + 1);
          if (SIGNED_IN.test(line)) {
            signedIn = true;
            if (!typed) letGo();
          } else if (line === `infinitary:askpass=${nonce}` && !typed && !signedIn && input) {
            typed = true;
            const once = Buffer.concat([password, Buffer.from("\n")]);
            password.fill(0);
            input.end(once, () => once.fill(0));
          }
        }
        if (held.length > KEEP_BYTES) held = "";
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? PLACE_TIMEOUT_MS);
      timer.unref?.();
      let settled = false;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        letGo();
        resolve({ code, stdout, stderr, typed });
      };
      child.once("error", (error) => {
        stderr += `\n${error.message}`;
        finish(SSH_FAILED);
      });
      child.once("close", (code) => finish(code));
    });
    if (/^infinitary:other-system$/m.test(ran.stdout)) return "other-system";
    if (ran.code === 0 && /^infinitary:placed$/m.test(ran.stdout)) return "placed";
    if (ran.code === SSH_FAILED) {
      if (/Permission denied|Too many authentication failures/.test(ran.stderr))
        return ran.typed ? "wrong" : "off";
      return { refusal: sshRefusal(ran.stderr) };
    }
    return { refusal: "failed" };
  } finally {
    password.fill(0);
    rmSync(folder, { recursive: true, force: true });
  }
}

const KEEP_BYTES = 64 * 1024;

function keepEnd(text: string): string {
  return cutTextEnd(text, KEEP_BYTES);
}
