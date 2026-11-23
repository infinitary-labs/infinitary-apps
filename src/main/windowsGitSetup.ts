import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  findWindowsGit,
  GIT_FOR_WINDOWS,
  type InstallerSignature,
  isOfferedVersion,
  refuseDownloadedGit,
  type WindowsGit,
} from "@core/windowsGit";

/**
 * Git for Windows on an installed Windows app's first launch
 * (docs/windows.md, "Git for Windows"). Before the window opens the app
 * looks for a suitable Git (`@core/windowsGit`); with none it asks, in a
 * system dialog, to install Git for Windows for this person alone, or to
 * quit. On yes it downloads the pinned release from Git for Windows' own
 * releases, checks its SHA-256 and its publisher's signature before
 * anything runs, installs it with no administrator rights and no question
 * (Git's own window shows the progress), and checks the version the new
 * git answers. Nothing else changes: the person's search path and Git
 * settings stay as they were, and removing Infinitary leaves Git installed.
 */

export const GIT_SETUP_WORDS = {
  ask: {
    message: "Infinitary needs Git for Windows.",
    detail: `Infinitary keeps each task's work apart with Git, and the crew runs its commands in Git Bash. This PC has neither. Infinitary can download Git for Windows ${GIT_FOR_WINDOWS.version} from its makers, check it, and install it for you alone. It needs no administrator rights.`,
    buttons: ["Install Git for Windows", "Quit"],
  },
  downloading: {
    message: "Downloading Git for Windows…",
    detail: `About ${Math.round(GIT_FOR_WINDOWS.bytes / 1_000_000)} MB from Git for Windows' releases. Its installer opens next and shows its own progress.`,
    buttons: ["Cancel"],
  },
  failed: {
    message: "Infinitary could not install Git for Windows.",
    buttons: ["Try again", "Quit"],
  },
} as const;

/** What the setup reaches; the real one is this PC, a test plants its own. */
export type GitSetupDeps = {
  readonly env: NodeJS.ProcessEnv;
  readonly find: () => Promise<WindowsGit | undefined>;
  /** Asks in a system dialog; the button's index, or the cancel one when it closes. */
  readonly ask: (words: {
    message: string;
    detail: string;
    buttons: readonly string[];
    signal?: AbortSignal;
  }) => Promise<number>;
  readonly tempDir: string;
  readonly download: (url: string, to: string, signal: AbortSignal) => Promise<string>;
  readonly signature: (file: string) => Promise<InstallerSignature | undefined>;
  readonly install: (file: string) => Promise<number>;
};

export type GitSetupResult = { readonly git: WindowsGit } | { readonly quit: true };

/**
 * The Git this start uses: a suitable one already on the PC, or the one
 * the person chose to install. `quit` when they chose to quit.
 */
export async function ensureWindowsGit(deps: GitSetupDeps): Promise<GitSetupResult> {
  const found = await deps.find();
  if (found) return { git: found };
  const { ask } = GIT_SETUP_WORDS;
  if ((await deps.ask(ask)) !== 0) return { quit: true };
  for (;;) {
    const outcome = await installOnce(deps);
    if ("git" in outcome || "quit" in outcome) return outcome;
    const again = await deps.ask({
      message: GIT_SETUP_WORDS.failed.message,
      detail: outcome.failed,
      buttons: GIT_SETUP_WORDS.failed.buttons,
    });
    if (again !== 0) return { quit: true };
  }
}

async function installOnce(
  deps: GitSetupDeps,
): Promise<GitSetupResult | { readonly failed: string }> {
  const folder = await mkdtemp(join(deps.tempDir, "infinitary-git-"));
  try {
    const file = join(folder, GIT_FOR_WINDOWS.file);
    const stop = new AbortController();
    const finished = new AbortController();
    const shown = deps.ask({ ...GIT_SETUP_WORDS.downloading, signal: finished.signal });
    // Cancel closes the dialog before the download ends: the person stopped it.
    void shown.then(() => {
      if (!finished.signal.aborted) stop.abort();
    });
    let sha256: string;
    try {
      sha256 = await deps.download(GIT_FOR_WINDOWS.url, file, stop.signal);
    } catch (error) {
      if (stop.signal.aborted) return { quit: true };
      return { failed: `The download stopped: ${String(error)}. Check this PC's connection.` };
    } finally {
      finished.abort();
    }
    const refused = refuseDownloadedGit(sha256, await deps.signature(file));
    if (refused) return { failed: `${refused} Nothing was installed.` };
    const code = await deps.install(file);
    if (code !== 0) return { failed: `Git for Windows' installer ended with code ${code}.` };
    const git = await deps.find();
    if (!git) return { failed: "Git for Windows installed, but Infinitary cannot find it." };
    if (!isOfferedVersion(git.version))
      return { failed: `The installed Git answered "${git.version}".` };
    return { git };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function downloadFile(url: string, to: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`the server answered ${response.status}`);
  const hash = createHash("sha256");
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  body.on("data", (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(to), { signal });
  return hash.digest("hex");
}

function systemRoot(env: NodeJS.ProcessEnv): string {
  return env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
}

export function readSignature(
  env: NodeJS.ProcessEnv,
): (file: string) => Promise<InstallerSignature | undefined> {
  return (file) =>
    new Promise((resolve) => {
      const powershell = join(
        systemRoot(env),
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      // The path rides the environment, never the command's text.
      const child = spawn(
        powershell,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$s = Get-AuthenticodeSignature -LiteralPath $env:INFINITARY_GIT_SETUP; " +
            "@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress",
        ],
        { env: { ...env, INFINITARY_GIT_SETUP: file }, windowsHide: true },
      );
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("error", () => resolve(undefined));
      child.on("close", () => {
        try {
          const read = JSON.parse(out) as { status?: string; subject?: string };
          resolve({ status: read.status ?? "", subject: read.subject ?? "" });
        } catch {
          resolve(undefined);
        }
      });
    });
}

/**
 * Runs Git for Windows' installer for this person alone, with its defaults:
 * no question, no restart, and its own progress window.
 */
export function runGitInstaller(env: NodeJS.ProcessEnv): (file: string) => Promise<number> {
  return (file) =>
    new Promise((resolve) => {
      const child = spawn(
        file,
        ["/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/NOCANCEL", "/SP-", "/CURRENTUSER"],
        { env, windowsHide: false },
      );
      child.on("error", () => resolve(-1));
      child.on("close", (code) => resolve(code ?? -1));
    });
}

export function windowsGitDeps(
  env: NodeJS.ProcessEnv,
  tempDir: string,
  ask: GitSetupDeps["ask"],
): GitSetupDeps {
  return {
    env,
    find: () => findWindowsGit(env),
    ask,
    tempDir,
    download: downloadFile,
    signature: readSignature(env),
    install: runGitInstaller(env),
  };
}
