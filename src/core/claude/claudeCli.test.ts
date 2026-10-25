import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CLAUDE_CLIENT_MISSING_TEXT, claudeClientOutdatedText } from "@shared/claudeClient";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { configureSettingsPath, resetLoginPathForTests } from "../hostEnv";
import { writeLoginShellStub } from "../loginShellStub";
import {
  checkClaudeClient,
  claudeClientFloor,
  claudeClientIssueText,
  claudeEnvFor,
  compareVersions,
  parseClaudeVersion,
  pasteCodeLink,
  primeClaudeExecutable,
  resetClaudeClientCache,
  resolveClaudeExecutable,
} from "./claudeCli";

beforeEach(() => resetClaudeClientCache());

function tree(): string {
  return scratchDir("infinitary-claude-cli-");
}

/** A real, executable file at `path`, parents included. */
function client(path: string, version = "2.1.278"): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "${version} (Claude Code)"\nexit 0\n`);
  chmodSync(path, 0o755);
  return path;
}

/** No override, a HOME of our own, and no PATH: only what the test planted. */
function hermetic(home: string): NodeJS.ProcessEnv {
  return { HOME: home, PATH: "" };
}

describe("resolveClaudeExecutable", () => {
  /**
   * The packaged-build regression (captain dogfood, 2026-09-01). In a
   * packaged app the vendored client resolves to a path INSIDE app.asar,
   * and Electron's asar shim answers `existsSync` for it - so the path
   * looked fine and every `spawn` of it failed ENOTDIR, because only
   * `execFile` is asar-aware. Every Claude status read threw, which the
   * account backend could only read as "signed out". electron-builder
   * unpacks the client next to the archive; that copy is the spawnable one.
   */
  it("resolves an in-archive client to the unpacked copy that can actually be spawned", () => {
    const root = tree();
    const inArchive = join(root, "app.asar", "node_modules", "sdk-darwin-arm64", "claude");
    const unpacked = client(
      join(root, "app.asar.unpacked", "node_modules", "sdk-darwin-arm64", "claude"),
    );

    expect(resolveClaudeExecutable({ INFINITARY_CLAUDE_CLI: inArchive })).toBe(unpacked);
  });

  it("reports no client at all when the archive was never unpacked", () => {
    const root = tree();
    const inArchive = join(root, "app.asar", "node_modules", "sdk-darwin-arm64", "claude");
    // Nothing on disk. Answering with the in-archive path would hand the
    // caller a spawn that fails, which reads as a signed-out account.
    expect(resolveClaudeExecutable({ INFINITARY_CLAUDE_CLI: inArchive })).toBeUndefined();
  });
});

describe("resolveClaudeExecutable: the installed client (F14)", () => {
  /**
   * The captain's lock: the app ships no Claude client and downloads none.
   * The SDK's own copy sits in node_modules on every dev machine and CI
   * runner, which is exactly what this pin is about: with nothing
   * installed, the product resolves nothing - it never falls back to it.
   */
  it("resolves nothing when no client is installed, never the SDK's own copy", () => {
    const home = tree();
    expect(resolveClaudeExecutable(hermetic(home), { homes: [join(home, ".local", "bin")] })).toBe(
      undefined,
    );
  });

  it("finds the native installer's client at ~/.local/bin, ahead of the other homes", () => {
    const home = tree();
    const native = client(join(home, ".local", "bin", "claude"));
    const other = client(join(home, ".claude", "local", "claude"));
    const homes = [join(home, ".local", "bin"), join(home, ".claude", "local")];
    expect(resolveClaudeExecutable(hermetic(home), { homes })).toBe(native);
    expect(
      resolveClaudeExecutable(hermetic(home), { homes: [join(home, ".claude", "local")] }),
    ).toBe(other);
  });

  it("falls back to PATH when no known home has it", () => {
    const home = tree();
    const onPath = client(join(home, "somewhere", "bin", "claude"));
    const env = { HOME: home, PATH: `${join(home, "nowhere")}:${join(home, "somewhere", "bin")}` };
    expect(resolveClaudeExecutable(env, { homes: [join(home, ".local", "bin")] })).toBe(onPath);
  });

  it("lets an explicit override win, and treats a missing override as no client at all", () => {
    const home = tree();
    const installed = client(join(home, ".local", "bin", "claude"));
    const override = client(join(home, "override", "claude"));
    const homes = [join(home, ".local", "bin")];
    expect(
      resolveClaudeExecutable({ ...hermetic(home), INFINITARY_CLAUDE_CLI: override }, { homes }),
    ).toBe(override);
    // e2e names a stub this way; a path that is not there must not quietly
    // become the developer's real client.
    expect(
      resolveClaudeExecutable(
        { ...hermetic(home), INFINITARY_CLAUDE_CLI: join(home, "gone") },
        { homes },
      ),
    ).toBe(undefined);
    expect(installed).toBeTruthy();
  });

  it("ignores a directory or an unexecutable file named like the client", () => {
    const home = tree();
    mkdirSync(join(home, "dir", "claude"), { recursive: true });
    mkdirSync(join(home, "plain"), { recursive: true });
    writeFileSync(join(home, "plain", "claude"), "not a program");
    chmodSync(join(home, "plain", "claude"), 0o644);
    const homes = [join(home, "dir"), join(home, "plain")];
    expect(resolveClaudeExecutable(hermetic(home), { homes })).toBe(undefined);
  });
});

/**
 * A run whose settings file named the folders asks no login shell (docs/run.md,
 * "A settings file"; INF-1228's approved plan, piece 4: "With it, the app finds
 * programs where the file says and asks no login shell").
 */
describe("primeClaudeExecutable: the login shell, its last rung", () => {
  afterEach(() => resetLoginPathForTests());

  it("asks the login shell when nothing else finds the client, but not where a settings file named the folders", async () => {
    const home = tree();
    const homes = [join(home, ".local", "bin")];
    const stub = writeLoginShellStub(join(home, "shell"), {});
    const env = { ...hermetic(home), SHELL: stub.shell };

    configureSettingsPath(["/usr/bin", "/bin"]);
    expect(await primeClaudeExecutable(env, { homes })).toBeUndefined();
    expect(existsSync(stub.log)).toBe(false);

    resetLoginPathForTests();
    expect(await primeClaudeExecutable(env, { homes })).toBeUndefined();
    expect(readFileSync(stub.log, "utf8").trim().split("\n")).toEqual(["-lc"]);
  });
});

describe("the client version and the SDK's floor", () => {
  it("reads the version out of the client's own line", () => {
    expect(parseClaudeVersion("2.1.278 (Claude Code)")).toBe("2.1.278");
    expect(parseClaudeVersion("claude 10.0.1\n")).toBe("10.0.1");
    expect(parseClaudeVersion("no version here")).toBe(undefined);
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("2.1.278", "2.1.234")).toBe(1);
    expect(compareVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareVersions("3.0.0", "2.99.99")).toBe(1);
    expect(compareVersions("2.1.234", "2.1.234")).toBe(0);
  });

  /**
   * The floor is the client the SDK was released with, read off the SDK's
   * own manifest so a dependency bump moves it. The SDK and the client are
   * co-released (SDK 0.3.N with client 2.1.N).
   */
  it("takes the floor from the SDK's manifest, never from a hand-kept constant", () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "manifest.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(claudeClientFloor()).toBe(manifest.version);
    const sdk = JSON.parse(
      readFileSync(
        join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
        "utf8",
      ),
    ) as { version: string };
    // Co-release: the client's patch number is the SDK's.
    expect(manifest.version.split(".")[2]).toBe(sdk.version.split(".")[2]);
  });
});

describe("checkClaudeClient", () => {
  it("is missing with nothing installed, and says what to do", async () => {
    const home = tree();
    const check = await checkClaudeClient(hermetic(home), { homes: [join(home, ".local", "bin")] });
    expect(check).toEqual({ state: "missing" });
    expect(claudeClientIssueText(check)).toBe(CLAUDE_CLIENT_MISSING_TEXT);
  });

  it("is ready for a client at or above the floor, with its version", async () => {
    const home = tree();
    const executable = client(join(home, ".local", "bin", "claude"), "2.1.278");
    const homes = [join(home, ".local", "bin")];
    const check = await checkClaudeClient(hermetic(home), { homes, floor: "2.1.234" });
    expect(check).toEqual({ state: "ready", executable, version: "2.1.278" });
    expect(claudeClientIssueText(check)).toBe(undefined);
    expect(await checkClaudeClient(hermetic(home), { homes, floor: "2.1.278" })).toMatchObject({
      state: "ready",
    });
  });

  it("is outdated below the floor, naming both versions in the sentence", async () => {
    const home = tree();
    const executable = client(join(home, ".local", "bin", "claude"), "2.1.100");
    const check = await checkClaudeClient(hermetic(home), {
      homes: [join(home, ".local", "bin")],
      floor: "2.1.234",
    });
    expect(check).toEqual({ state: "outdated", executable, version: "2.1.100", floor: "2.1.234" });
    expect(claudeClientIssueText(check)).toBe(claudeClientOutdatedText("2.1.100", "2.1.234"));
    expect(claudeClientIssueText(check)).toContain("2.1.100");
    expect(claudeClientIssueText(check)).toContain("2.1.234");
  });

  it("takes a client that reports no version as ready: the floor guards known drift, it does not refuse", async () => {
    const home = tree();
    const executable = join(home, ".local", "bin", "claude");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\necho nothing useful\nexit 0\n");
    chmodSync(executable, 0o755);
    const check = await checkClaudeClient(hermetic(home), {
      homes: [join(home, ".local", "bin")],
      floor: "2.1.234",
    });
    expect(check).toEqual({ state: "ready", executable });
  });

  it("reads the version once per build of the binary", async () => {
    const home = tree();
    // The native installer's layout (`knownClaudeHomes`): a launcher symlink
    // onto one file per build under `~/.local/share/claude/versions`.
    const versions = join(home, ".local", "share", "claude", "versions");
    const executable = join(home, ".local", "bin", "claude");
    mkdirSync(join(executable, ".."), { recursive: true });
    symlinkSync(client(join(versions, "2.1.278"), "2.1.278"), executable);
    let reads = 0;
    const read = async () => {
      reads += 1;
      return "2.1.278";
    };
    const options = { homes: [join(home, ".local", "bin")], floor: "2.1.234", read };
    await checkClaudeClient(hermetic(home), options);
    await checkClaudeClient(hermetic(home), options);
    expect(reads).toBe(1);
    // The client's own updater installs the new build beside the old one and
    // repoints the launcher; the next check reads again. Rewriting the old
    // file in place is not what it does, and at the same size Linux's coarse
    // file clock can leave that file's identity unchanged (INF-482).
    unlinkSync(executable);
    symlinkSync(client(join(versions, "2.1.300"), "2.1.300"), executable);
    await checkClaudeClient(hermetic(home), options);
    expect(reads).toBe(2);
  });
});

describe("claudeEnvFor", () => {
  it("leaves CLAUDE_CONFIG_DIR unset so the client uses the machine login, and strips ambient credentials", () => {
    const env = claudeEnvFor({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "ambient",
      ANTHROPIC_AUTH_TOKEN: "ambient",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient",
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "ambient",
      ANTHROPIC_BASE_URL: "https://elsewhere",
      CLAUDE_CONFIG_DIR: "/some/other/account",
    });

    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "ANTHROPIC_BASE_URL",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });
});

describe("pasteCodeLink", () => {
  const LOOPBACK =
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A62844%2Fcallback&state=s";
  const CODE_PAGE =
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s";

  it("takes the link whose page shows a code, never the one back to this Mac's loopback", () => {
    // What Claude Code 2.1.288 prints with no terminal (FI3-688's measurement).
    expect(
      pasteCodeLink(
        `Opening browser to sign in…\nIf the browser didn't open, visit: ${CODE_PAGE}\nPaste code here if prompted > `,
      ),
    ).toBe(CODE_PAGE);
    expect(pasteCodeLink(`${LOOPBACK}\n${CODE_PAGE}\n`)).toBe(CODE_PAGE);
    expect(pasteCodeLink(`${LOOPBACK}\n`)).toBeUndefined();
  });

  it("waits until the link is printed whole", () => {
    expect(pasteCodeLink(`visit: ${CODE_PAGE.slice(0, 60)}`)).toBeUndefined();
    expect(pasteCodeLink(`visit: ${CODE_PAGE}`)).toBeUndefined();
    expect(pasteCodeLink(`visit: ${CODE_PAGE}\n`)).toBe(CODE_PAGE);
  });
});
